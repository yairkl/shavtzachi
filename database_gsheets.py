import os
import json
import logging
import pandas as pd
from typing import List, Optional
from datetime import datetime, timedelta, time
from collections import defaultdict
import time as ptime
import random
import threading
import httpx

logger = logging.getLogger(__name__)
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.exceptions import TransportError
import socket
import ssl

from models import Soldier, Skill, Post, PostTemplateSlot, Shift, Assignment, Unavailability
from schedule_gsheets import build_schedule_requests, parse_grid
from database import load_config, CONFIG_FILE, TOKEN_FILE

import sys

SCOPES = ['https://www.googleapis.com/auth/spreadsheets']



class ShavtzachiDB:
    def __init__(self, session=None, input_sheet_id=None, output_sheet_id=None):
        self.session = self
        self.creds = None
        self.config = load_config()
        self.spreadsheet_id = self.config.get("SPREADSHEET_ID")
        self.input_sheet_id = input_sheet_id or self.spreadsheet_id or self.config.get("INPUT_SPREADSHEET_ID")
        self.output_sheet_id = output_sheet_id or self.config.get("OUTPUT_SPREADSHEET_ID") or self.input_sheet_id
        self.time_granularity_hours = int(self.config.get("TIME_GRANULARITY_HOURS", 4))
        
        self.assignments_cache = {} # (key: (post_name, start_iso)) -> Assignment
        self.all_assignments_cache = None # List[Assignment] when prefetched
        self.assignments_cache_time = 0
        
        self.history_scores_cache = None
        self.history_scores_cache_time = 0
        
        self.sheet_metadata_cache = {} # spreadsheetId -> {merges, sheets}
        self.soldiers_df = None
        self.posts_df = None
        self.unavailabilities_df = None
        self.skills_df = None
        
        self._pending_adds = []
        self._known_shifts = {} # Track transient shifts by ID for assignments
        self.fetch_lock = threading.Lock()
        self.last_reload_time = 0
        
        self.client = httpx.Client(timeout=120.0)
        self.authenticate()
        if self.input_sheet_id:
            try:
                self.reload_cache()
            except Exception as e:
                logger.warning(f"Initial cache reload failed (expected if unauthenticated): {e}")

    def _get_auth_headers(self):
        if not self.creds or not self.creds.valid:
            if self.creds and self.creds.expired and self.creds.refresh_token:
                try:
                    self.creds.refresh(GoogleRequest())
                except Exception as e:
                    logger.error(f"Failed to refresh credentials: {e}")
                    self.authenticate()
            else:
                self.authenticate()
        
        if not self.creds:
            raise ValueError("Not authenticated with Google. Please sign in.")
            
        headers = {}
        self.creds.apply(headers)
        return headers

    def _request(self, method, url, **kwargs):
        retries = 6
        delay = 2.0
        for i in range(retries):
            try:
                headers = self._get_auth_headers()
                if 'headers' in kwargs:
                    headers.update(kwargs['headers'])
                kwargs['headers'] = headers
                
                resp = self.client.request(method, url, **kwargs)
                
                if resp.status_code == 429 or (500 <= resp.status_code < 600):
                    print(f"Retriable status error ({resp.status_code}). Retrying in {delay:.2f} seconds (attempt {i+1}/{retries})...")
                    ptime.sleep(delay)
                    delay *= 2
                    delay += random.uniform(0, 1.0)
                    continue
                
                # For all other errors (including 403), raise immediately and don't retry
                resp.raise_for_status()
                return resp.json()
            except httpx.HTTPStatusError as err:
                # Try to extract more detail from the response body
                try:
                    detail = err.response.json()
                    error_msg = detail.get("error", {}).get("message", str(err))
                    print(f"Google Sheets API Error ({err.response.status_code}): {error_msg}")
                    # Raise a new exception with the better message
                    raise Exception(f"Google Sheets API Error: {error_msg}") from err
                except:
                    raise err
            except (httpx.HTTPError, socket.timeout, TimeoutError, ssl.SSLError, socket.gaierror) as err:
                 print(f"Network error ({type(err).__name__}). Retrying in {delay:.2f} seconds (attempt {i+1}/{retries})...")
                 ptime.sleep(delay)
                 delay *= 2
                 delay += random.uniform(0, 1.0)
                 continue
        
        # Last attempt outside try block
        headers = self._get_auth_headers()
        if 'headers' in kwargs:
            headers.update(kwargs['headers'])
        kwargs['headers'] = headers
        resp = self.client.request(method, url, **kwargs)
        resp.raise_for_status()
        return resp.json()

    def _gsheets_get_values(self, spreadsheet_id, range_name):
        url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range_name}"
        return self._request("GET", url)

    def _gsheets_batch_get_values(self, spreadsheet_id, ranges):
        params = [('ranges', r) for r in ranges]
        url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values:batchGet"
        return self._request("GET", url, params=params)

    def _gsheets_append_values(self, spreadsheet_id, range_name, values, input_option='RAW'):
        url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range_name}:append"
        params = {'valueInputOption': input_option, 'insertDataOption': 'INSERT_ROWS'}
        body = {'values': values}
        return self._request("POST", url, params=params, json=body)

    def _gsheets_update_values(self, spreadsheet_id, range_name, values, input_option='RAW'):
        url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range_name}"
        params = {'valueInputOption': input_option}
        body = {'values': values}
        return self._request("PUT", url, params=params, json=body)

    def _gsheets_clear_values(self, spreadsheet_id, range_name):
        url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range_name}:clear"
        return self._request("POST", url)

    def _gsheets_batch_update(self, spreadsheet_id, requests):
        url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate"
        body = {'requests': requests}
        return self._request("POST", url, json=body)

    def _gsheets_get_metadata(self, spreadsheet_id, fields=None):
        url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}"
        params = {}
        if fields:
            params['fields'] = fields
        return self._request("GET", url, params=params)

    def add(self, instance):
        if instance not in self._pending_adds:
            self._pending_adds.append(instance)
            if isinstance(instance, Shift):
                # Assign a temporary ID if it doesn't have one
                if not getattr(instance, 'id', None):
                    instance.id = len(self._known_shifts) + 10000
                self._known_shifts[instance.id] = instance

    def add_all(self, instances):
        for instance in instances:
            self.add(instance)

    def commit(self):
        if not self._pending_adds:
            return
            
        assignments_to_save = []
        others = []
        
        # Sort pending to handle dependencies (Skill -> Soldier -> Unavailability)
        # and Skill -> Post -> Assignment
        for inst in self._pending_adds:
            if isinstance(inst, Assignment):
                assignments_to_save.append(inst)
            else:
                others.append(inst)
                
        # Handle non-assignments in dependency order
        
        # Local maps to avoid reloads
        session_skills = {s.name: s for s in self.get_all_skills()}
        session_soldiers = {s.name: s for s in self.get_all_soldiers()}
        session_posts = {p.name: p for p in self.get_all_posts()}
        
        # 1. Skills
        for inst in others:
            if isinstance(inst, Skill):
                if inst.name not in session_skills:
                    self._append_row("Skills", [inst.name], reload=False)
                    # We don't have the ID yet, but we can set it to a dummy or reload later
                    # For GSheets, Skill ID is just index+1. 
                
        # Reload once after skills if any were added
        if any(isinstance(inst, Skill) for inst in others):
            self.reload_cache(force=True)
            session_skills = {s.name: s for s in self.get_all_skills()}

        # 2. Soldiers
        soldiers_added = False
        for inst in others:
            if isinstance(inst, Soldier):
                skill_names = [sk.name for sk in inst.skills]
                ex_post_names = [p.name for p in inst.excluded_posts]
                if inst.name not in session_soldiers:
                    self.create_soldier(inst.name, skill_names, inst.division, ex_post_names, reload=False)
                    soldiers_added = True
        
        if soldiers_added:
            self.reload_cache(force=True)
            session_soldiers = {s.name: s for s in self.get_all_soldiers()}
        
        # Update soldier IDs
        for inst in others:
            if isinstance(inst, Soldier):
                if inst.name in session_soldiers:
                    inst.id = session_soldiers[inst.name].id

        # 3. Posts
        posts_added = False
        for inst in others:
            if isinstance(inst, Post):
                if inst.name not in session_posts:
                    slot_skills = [slot.skill.name for slot in inst.slots]
                    self.create_post(
                        inst.name, 
                        inst.shift_length.total_seconds() / 3600,
                        inst.start_time, inst.end_time,
                        inst.cooldown.total_seconds() / 3600,
                        inst.intensity_weight,
                        slot_skills,
                        inst.is_active == 1,
                        inst.active_from,
                        inst.active_until,
                        reload=False
                    )
                    posts_added = True
        
        if posts_added:
            self.reload_cache(force=True)
            session_posts = {p.name: p for p in self.get_all_posts()}

        # 4. Slots (Update posts)
        slots_added = False
        for inst in others:
            if isinstance(inst, PostTemplateSlot):
                if inst.post and inst.post.name in session_posts:
                    post = session_posts[inst.post.name]
                    slot_skills = [slot.skill.name for slot in inst.post.slots]
                    self.update_post(
                        post.name,
                        post.shift_length.total_seconds() / 3600,
                        post.start_time, post.end_time,
                        post.cooldown.total_seconds() / 3600,
                        post.intensity_weight,
                        slot_skills,
                        post.is_active == 1,
                        post.active_from,
                        post.active_until,
                        reload=False
                    )
                    slots_added = True
        
        if slots_added:
            self.reload_cache(force=True)

        # 5. Unavailabilities
        for inst in others:
            if isinstance(inst, Unavailability):
                if not inst.soldier_id and inst.soldier:
                    inst.soldier_id = inst.soldier.id
                u = self.create_unavailability(inst.soldier_id, inst.start_datetime, inst.end_datetime, inst.reason, reload=False)
                if u: inst.id = u.id
        
        self.reload_cache(force=True)

        if assignments_to_save:
            # Convert to dicts for save_assignments_to_grid
            data = []
            for a in assignments_to_save:
                # Resolve shift if needed
                shift = a.shift
                if not shift and a.shift_id in self._known_shifts:
                    shift = self._known_shifts[a.shift_id]
                
                if not shift:
                    print(f"WARNING: Assignment {a.id} has no shift details and shift_id {a.shift_id} not found in session.")
                    continue

                data.append({
                    'soldier_name': a.soldier.name if a.soldier else "Unknown",
                    'division_id': a.soldier.division if a.soldier else None,
                    'post_name': shift.post_name,
                    'start': shift.start,
                    'end': shift.end,
                    'role_id': a.role_id
                })
            
            # Determine range
            start_date = min(a['start'] for a in data)
            end_date = max(a['end'] for a in data)
            
            # Add a small buffer to ensure we cover the range
            start_date -= timedelta(seconds=1)
            end_date += timedelta(seconds=1)
            
            self.save_assignments_to_grid(data, start_date, end_date)

        self._pending_adds = []
        self.all_assignments_cache = None
        self.history_scores_cache = None
        self.reload_cache(force=True)

    def rollback(self):
        self._pending_adds = []

    def flush(self):
        pass

    def refresh(self, instance):
        self.reload_cache(force=True)

    def authenticate(self):
        if os.path.exists(TOKEN_FILE):
            try:
                self.creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
                if self.creds and self.creds.expired and self.creds.refresh_token:
                    self.creds.refresh(GoogleRequest())
                    with open(TOKEN_FILE, 'w') as token:
                        token.write(self.creds.to_json())
            except Exception as e:
                logger.error(f"Error during token load/refresh: {e}")
                self.creds = None
        else:
            self.creds = None

    def reload_cache(self, force=False):
        if not self.input_sheet_id: return
        
        # Determine if we should bypass TTL because the cache is currently "empty" 
        # (usually after a failed initial load or permission error)
        is_empty = self.soldiers_df is None or len(self.soldiers_df) == 0
        
        # Check TTL
        if not force and not is_empty and (ptime.time() - self.last_reload_time) < 30:
            return
            
        with self.fetch_lock:
            # Double check
            if not force and self.soldiers_df is not None and (ptime.time() - self.last_reload_time) < 30:
                return
                
            try:
                res = self._gsheets_batch_get_values(
                    self.input_sheet_id, 
                    ['Soldiers!A:E', 'Posts!A:K', 'Unavailabilities!A:E', 'Skills!A:B']
                )
                
                value_ranges = res.get('valueRanges', [])
                
                def make_df(vr):
                    vals = vr.get('values', [])
                    if not vals: return pd.DataFrame()
                    header = vals[0]
                    data = vals[1:]
                    padded_data = []
                    for row in data:
                        if len(row) < len(header):
                            padded_data.append(row + [''] * (len(header) - len(row)))
                        else:
                            padded_data.append(row[:len(header)])
                    return pd.DataFrame(padded_data, columns=header)
                
                self.soldiers_df = make_df(value_ranges[0])
                self.posts_df = make_df(value_ranges[1])
                self.unavailabilities_df = make_df(value_ranges[2])
                self.skills_df = make_df(value_ranges[3])      
                self.last_reload_time = ptime.time()      
            except Exception as err:
                print(f"Error fetching sheets: {err}")
                # Ensure they are not None to avoid crashes in other methods
                if self.soldiers_df is None: self.soldiers_df = pd.DataFrame()
                if self.posts_df is None: self.posts_df = pd.DataFrame()
                if self.unavailabilities_df is None: self.unavailabilities_df = pd.DataFrame()
                if self.skills_df is None: self.skills_df = pd.DataFrame()

    def _append_row(self, sheet_name, values, reload=True):
        self._gsheets_append_values(self.input_sheet_id, f'{sheet_name}!A:Z', [values])
        if reload:
            self.reload_cache(force=True)

    def _update_row(self, sheet_name, row_idx, values, reload=True):
        self._gsheets_update_values(self.input_sheet_id, f'{sheet_name}!A{row_idx}:Z{row_idx}', [values])
        if reload:
            self.reload_cache(force=True)

    def _delete_row(self, sheet_name, row_idx, reload=True):
        self._gsheets_clear_values(self.input_sheet_id, f'{sheet_name}!A{row_idx}:Z{row_idx}')
        if reload:
            self.reload_cache(force=True)

    def _update_values(self, sheet_name, range_name, values, reload=True):
        """Update a specific range with a 2D list of values."""
        self._gsheets_update_values(self.input_sheet_id, f'{sheet_name}!{range_name}', values)
        if reload:
            self.reload_cache(force=True)


    # --- Skills ---
    def get_all_skills(self) -> List[Skill]:
        self.reload_cache()
        if self.skills_df.empty or "Name" not in self.skills_df.columns: return []
        return [Skill(id=i+1, name=str(row["Name"]).strip()) for i, row in self.skills_df.iterrows() if str(row.get("Name", "")).strip()]

    def get_skill_by_name(self, name: str) -> Optional[Skill]:
        return next((s for s in self.get_all_skills() if s.name == name), None)

    def get_or_create_skill(self, name: str, reload=True) -> Skill:
        skill = self.get_skill_by_name(name)
        if not skill:
            self._append_row("Skills", [name], reload=reload)
            return self.get_skill_by_name(name)
        return skill

    # --- Soldiers ---
    def get_all_soldiers(self, include_skills=True, include_unavailabilities=False, include_excluded_posts=True, reload=False) -> List[Soldier]:
        self.reload_cache(force=reload)
        soldiers = []
        if self.soldiers_df.empty or "Name" not in self.soldiers_df.columns: return soldiers
        
        all_posts = {p.name: p for p in self.get_all_posts()} if include_excluded_posts else {}
        all_unavails = self.get_unavailabilities() if include_unavailabilities else []
        
        for i, row in self.soldiers_df.iterrows():
            if not str(row.get("Name", "")).strip(): continue # Skip cleared rows
            s = Soldier(
                id=i+1,
                name=str(row.get("Name", "")).strip(),
                division=int(row.get("Division", 0)) if pd.notna(row.get("Division")) and str(row.get("Division")).isdigit() else None
            )
            skills_str = str(row.get("Skills", ""))
            if skills_str:
                s.skills = [Skill(id=j, name=sk.strip()) for j, sk in enumerate(skills_str.split(",")) if sk.strip()]
            
            ex_posts_str = str(row.get("Excluded Posts", ""))
            if include_excluded_posts and ex_posts_str:
                s.excluded_posts = [all_posts[p.strip()] for p in ex_posts_str.split(",") if p.strip() in all_posts]
                
            if include_unavailabilities:
                s.unavailabilities = [u for u in all_unavails if u.soldier_name == s.name]
                for u in s.unavailabilities: u.soldier = s
                
            soldiers.append(s)
        return soldiers

    def get_soldier_by_id(self, soldier_id: int, include_skills=True, include_unavailabilities=False, include_excluded_posts=True) -> Optional[Soldier]:
        soldiers = self.get_all_soldiers(include_skills=include_skills, include_unavailabilities=include_unavailabilities, include_excluded_posts=include_excluded_posts)
        return next((s for s in soldiers if s.id == soldier_id), None)

    def get_soldier_by_name(self, name: str) -> Optional[Soldier]:
        soldiers = self.get_all_soldiers()
        return next((s for s in soldiers if s.name == name), None)

    def create_soldier(self, name: str, skill_names: List[str], division: Optional[int] = None, excluded_post_names: List[str] = [], reload=True) -> Soldier:
        values = [name, str(division) if division else "", ",".join(skill_names), ",".join(excluded_post_names)]
        self._append_row("Soldiers", values, reload=reload)
        s = self.get_soldier_by_name(name)
        if not s:
             # Fallback ID: count existing data rows and add 1
             existing_count = len([row for _, row in self.soldiers_df.iterrows() if str(row.get("Name", "")).strip()])
             return Soldier(id=existing_count + 1, name=name, division=division)
        return s

    def update_soldier(self, soldier_id: int, name: str, skill_names: List[str], division: Optional[int] = None, excluded_post_names: List[str] = []) -> bool:
        row_idx = soldier_id + 1
        values = [name, str(division) if division else "", ",".join(skill_names), ",".join(excluded_post_names)]
        self._update_row("Soldiers", row_idx, values)
        return True

    def delete_soldier(self, soldier_id: int) -> bool:
        row_idx = soldier_id + 1
        self._delete_row("Soldiers", row_idx)
        return True

    def batch_upsert_soldiers(self, soldiers_data: List[dict]):
        """
        Efficiently upsert multiple soldiers.
        soldiers_data: List of dicts with {name, skills, division, excluded_posts}
        """
        # Load current soldiers to find indices
        self.reload_cache()
        current_soldiers = {str(row.get("Name", "")).strip(): i for i, row in self.soldiers_df.iterrows() if str(row.get("Name", "")).strip()}
        
        # Prepare the grid. We start from Soldiers!A2
        # We'll use a local list and write it all back to be safe and simple
        # Determine the size of the result grid
        max_idx = len(self.soldiers_df)
        grid = []
        for i, row in self.soldiers_df.iterrows():
             grid.append([
                 str(row.get("Name", "")),
                 str(row.get("Division", "")),
                 str(row.get("Skills", "")),
                 str(row.get("Excluded Posts", ""))
             ])
             
        for s in soldiers_data:
            name = s['name']
            values = [
                name,
                str(s.get('division')) if s.get('division') is not None else "",
                ",".join(s.get('skills', [])),
                ",".join(s.get('excluded_posts', []))
            ]
            if name in current_soldiers:
                idx = current_soldiers[name]
                grid[idx] = values
            else:
                grid.append(values)
        
        # Update the entire range
        self._update_values("Soldiers", "A2:D", grid, reload=True)

    # --- Posts ---
    def get_all_posts(self, include_slots=True) -> List[Post]:
        self.reload_cache()
        posts = []
        if self.posts_df.empty or "Name" not in self.posts_df.columns: return posts
        
        for i, row in self.posts_df.iterrows():
            if not str(row.get("Name", "")).strip(): continue
            p = Post(
                name=str(row.get("Name")).strip(),
                shift_length=timedelta(hours=float(row.get("Shift Length (hrs)", 4) or 4)),
                start_time=datetime.strptime(row.get("Start Time", "06:00") or "06:00", "%H:%M").time(),
                end_time=datetime.strptime(row.get("End Time", "05:59") or "05:59", "%H:%M").time(),
                cooldown=timedelta(hours=float(row.get("Cooldown (hrs)", 0) or 0)),
                intensity_weight=float(row.get("Intensity Weight", 1.0) or 1.0),
                is_active=1 if str(row.get("Is Active", "1")) == "1" else 0,
                active_from=None,
                active_until=None
            )
            # Robust parsing for dates to handle "", "None", NaN, etc.
            af = str(row.get("Active From", "")).strip()
            if af and af not in ["None", "nan", "", "NaN"]:
                try: p.active_from = datetime.fromisoformat(af)
                except: pass
            
            au = str(row.get("Active Until", "")).strip()
            if au and au not in ["None", "nan", "", "NaN"]:
                try: p.active_until = datetime.fromisoformat(au)
                except: pass

            p.id = i + 1 
            slots_str = str(row.get("Slots", ""))
            if slots_str:
                p.slots = []
                for j, sk_name in enumerate(slots_str.split(",")):
                    if not sk_name.strip(): continue
                    skill = Skill(name=sk_name.strip())
                    PostTemplateSlot(id=j, post_name=p.name, role_index=j, skill=skill, post=p)
            posts.append(p)
        return posts

    def get_active_posts(self) -> List[Post]:
        return self.get_all_posts()
        
    def get_post_by_name(self, name: str) -> Optional[Post]:
        return next((p for p in self.get_all_posts() if p.name == name), None)

    def create_post(self, name: str, shift_length_hours: float, start_time: time, end_time: time, cooldown_hours: float, intensity_weight: float, slots: List[str], is_active: bool = True, active_from: Optional[datetime] = None, active_until: Optional[datetime] = None, reload=True) -> bool:
        values = [
            name, shift_length_hours, start_time.strftime("%H:%M"), end_time.strftime("%H:%M"),
            cooldown_hours, intensity_weight, ",".join(slots),
            "1" if is_active else "0",
            active_from.isoformat() if active_from else "",
            active_until.isoformat() if active_until else ""
        ]
        self._append_row("Posts", values, reload=reload)
        return True

    def update_post(self, name: str, shift_length_hours: float, start_time: time, end_time: time, cooldown_hours: float, intensity_weight: float, slots: List[str], is_active: bool = True, active_from: Optional[datetime] = None, active_until: Optional[datetime] = None, reload=True) -> bool:
        post = self.get_post_by_name(name)
        if not post: return False
        row_idx = getattr(post, 'id', 0) + 1
        values = [
            name, shift_length_hours, start_time.strftime("%H:%M"), end_time.strftime("%H:%M"),
            cooldown_hours, intensity_weight, ",".join(slots),
            "1" if is_active else "0",
            active_from.isoformat() if active_from else "",
            active_until.isoformat() if active_until else ""
        ]
        self._update_row("Posts", row_idx, values, reload=reload)
        return True

    def delete_post(self, name: str) -> bool:
        post = self.get_post_by_name(name)
        if not post: return False
        row_idx = getattr(post, 'id', 0) + 1
        self._delete_row("Posts", row_idx)
        return True

    def batch_upsert_posts(self, posts_data: List[dict]):
        """
        Efficiently upsert multiple posts.
        """
        self.reload_cache()
        current_posts = {str(row.get("Name", "")).strip(): i for i, row in self.posts_df.iterrows() if str(row.get("Name", "")).strip()}
        
        grid = []
        for i, row in self.posts_df.iterrows():
            grid.append([
                str(row.get("Name", "")),
                str(row.get("Shift Length (hrs)", "")),
                str(row.get("Start Time", "")),
                str(row.get("End Time", "")),
                str(row.get("Cooldown (hrs)", "")),
                str(row.get("Intensity Weight", "")),
                str(row.get("Slots", "")),
                str(row.get("Is Active", "1")),
                str(row.get("Active From", "")),
                str(row.get("Active Until", ""))
            ])
            
        for p in posts_data:
            name = p['name']
            values = [
                name,
                str(p['shift_length_hours']),
                p['start_time'].strftime("%H:%M") if hasattr(p['start_time'], 'strftime') else p['start_time'],
                p['end_time'].strftime("%H:%M") if hasattr(p['end_time'], 'strftime') else p['end_time'],
                str(p['cooldown_hours']),
                str(p['intensity_weight']),
                ",".join(p['slots']),
                "1" if p.get('is_active', True) else "0",
                p.get('active_from').isoformat() if p.get('active_from') and hasattr(p.get('active_from'), 'isoformat') else "",
                p.get('active_until').isoformat() if p.get('active_until') and hasattr(p.get('active_until'), 'isoformat') else ""
            ]
            if name in current_posts:
                idx = current_posts[name]
                grid[idx] = values
            else:
                grid.append(values)
                
        self._update_values("Posts", "A2:J", grid, reload=True)

    # --- Unavailabilities ---
    def get_unavailabilities(self, start_date: Optional[datetime] = None, end_date: Optional[datetime] = None) -> List[Unavailability]:
        self.reload_cache()
        unavails = []
        if self.unavailabilities_df.empty or "Soldier Name" not in self.unavailabilities_df.columns: return unavails
        for i, row in self.unavailabilities_df.iterrows():
            if not str(row.get("Soldier Name", "")).strip(): continue
            try:
                start = datetime.fromisoformat(str(row.get("Start DateTime")))
                end = datetime.fromisoformat(str(row.get("End DateTime")))
                if start_date and end < start_date: continue
                if end_date and start > end_date: continue
                s_name = str(row.get("Soldier Name")).strip()
                sol = self.get_soldier_by_name(s_name)
                unavails.append(Unavailability(
                    id=i+1,
                    soldier_id=sol.id if sol else 0,
                    soldier_name=s_name,
                    soldier=sol,
                    start_datetime=start,
                    end_datetime=end,
                    reason=str(row.get("Reason", ""))
                ))
            except:
                pass
        return unavails

    def get_all_unavailabilities(self) -> List[Unavailability]:
        return self.get_unavailabilities()

    def check_overlapping_unavailability(self, soldier_id: int, start: datetime, end: datetime) -> Optional[Unavailability]:
        soldier = self.get_soldier_by_id(soldier_id)
        if not soldier: return None
        for u in self.get_unavailabilities(start, end):
            if hasattr(u, "soldier_name") and u.soldier_name == soldier.name and u.start_datetime < end and u.end_datetime > start:
                return u
        return None

    def create_unavailability(self, soldier_id: int, start: datetime, end: datetime, reason: Optional[str] = None, reload=True) -> Unavailability:
        soldier = self.get_soldier_by_id(soldier_id)
        if not soldier: raise Exception("Soldier not found")
        values = [soldier.name, start.isoformat(), end.isoformat(), reason or ""]
        self._append_row("Unavailabilities", values, reload=reload)
        new_id = len(self.unavailabilities_df) 
        return Unavailability(id=new_id, soldier_name=soldier.name, start_datetime=start, end_datetime=end, reason=reason)

    def update_unavailability(self, u_id: int, soldier_id: int, start: datetime, end: datetime, reason: Optional[str] = None) -> bool:
        soldier = self.get_soldier_by_id(soldier_id)
        if not soldier: return False
        row_idx = u_id + 1
        values = [soldier.name, start.isoformat(), end.isoformat(), reason or ""]
        self._update_row("Unavailabilities", row_idx, values)
        return True

    def delete_unavailability(self, u_id: int) -> bool:
        row_idx = u_id + 1
        self._delete_row("Unavailabilities", row_idx)
        return True

    def _load_assignments_for_range(self, start: datetime, end: datetime) -> List[Assignment]:
        # Check Cache with 30s TTL
        if self.all_assignments_cache is not None and (ptime.time() - self.assignments_cache_time) < 30:
             return [a for a in self.all_assignments_cache if a.shift.start < end and a.shift.end > start]
             
        # Double-checked locking to prevent thundering herd
        with self.fetch_lock:
             if self.all_assignments_cache is not None and (ptime.time() - self.assignments_cache_time) < 30:
                  return [a for a in self.all_assignments_cache if a.shift.start < end and a.shift.end > start]

             if not self.output_sheet_id: return []
             try:
                # Metadata Caching
                if self.output_sheet_id in self.sheet_metadata_cache:
                    sheet_meta = self.sheet_metadata_cache[self.output_sheet_id]
                else:
                    sheet_meta = self._gsheets_get_metadata(self.output_sheet_id, fields='sheets(properties(title,sheetId),merges)')
                    self.sheet_metadata_cache[self.output_sheet_id] = sheet_meta
                    
                sheets_data = sheet_meta.get('sheets', [])
                
                assignments = []
                ranges_to_fetch = []
                merges_by_title = {} # title -> list of merges
                
                for s in sheets_data:
                    title = s['properties']['title']
                    merges_by_title[title] = s.get('merges', [])
                    if title == "Schedule":
                        ranges_to_fetch.append(f"'{title}'!A:Z")
                
                if not ranges_to_fetch: return []
                
                res = self._gsheets_batch_get_values(self.output_sheet_id, ranges_to_fetch)
                
                all_posts = {p.name: p for p in self.get_all_posts()}
                soldiers_by_name = {s.name: s for s in self.get_all_soldiers(include_unavailabilities=False, include_excluded_posts=False)}
                
                for vr in res.get('valueRanges', []):
                    grid_rows = vr.get('values', [])
                    if not grid_rows: continue
                    
                    raw_range = vr.get('range', '')
                    title = raw_range.split('!')[0].replace("'", "")
                    merges = merges_by_title.get(title, [])
                    
                    parsed_dicts = parse_grid(grid_rows, all_posts, merges=merges, time_granularity_hours=self.time_granularity_hours)

                    for p_dict in parsed_dicts:
                        post = all_posts.get(p_dict['post_name'])
                        actual_start = p_dict['start']
                        actual_end = p_dict['end']
                            
                        shift = Shift(id=0, post_name=p_dict['post_name'], start=actual_start, end=actual_end, post=post)
                        soldier = soldiers_by_name.get(p_dict['soldier_name'], Soldier(name=p_dict['soldier_name']))
                        assignments.append(Assignment(soldier_id=soldier.id or 0, role_id=p_dict['role_id'], shift=shift, soldier=soldier))
                        
                # Update Cache
                self.all_assignments_cache = assignments
                self.assignments_cache_time = ptime.time()
                return assignments
             except Exception as err:
                print(f"Error reading schedules: {err}")
                return []

    def get_shifts_in_range(self, start: datetime, end: datetime) -> List[Shift]:
        return [a.shift for a in self.get_assignments_in_range(start, end)]
        
    def prefetch_assignments(self, start: datetime, end: datetime):
        """Pre-load all assignments for a range and cache them to avoid repeated lookups.
        Includes a 30-day buffer to satisfy fairness and cooldown lookbacks."""
        # Check if cache is still valid
        if self.all_assignments_cache is not None and (ptime.time() - self.assignments_cache_time) < 30:
            return
            
        fetch_start = start - timedelta(days=30)
        fetch_end = end + timedelta(days=30)
        assignments = self._load_assignments_for_range(fetch_start, fetch_end)
        self.all_assignments_cache = assignments
        self.assignments_cache_time = ptime.time()
        self.assignments_cache = {}
        for a in assignments:
            key = (a.shift.post_name, a.shift.start.replace(microsecond=0).isoformat())
            self.assignments_cache[key] = a

    def get_or_create_shift(self, post: Post, start: datetime, end: datetime) -> Shift:
        # 1. Check local assignments cache first
        key = (post.name, start.replace(microsecond=0).isoformat())
        if key in self.assignments_cache:
            return self.assignments_cache[key].shift
            
        # 2. Fallback to slow way if cache is empty or missing (though prefetch should be called)
        if not self.assignments_cache:
            assignments = self._load_assignments_for_range(start, end)
            for a in assignments:
                if a.shift.post_name == post.name and a.shift.start == start:
                    return a.shift
        return Shift(id=0, post_name=post.name, start=start, end=end, post=post)
        
    def get_assignments_in_range(self, start: datetime, end: datetime) -> List[Assignment]:
        assignments = self._load_assignments_for_range(start, end)
        return [a for a in assignments if a.shift.start < end and a.shift.end > start]

    def get_all_assignments(self) -> List[Assignment]:
        return self._load_assignments_for_range(datetime(2000, 1, 1), datetime(2100, 1, 1))

    def count_assignments(self) -> int:
        return len(self.get_all_assignments())

    def get_assignments_for_soldier_in_range(self, soldier_id: int, start: datetime, end: datetime) -> List[Assignment]:
        assignments = self.get_assignments_in_range(start, end)
        return [a for a in assignments if a.soldier_id == soldier_id]

    def get_assignments_for_cooldown_lookback(self, lookback_date: datetime, end_date: datetime) -> List[Assignment]:
        assignments = self._load_assignments_for_range(lookback_date, end_date)
        return [a for a in assignments if a.shift.start >= lookback_date and a.shift.start < end_date]

    def save_assignments_to_grid(self, assignments_data: list, start_date: datetime, end_date: datetime):
        # Ensure datetimes
        for a in assignments_data:
            if isinstance(a['start'], str): a['start'] = datetime.fromisoformat(a['start'])
            if isinstance(a['end'], str): a['end'] = datetime.fromisoformat(a['end'])
            
        tab_name = "Schedule" # Constant tab name
        
        # 1. Fetch existing assignments to append to
        # Fetch a very wide range to be safe
        existing_assignments_objs = self.get_assignments_in_range(datetime(2000, 1, 1), datetime(2100, 1, 1))
        
        # 2. Filter out assignments that are in the range we are currently saving
        # This allows re-saving/updating a specific day without duplicates
        filtered_existing = []
        for a in existing_assignments_objs:
            # Clear assignments that OVERLAP with the range we are currently saving
            if a.shift.start < end_date and a.shift.end > start_date:
                continue
            filtered_existing.append(a)
            
        # 3. Convert existing Assignment objects back to the dict format expected by build_schedule_requests
        combined_data = []
        for a in filtered_existing:
            combined_data.append({
                'soldier_name': a.soldier.name if a.soldier else "Unknown",
                'division_id': a.soldier.division if a.soldier else None,
                'post_name': a.shift.post_name if a.shift else "Unknown",
                'start': a.shift.start,
                'end': a.shift.end,
                'role_id': a.role_id
            })
            
        # 4. Add the new assignments
        combined_data.extend(assignments_data)
        
        if not combined_data:
            return

        # 5. Determine the full range for the new grid
        full_start = min(a['start'] for a in combined_data)
        full_end = max(a['end'] for a in combined_data)
        
        # 6. Ensure the sheet exists and get its ID
        sheet_meta = self._gsheets_get_metadata(self.output_sheet_id)
        sheet_id = None
        for s in sheet_meta.get('sheets', []):
            if s['properties']['title'] == tab_name:
                sheet_id = s['properties']['sheetId']
                
        if sheet_id is None:
            # Create if not exists
            res = self._gsheets_batch_update(
                self.output_sheet_id,
                [{'addSheet': {'properties': {'title': tab_name, 'gridProperties': {'frozenRowCount': 2, 'frozenColumnCount': 2}}}}]
            )
            sheet_id = res['replies'][0]['addSheet']['properties']['sheetId']
        else:
            # Clear existing content to ensure a clean update (without deleting the sheet itself)
            self._gsheets_clear_values(self.output_sheet_id, f"'{tab_name}'!A:Z")
            
        # 7. Build and execute requests
        requests = build_schedule_requests(sheet_id, combined_data, full_start, full_end, time_granularity_hours=self.time_granularity_hours)
        if requests:
            # Prepend a request to clear all existing merges to avoid "overlapping merge" errors
            requests.insert(0, {'unmergeCells': {'range': {'sheetId': sheet_id}}})
            self._gsheets_batch_update(self.output_sheet_id, requests)
            
        # Invalidate caches
        self.all_assignments_cache = None
        self.history_scores_cache = None
        self.sheet_metadata_cache.clear()
        self.sheet_metadata_cache = {}

    def add_assignment(self, soldier_id: int, shift_id: str, role_id: int): 
        # For Google Sheets, add_assignment is usually called during save_assignments_to_grid flow
        # In a generic interface, we'd need a separate "Assignments" sheet if we wanted granular additions.
        # But our current implementation saves the entire grid at once.
        pass

    def clear_assignments_by_ids(self, assignment_ids: list): pass

    def delete_assignments_for_soldier(self, soldier_id: int):
        # In GSheets, this is hard to do without rewriting the whole grid.
        # But for tests, we can implement it by reloading, filtering, and saving.
        all_assignments = self.get_all_assignments()
        filtered = [a for a in all_assignments if a.soldier_id != soldier_id]
        
        # We need to save them back. This is expensive but okay for tests.
        data = []
        for a in filtered:
            data.append({
                'soldier_name': a.soldier.name if a.soldier else "Unknown",
                'division_id': a.soldier.division if a.soldier else None,
                'post_name': a.shift.post_name if a.shift else "Unknown",
                'start': a.shift.start,
                'end': a.shift.end,
                'role_id': a.role_id
            })
        
        # Clear the sheet first to ensure a full rewrite
        self._gsheets_clear_values(self.output_sheet_id, "'Schedule'!A:Z")
        
        if data:
            self.save_assignments_to_grid(data, datetime(2000,1,1), datetime(2100,1,1))
        
        self.all_assignments_cache = None
        self.assignments_cache = {}
        self.reload_cache(force=True)

    def clear_all_data(self):
        # Clear all relevant tabs in both input and output sheets
        # Check metadata first to avoid 400 errors on non-existent sheets
        input_meta = self._gsheets_get_metadata(self.input_sheet_id)
        input_tabs = {s['properties']['title'] for s in input_meta.get('sheets', [])}
        
        tabs_input = ["Soldiers", "Posts", "Unavailabilities"]
        for tab in tabs_input:
            if tab in input_tabs:
                try:
                    self._gsheets_clear_values(self.input_sheet_id, f"'{tab}'!A2:Z")
                except: pass
        
        output_meta = self._gsheets_get_metadata(self.output_sheet_id)
        output_tabs = {s['properties']['title'] for s in output_meta.get('sheets', [])}
        
        tabs_output = ["Schedule", "History"]
        for tab in tabs_output:
            if tab in output_tabs:
                try:
                    self._gsheets_clear_values(self.output_sheet_id, f"'{tab}'!A2:Z")
                except: pass
            
        self.reload_cache(force=True)

    def get_history_scores(self, exclude_from: Optional[datetime] = None) -> dict:
        # Load all history from the Output spreadsheet
        # Cache for 60s if no specific exclude_from
        if exclude_from is None and self.history_scores_cache is not None and (ptime.time() - self.history_scores_cache_time) < 60:
            return self.history_scores_cache
            
        all_assignments = self._load_assignments_for_range(datetime(2000, 1, 1), exclude_from or datetime(2100,1,1))
        scores = defaultdict(float)
        for a in all_assignments:
            if exclude_from and a.shift.start >= exclude_from: continue
            duration_hrs = (a.shift.end - a.shift.start).total_seconds() / 3600
            weight = getattr(a.shift.post, "intensity_weight", 1.0)
            scores[a.soldier_id] += duration_hrs * weight
            
        res = dict(scores)
        if exclude_from is None:
            self.history_scores_cache = res
            self.history_scores_cache_time = ptime.time()
        return res

    def check_manpower(self, start_date: datetime, end_date: datetime):
        start_naive = start_date.replace(tzinfo=None)
        end_naive = end_date.replace(tzinfo=None)
        
        posts = self.get_active_posts()
        soldiers = self.get_all_soldiers(include_unavailabilities=True)
        all_skills = [sk.name for sk in self.get_all_skills()]
        
        results = []
        current_date = start_naive
        
        if current_date.date() == end_naive.date():
             end_naive = current_date + timedelta(days=1)

        while current_date.date() < end_naive.date():
            day_start = datetime.combine(current_date.date(), datetime.min.time())
            day_end = day_start + timedelta(days=1)
            
            daily_posts = []
            for p in posts:
                if p.active_from and p.active_from >= day_end: continue
                if p.active_until and p.active_until <= day_start: continue
                daily_posts.append(p)

            required_by_skill = defaultdict(float)
            for post in daily_posts:
                l = post.shift_length.total_seconds() / 3600
                c = post.cooldown.total_seconds() / 3600
                ratio = (l + c) / l if l > 0 else 1.0
                
                if post.start_time < post.end_time:
                    active_hours = (datetime.combine(datetime.min, post.end_time) - datetime.combine(datetime.min, post.start_time)).total_seconds() / 3600
                else:
                    active_hours = 24 - (datetime.combine(datetime.min, post.start_time) - datetime.combine(datetime.min, post.end_time)).total_seconds() / 3600
                
                active_ratio = active_hours / 24.0
                sustenance_needed = ratio * active_ratio
                
                for slot in post.slots:
                    required_by_skill[slot.skill.name] += sustenance_needed

            total_pool_by_skill = defaultdict(int)
            for s in soldiers:
                for sk in s.skills:
                    total_pool_by_skill[sk.name] += 1

            events = {day_start, day_end}
            for s in soldiers:
                for u in s.unavailabilities:
                    if u.start_datetime < day_end and u.end_datetime > day_start:
                        events.add(max(u.start_datetime, day_start))
                        events.add(min(u.end_datetime, day_end))
            
            sorted_events = sorted(list(events))
            min_available_by_skill = {sk_name: total_pool_by_skill[sk_name] for sk_name in all_skills}

            for i in range(len(sorted_events) - 1):
                start_int, end_int = sorted_events[i], sorted_events[i+1]
                if start_int == end_int: continue
                
                mid = start_int + (end_int - start_int) / 2
                current_avail = defaultdict(int)
                
                for s in soldiers:
                    is_unavailable = False
                    for u in s.unavailabilities:
                        if u.start_datetime <= mid < u.end_datetime:
                            is_unavailable = True
                            break
                    if not is_unavailable:
                        for sk in s.skills:
                            current_avail[sk.name] += 1
                
                for sk_name in all_skills:
                    min_available_by_skill[sk_name] = min(min_available_by_skill[sk_name], current_avail[sk_name])

            day_report = []
            for sk_name in all_skills:
                needed = required_by_skill.get(sk_name, 0.0)
                available = min_available_by_skill[sk_name]
                total = total_pool_by_skill[sk_name]
                day_report.append({
                    "skill": sk_name,
                    "needed": round(needed, 2),
                    "available": int(available),
                    "total_pool": total,
                    "status": "danger" if available < needed else ("warning" if available < needed * 1.5 else "success")
                })
            results.append({
                "date": current_date.date().isoformat(),
                "report": day_report
            })
            current_date += timedelta(days=1)
        return results

def init_db(eng=None): pass
engine = None
Session = lambda: None
