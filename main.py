from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, Query, UploadFile, File, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
import os
import sys
import webbrowser
import threading
import time
from database import (
    ShavtzachiDB, get_db_instance, reset_db_instance, _load_config, _is_gsheets_configured,
    TOKEN_FILE, CREDENTIALS_FILE, EXTERNAL_CREDENTIALS_FILE, get_base_path
)
from models import Soldier, Post, Shift, Assignment, Skill, PostTemplateSlot, Unavailability
from schedule import generate_shifts, solve_shift_assignment, solve_shift_assignment_greedy
from pydantic import BaseModel, field_validator
from typing import List, Optional
from datetime import datetime, timedelta
import csv
import io
import logging
from collections import defaultdict
from export_utils import export_schedule_to_excel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Pre-load data on startup (only if already authenticated)
    config = _load_config()
    if _is_gsheets_configured(config) and os.path.exists(TOKEN_FILE):
        try:
            db = get_db_instance()
            db.reload_cache()
        except Exception as e:
            logger.warning(f"Could not pre-load GSheets cache on startup: {e}")
    threading.Thread(target=open_browser, daemon=True).start()
    yield

app = FastAPI(title="Shavtzachi API", lifespan=lifespan)
api_router = APIRouter(prefix="/api")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_db():
    yield get_db_instance()

# --- Pydantic Schemas ---

class SoldierCreate(BaseModel):
    name: str
    skills: List[str]
    division: Optional[int] = None
    excluded_posts: List[str] = []

class PostCreate(BaseModel):
    name: str
    shift_length_hours: int
    start_time: str
    end_time: str
    cooldown_hours: int
    intensity_weight: float
    slots: List[str]
    is_active: bool = True
    active_from: Optional[datetime] = None
    active_until: Optional[datetime] = None

class AssignmentCreate(BaseModel):
    soldier_id: int
    post_name: str
    start: datetime
    end: datetime
    role_id: int

class SaveScheduleRequest(BaseModel):
    start_date: datetime
    end_date: datetime
    assignments: List[AssignmentCreate]

class DraftRequest(BaseModel):
    start_date: datetime
    end_date: datetime
    algorithm: Optional[str] = "optimal"

class UnavailabilityCreate(BaseModel):
    soldier_id: int
    start_datetime: datetime
    end_datetime: datetime
    reason: Optional[str] = None

class UnavailabilityResponse(BaseModel):
    id: int
    soldier_id: int
    soldier_name: str
    start_datetime: datetime
    end_datetime: datetime
    reason: Optional[str]

class CandidateResponse(BaseModel):
    id: int
    name: str
    fitness_score: float
    conflicts: List[str]
    last_shift: Optional[dict]
    next_shift: Optional[dict]

class CandidateRequest(BaseModel):
    post_name: str
    start: datetime
    end: datetime
    role_id: int
    draft_assignments: List[AssignmentCreate] = []

# (Moved to ShavtzachiDB.get_history_scores)

# --- Endpoints: Personnel ---

@api_router.get("/skills")
def get_all_skills(db: ShavtzachiDB = Depends(get_db)):
    skills = db.get_all_skills()
    return [s.name for s in skills]

@api_router.get("/soldiers")
def get_soldiers(db: ShavtzachiDB = Depends(get_db)):
    soldiers = db.get_all_soldiers()
    scores = db.get_history_scores()
    return [{
        "id": s.id, 
        "name": s.name, 
        "history_score": scores.get(s.id, 0.0), 
        "skills": [sk.name for sk in s.skills], 
        "division": s.division,
        "excluded_posts": [p.name for p in s.excluded_posts]
    } for s in soldiers]

@api_router.post("/soldiers")
def create_soldier(s_data: SoldierCreate, db: ShavtzachiDB = Depends(get_db)):
    s = db.create_soldier(s_data.name, s_data.skills, s_data.division, s_data.excluded_posts)
    return {
        "id": s.id,
        "name": s.name,
        "division": s.division,
        "skills": [sk.name for sk in s.skills],
        "excluded_posts": [p.name for p in s.excluded_posts]
    }

@api_router.put("/soldiers/{s_id}")
def update_soldier(s_id: int, s_data: SoldierCreate, db: ShavtzachiDB = Depends(get_db)):
    success = db.update_soldier(s_id, s_data.name, s_data.skills, s_data.division, s_data.excluded_posts)
    if not success: raise HTTPException(status_code=404, detail="Soldier not found")
    return {"status": "success"}

@api_router.delete("/soldiers/{s_id}")
def delete_soldier(s_id: int, db: ShavtzachiDB = Depends(get_db)):
    success = db.delete_soldier(s_id)
    if not success: raise HTTPException(status_code=404, detail="Soldier not found")
    return {"status": "success"}

# --- Endpoints: Posts ---

@api_router.get("/posts")
def get_posts(db: ShavtzachiDB = Depends(get_db)):
    posts = db.get_all_posts()
    return [{
        "name": p.name,
        "shift_length_hours": p.shift_length.total_seconds() / 3600,
        "start_time": p.start_time.strftime("%H:%M"),
        "end_time": p.end_time.strftime("%H:%M"),
        "cooldown_hours": p.cooldown.total_seconds() / 3600,
        "intensity_weight": p.intensity_weight,
        "is_active": bool(p.is_active),
        "active_from": p.active_from.isoformat() if p.active_from else None,
        "active_until": p.active_until.isoformat() if p.active_until else None,
        "slots": [{"role_index": s.role_index, "skill": s.skill.name} for s in p.slots]
    } for p in posts]

@api_router.post("/posts")
def create_post(p_data: PostCreate, db: ShavtzachiDB = Depends(get_db)):
    db.create_post(
        p_data.name,
        p_data.shift_length_hours,
        datetime.strptime(p_data.start_time, "%H:%M").time(),
        datetime.strptime(p_data.end_time, "%H:%M").time(),
        p_data.cooldown_hours,
        p_data.intensity_weight,
        p_data.slots,
        p_data.is_active,
        p_data.active_from.replace(tzinfo=None) if p_data.active_from else None,
        p_data.active_until.replace(tzinfo=None) if p_data.active_until else None
    )
    return {"status": "success"}

@api_router.put("/posts/{name}")
def update_post(name: str, p_data: PostCreate, db: ShavtzachiDB = Depends(get_db)):
    success = db.update_post(
        name,
        p_data.shift_length_hours,
        datetime.strptime(p_data.start_time, "%H:%M").time(),
        datetime.strptime(p_data.end_time, "%H:%M").time(),
        p_data.cooldown_hours,
        p_data.intensity_weight,
        p_data.slots,
        p_data.is_active,
        p_data.active_from.replace(tzinfo=None) if p_data.active_from else None,
        p_data.active_until.replace(tzinfo=None) if p_data.active_until else None
    )
    if not success: raise HTTPException(status_code=404, detail="Post not found")
    return {"status": "success"}

@api_router.delete("/posts/{name}")
def delete_post(name: str, db: ShavtzachiDB = Depends(get_db)):
    success = db.delete_post(name)
    if not success: raise HTTPException(status_code=404, detail="Post not found")
    return {"status": "success"}

# --- CSV Endpoints ---

@api_router.get("/soldiers/export")
def export_soldiers(db: ShavtzachiDB = Depends(get_db)):
    output = io.StringIO()
    writer = csv.writer(output)
    scores = db.get_history_scores()
    writer.writerow(["name", "division", "skills", "history_score", "excluded_posts"])
    for s in db.get_all_soldiers():
        writer.writerow([
            s.name, 
            s.division, 
            ",".join([sk.name for sk in s.skills]), 
            scores.get(s.id, 0.0),
            ",".join([p.name for p in s.excluded_posts])
        ])
    output.seek(0)
    return StreamingResponse(output, media_type="text/csv", headers={"Content-Disposition": "attachment; filename=soldiers.csv"})

@api_router.post("/soldiers/import")
async def import_soldiers(file: UploadFile = File(...), db: ShavtzachiDB = Depends(get_db)):
    content = await file.read()
    reader = csv.DictReader(io.StringIO(content.decode("utf-8")))
    soldiers_data = []
    for row in reader:
        soldiers_data.append({
            "name": row["name"],
            "division": int(row["division"]) if row.get("division") else None,
            "skills": [s.strip() for s in row["skills"].split(",") if s.strip()],
            "excluded_posts": [p.strip() for p in row.get("excluded_posts", "").split(",") if p.strip()]
        })
    
    db.batch_upsert_soldiers(soldiers_data)
    return {"status": "success"}

@api_router.get("/posts/export")
def export_posts(db: ShavtzachiDB = Depends(get_db)):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["name", "shift_length_hours", "start_time", "end_time", "cooldown_hours", "intensity_weight", "slots", "active_from", "active_until"])
    for p in db.get_all_posts():
        slots = ",".join([s.skill.name for s in sorted(p.slots, key=lambda x: x.role_index)])
        writer.writerow([
            p.name, 
            p.shift_length.total_seconds()/3600, 
            p.start_time.strftime("%H:%M"), 
            p.end_time.strftime("%H:%M"), 
            p.cooldown.total_seconds()/3600, 
            p.intensity_weight, 
            slots,
            p.active_from.isoformat() if p.active_from else "",
            p.active_until.isoformat() if p.active_until else ""
        ])
    output.seek(0)
    return StreamingResponse(output, media_type="text/csv", headers={"Content-Disposition": "attachment; filename=posts.csv"})

@api_router.post("/posts/import")
async def import_posts(file: UploadFile = File(...), db: ShavtzachiDB = Depends(get_db)):
    content = await file.read()
    reader = csv.DictReader(io.StringIO(content.decode("utf-8")))
    posts_data = []
    for row in reader:
        posts_data.append({
            "name": row["name"],
            "shift_length_hours": float(row["shift_length_hours"]),
            "start_time": datetime.strptime(row["start_time"], "%H:%M").time(),
            "end_time": datetime.strptime(row["end_time"], "%H:%M").time(),
            "cooldown_hours": float(row["cooldown_hours"]),
            "intensity_weight": float(row["intensity_weight"]),
            "slots": [s.strip() for s in row["slots"].split(",") if s.strip()],
            "active_from": datetime.fromisoformat(row["active_from"]) if row.get("active_from") else None,
            "active_until": datetime.fromisoformat(row["active_until"]) if row.get("active_until") else None
        })
    
    db.batch_upsert_posts(posts_data)
    return {"status": "success"}

# --- Endpoints: Scheduler ---

@api_router.get("/schedule/shifts")
def get_shifts_with_assignments(start_date: datetime, end_date: datetime, db: ShavtzachiDB = Depends(get_db)):
    try:
        start_naive = start_date.replace(tzinfo=None)
        end_naive = end_date.replace(tzinfo=None)

        posts = db.get_active_posts()
        shifts = generate_shifts(posts, start_naive, end_naive, db=db, include_overflow=True)

        assignments = db.get_assignments_in_range(start_naive, end_naive)

        assignment_lookup = {}
        for a in assignments:
            key = (a.shift.post_name, a.shift.start.replace(microsecond=0).isoformat(), a.role_id)
            assignment_lookup[key] = a

        result = []
        for shift in shifts:
            for slot in shift.post.slots:
                key = (shift.post_name, shift.start.replace(microsecond=0).isoformat(), slot.role_index)
                a = assignment_lookup.get(key)
                result.append({
                    "post_name": shift.post_name,
                    "start": shift.start.isoformat(),
                    "end": shift.end.isoformat(),
                    "role_id": slot.role_index,
                    "skill": slot.skill.name,
                    "soldier_id": a.soldier_id if a else None,
                    "soldier_name": a.soldier.name if a else None,
                })
        logger.info(f"Returning {len(result)} shifts to client.")
        return result
    except Exception as e:
        logger.error(f"Get shifts error: {e}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/schedule/candidates", response_model=List[CandidateResponse])
def get_candidates(req: CandidateRequest, db: ShavtzachiDB = Depends(get_db)):
    try:
        start_naive = req.start.replace(tzinfo=None)
        end_naive = req.end.replace(tzinfo=None)
        
        post = db.get_post_by_name(req.post_name)
        if not post: raise HTTPException(status_code=404, detail="Post not found")
        
        soldiers = db.get_all_soldiers(include_unavailabilities=True)
        history_scores = db.get_history_scores(exclude_from=req.start)
        
        from schedule import evaluate_soldier_fitness
        draft_list = [d.model_dump() for d in req.draft_assignments]
        
        results = []
        for s in soldiers:
            score, conflicts, last_shift, next_shift = evaluate_soldier_fitness(
                s, start_naive, end_naive, post, req.role_id, history_scores, session=db, 
                draft_assignments=draft_list
            )
            results.append({
                "id": s.id,
                "name": s.name,
                "fitness_score": score,
                "conflicts": conflicts,
                "last_shift": last_shift,
                "next_shift": next_shift
            })
            
        results.sort(key=lambda x: x["fitness_score"], reverse=True)
        return results
    except Exception as e:
        logger.error(f"Get candidates error: {e}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/schedule")
def get_schedule(start_date: datetime, end_date: datetime, db: ShavtzachiDB = Depends(get_db)):
    try:
        start_naive = start_date.replace(tzinfo=None)
        end_naive = end_date.replace(tzinfo=None)
        
        assignments = db.get_assignments_in_range(start_naive, end_naive)
        
        return [{
            "soldier_id": a.soldier_id,
            "soldier_name": a.soldier.name,
            "post_name": a.shift.post.name,
            "start": a.shift.start.isoformat(),
            "end": a.shift.end.isoformat(),
            "role_id": a.role_id
        } for a in assignments]
    except Exception as e:
        logger.error(f"Get schedule error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/schedule/export")
def export_schedule(start_date: datetime, end_date: datetime, db: ShavtzachiDB = Depends(get_db)):
    try:
        start_naive = start_date.replace(tzinfo=None)
        end_naive = end_date.replace(tzinfo=None)
        
        assignments = db.get_assignments_in_range(start_naive, end_naive)
        
        data = []
        for a in assignments:
            # Find the skill name for this role_id in the post templates
            skill_name = "N/A"
            for slot in a.shift.post.slots:
                if slot.role_index == a.role_id:
                    skill_name = slot.skill.name
                    break
            
            data.append({
                "soldier_id": a.soldier_id,
                "soldier_name": a.soldier.name,
                "division_id": a.soldier.division,
                "post_name": a.shift.post.name,
                "start": a.shift.start,
                "end": a.shift.end,
                "role_id": a.role_id,
                "role_name": skill_name
            })
        
        excel_file = export_schedule_to_excel(data, start_naive, end_naive)
        
        filename = f"schedule_{start_naive.strftime('%Y%m%d')}.xlsx"
        return StreamingResponse(
            excel_file,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )
    except Exception as e:
        logger.error(f"Export schedule error: {e}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/schedule/draft")
def draft_schedule(req: DraftRequest, db: ShavtzachiDB = Depends(get_db)):
    try:
        soldiers = db.get_all_soldiers(include_unavailabilities=True)
        posts = db.get_active_posts()
        
        start_naive = req.start_date.replace(tzinfo=None)
        end_naive = req.end_date.replace(tzinfo=None)
        
        shifts = generate_shifts(posts, start_naive, end_naive, db=None)
        history_scores = db.get_history_scores(exclude_from=req.start_date)
            
        lookback_date = start_naive - timedelta(days=7)
        existing_assignments = db.get_assignments_for_cooldown_lookback(lookback_date, end_naive)
            
        if req.algorithm == "greedy":
            assignments = solve_shift_assignment_greedy(
                shifts, soldiers, 
                history_scores=history_scores, 
                existing_assignments=existing_assignments,
                session=db
            )
        else:
            assignments = solve_shift_assignment(
                shifts, soldiers, 
                history_scores=history_scores, 
                existing_assignments=existing_assignments
            )
        if not assignments: return []
            
        return [{
            "soldier_id": a.soldier_id,
            "soldier_name": a.soldier.name,
            "post_name": a.shift.post.name,
            "start": a.shift.start.isoformat(),
            "end": a.shift.end.isoformat(),
            "role_id": a.role_id
        } for a in assignments]
    except Exception as e:
        logger.error(f"Draft error: {str(e)}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/schedule/save")
def save_schedule(req: SaveScheduleRequest, db: ShavtzachiDB = Depends(get_db)):
    try:
        start_naive = req.start_date.replace(tzinfo=None)
        end_naive = req.end_date.replace(tzinfo=None)

        posts = db.get_all_posts()
        soldiers_by_id = {s.id: s for s in db.get_all_soldiers()}
        
        assignments_data = []
        for a_data in req.assignments:
            post = next((p for p in posts if p.name == a_data.post_name), None)
            if not post: continue
            
            s_start = a_data.start.replace(tzinfo=None)
            s_end = s_start + post.shift_length
            
            soldier = soldiers_by_id.get(a_data.soldier_id)
            if not soldier: continue
            
            assignments_data.append({
                'soldier_name': soldier.name,
                'division_id': soldier.division,
                'post_name': a_data.post_name,
                'start': s_start,
                'end': s_end,
                'role_id': a_data.role_id
            })

        db.save_assignments_to_grid(assignments_data, start_naive, end_naive)
        
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Save schedule error: {str(e)}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

# --- Endpoints: Unavailability ---

@api_router.get("/unavailabilities", response_model=List[UnavailabilityResponse])
def get_unavailabilities(
    start_date: Optional[datetime] = None, 
    end_date: Optional[datetime] = None, 
    db: ShavtzachiDB = Depends(get_db)
):
    records = db.get_unavailabilities(
        start_date.replace(tzinfo=None) if start_date else None,
        end_date.replace(tzinfo=None) if end_date else None
    )
    return [{
        "id": r.id,
        "soldier_id": r.soldier_id,
        "soldier_name": r.soldier.name,
        "start_datetime": r.start_datetime,
        "end_datetime": r.end_datetime,
        "reason": r.reason
    } for r in records]

@api_router.post("/unavailabilities")
def create_unavailability(u_data: UnavailabilityCreate, db: ShavtzachiDB = Depends(get_db)):
    existing = db.check_overlapping_unavailability(
        u_data.soldier_id, 
        u_data.start_datetime.replace(tzinfo=None), 
        u_data.end_datetime.replace(tzinfo=None)
    )
    if existing:
        raise HTTPException(status_code=400, detail="Overlapping unavailability exists for this soldier")
        
    record = db.create_unavailability(
        u_data.soldier_id,
        u_data.start_datetime.replace(tzinfo=None),
        u_data.end_datetime.replace(tzinfo=None),
        u_data.reason
    )
    return {"status": "success", "id": record.id}

@api_router.put("/unavailabilities/{u_id}")
def update_unavailability(u_id: int, u_data: UnavailabilityCreate, db: ShavtzachiDB = Depends(get_db)):
    success = db.update_unavailability(
        u_id,
        u_data.soldier_id,
        u_data.start_datetime.replace(tzinfo=None),
        u_data.end_datetime.replace(tzinfo=None),
        u_data.reason
    )
    if not success: raise HTTPException(status_code=404, detail="Unavailability not found")
    return {"status": "success"}

@api_router.delete("/unavailabilities/{u_id}")
def delete_unavailability(u_id: int, db: ShavtzachiDB = Depends(get_db)):
    success = db.delete_unavailability(u_id)
    if not success: raise HTTPException(status_code=404, detail="Unavailability not found")
    return {"status": "success"}

@api_router.get("/unavailabilities/check-manpower")
def check_manpower(start_date: datetime, end_date: datetime, db: ShavtzachiDB = Depends(get_db)):
    try:
        return db.check_manpower(start_date, end_date)
    except Exception as e:
        logger.error(f"Manpower check error: {e}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------

OAUTH_REDIRECT_URI = "http://localhost:8001/api/auth/callback"
OAUTH_SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

@api_router.get("/auth/status")
def auth_status():
    """Returns whether the app is authenticated and which backend is active."""
    config = _load_config()
    if not _is_gsheets_configured(config):
        return {"authenticated": True, "backend": "sqlite"}

    if not os.path.exists(TOKEN_FILE):
        return {"authenticated": False, "backend": "gsheets", "reason": "no_token"}

    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        import json
        
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, OAUTH_SCOPES)
        
        # Verify client_id matches credentials.json (prevents 403 when switching cred types)
        active_creds_path = EXTERNAL_CREDENTIALS_FILE if os.path.exists(EXTERNAL_CREDENTIALS_FILE) else CREDENTIALS_FILE
        if os.path.exists(active_creds_path):
            with open(active_creds_path) as f:
                cdata = json.load(f)
                cid = cdata.get("web", {}).get("client_id") or cdata.get("installed", {}).get("client_id")
                if cid and creds.client_id != cid:
                    os.remove(TOKEN_FILE)
                    return {"authenticated": False, "backend": "gsheets", "reason": "credential_mismatch"}

        if creds.valid:
            return {"authenticated": True, "backend": "gsheets"}
        if creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                with open(TOKEN_FILE, "w") as f:
                    f.write(creds.to_json())
                return {"authenticated": True, "backend": "gsheets"}
            except Exception as e:
                logger.warning(f"Token refresh failed: {e}")
                os.remove(TOKEN_FILE)
    except Exception as e:
        logger.error(f"Auth status check error: {e}")
        pass

    return {"authenticated": False, "backend": "gsheets", "reason": "invalid_token"}


@api_router.get("/auth/login")
def auth_login():
    """Redirect the browser to Google's OAuth consent screen."""
    config = _load_config()
    if not _is_gsheets_configured(config):
        raise HTTPException(status_code=400, detail="App is using SQLite backend — no login required.")

    active_creds_path = EXTERNAL_CREDENTIALS_FILE if os.path.exists(EXTERNAL_CREDENTIALS_FILE) else CREDENTIALS_FILE
    if not os.path.exists(active_creds_path):
        raise HTTPException(status_code=500, detail="credentials.json not found on server.")

    try:
        from google_auth_oauthlib.flow import Flow
        import json
        with open(active_creds_path) as f:
            client_config = json.load(f)

        # Support both 'web' and 'installed' credential types
        cred_type = "web" if "web" in client_config else "installed"
        flow = Flow.from_client_secrets_file(
            active_creds_path,
            scopes=OAUTH_SCOPES,
            redirect_uri=OAUTH_REDIRECT_URI,
        )
        auth_url, _ = flow.authorization_url(
            access_type="offline",
            include_granted_scopes="true",
            prompt="consent",
        )
        
        # PERSIST PKCE VERIFIER: The flow generates a code_verifier for PKCE.
        # Since we are stateless across requests, we must save it to use in the callback.
        code_verifier_path = os.path.join(get_base_path(), ".code_verifier")
        if hasattr(flow, 'code_verifier'):
            with open(code_verifier_path, "w") as f:
                f.write(flow.code_verifier)
                
        return RedirectResponse(url=auth_url)
    except Exception as e:
        logger.error(f"Auth login error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.get("/auth/callback")
def auth_callback(code: str, state: Optional[str] = None, error: Optional[str] = None):
    """Handle OAuth callback from Google. Saves token.json and reloads DB."""
    if error:
        return RedirectResponse(url=f"/?auth_error={error}")

    active_creds_path = EXTERNAL_CREDENTIALS_FILE if os.path.exists(EXTERNAL_CREDENTIALS_FILE) else CREDENTIALS_FILE
    if not os.path.exists(active_creds_path):
        raise HTTPException(status_code=500, detail="credentials.json not found on server.")

    try:
        from google_auth_oauthlib.flow import Flow
        flow = Flow.from_client_secrets_file(
            active_creds_path,
            scopes=OAUTH_SCOPES,
            redirect_uri=OAUTH_REDIRECT_URI,
        )
        
        # RESTORE PKCE VERIFIER:
        code_verifier_path = os.path.join(get_base_path(), ".code_verifier")
        if os.path.exists(code_verifier_path):
            with open(code_verifier_path, "r") as f:
                flow.code_verifier = f.read().strip()
            os.remove(code_verifier_path) # Clean up
            
        flow.fetch_token(code=code)
        creds = flow.credentials
        with open(TOKEN_FILE, "w") as f:
            f.write(creds.to_json())
        logger.info("OAuth callback: token saved successfully.")

        # Reset DB singleton so it reinitialises with the new token
        reset_db_instance()
        try:
            db = get_db_instance()
            db.reload_cache()
        except Exception as e:
            logger.warning(f"Could not reload cache after auth: {e}")

        # Redirect to frontend root
        return RedirectResponse(url="/")
    except Exception as e:
        logger.error(f"Auth callback error: {e}")
        return RedirectResponse(url=f"/?auth_error={str(e)}")


app.include_router(api_router)
def get_frontend_dist():
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, "frontend", "dist")
    else:
        return os.path.join(os.path.dirname(__file__), "frontend", "dist")

frontend_dist = get_frontend_dist()

if os.path.exists(frontend_dist):
    # Route for SPA fallback
    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        file_path = os.path.join(frontend_dist, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(frontend_dist, "index.html"))
else:
    logger.warning(f"Frontend dist directory not found at {frontend_dist}")

def open_browser():
    time.sleep(1.5)
    webbrowser.open("http://localhost:8001")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
