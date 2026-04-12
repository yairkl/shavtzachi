from datetime import datetime, time, timedelta
import pandas as pd
import numpy as np
from database import engine, Session
from models import Post, Soldier, Shift, Assignment, Unavailability
from typing import List, Optional
from ortools.sat.python import cp_model
import itertools
import logging
from collections import defaultdict

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def generate_shifts(posts, start_date, end_date, session=None):
    shifts = []
    if isinstance(start_date, str): start_date = datetime.fromisoformat(start_date)
    if isinstance(end_date, str): end_date = datetime.fromisoformat(end_date)
    
    # Ensure precision to seconds to avoid subtle comparison issues
    start_date = start_date.replace(microsecond=0)
    end_date = end_date.replace(microsecond=0)
    
    for post in posts:
        current_day = (start_date - timedelta(days=1)).replace(hour=0, minute=0, second=0)
        while current_day < end_date:
            active_start = current_day.replace(hour=post.start_time.hour, minute=post.start_time.minute, second=post.start_time.second)
            
            if post.start_time >= post.end_time:
                active_end = (current_day + timedelta(days=1)).replace(hour=post.end_time.hour, minute=post.end_time.minute, second=post.end_time.second)
            else:
                active_end = current_day.replace(hour=post.end_time.hour, minute=post.end_time.minute, second=post.end_time.second)
                
            current_shift_start = active_start
            while current_shift_start < active_end:
                current_shift_end = current_shift_start + post.shift_length
                
                if current_shift_start >= start_date and current_shift_start < end_date:
                    shift = Shift(post=post, post_name=post.name, start=current_shift_start, end=current_shift_end)
                    shifts.append(shift)
                    if session:
                        existing = session.query(Shift).filter(Shift.post_name==post.name, Shift.start==shift.start).first()
                        if not existing: session.add(shift)
                        else: shifts[-1] = existing
                
                current_shift_start = current_shift_end
                
            current_day += timedelta(days=1)
    
    if session: session.commit()
    return shifts

def solve_shift_assignment(shifts:List[Shift], soldiers:List[Soldier], history_scores: Optional[dict] = None, existing_assignments: Optional[List[Assignment]] = None):
    if not shifts or not soldiers: 
        logger.warning("No shifts or soldiers provided to solver.")
        return []
    
    if history_scores is None:
        history_scores = {s.id: 0.0 for s in soldiers}
        
    if existing_assignments is None:
        existing_assignments = []
        
    model = cp_model.CpModel()
    
    # Ensure all shifts have a unique ID for the model's dictionaries
    # Use object ID if DB ID is missing
    shift_map = {}
    for i, s in enumerate(shifts):
        sid = s.id if s.id is not None else (100000 + i)
        shift_map[sid] = s
        
    role_count = {sid: len(s.post.slots) for sid, s in shift_map.items()}
    qualifications = {s.id: set([sk.name for sk in s.skills]) for s in soldiers}
    
    logger.info(f"Building model: {len(shifts)} shifts, {len(soldiers)} soldiers.")
    
    assignment_vars = {}
    filled_role_vars = {}

    for sid, shift in shift_map.items():
        for role_id in range(role_count[sid]):
            role_filled = model.NewBoolVar(f"filled_{sid}_{role_id}")
            filled_role_vars[(sid, role_id)] = role_filled
            
            soldier_vars = []
            for soldier in soldiers:
                v = model.NewBoolVar(f"A_{sid}_{soldier.id}_{role_id}")
                assignment_vars[(sid, soldier.id, role_id)] = v
                soldier_vars.append(v)
            model.Add(sum(soldier_vars) == role_filled)

    # Constraint: Soldier once per shift
    for sid, shift in shift_map.items():
        for soldier in soldiers:
            model.Add(sum(assignment_vars[(sid, soldier.id, r)] for r in range(role_count[sid])) <= 1)

    # Qualification Constraint
    for sid, shift in shift_map.items():
        # Slots might be lazy loaded, ensure access is safe
        for slot in shift.post.slots:
            rid = slot.role_index
            req = slot.skill.name
            q_count = 0
            for soldier in soldiers:
                if req not in qualifications[soldier.id]:
                    model.Add(assignment_vars[(sid, soldier.id, rid)] == 0)
                else:
                    q_count += 1
            if q_count == 0:
                logger.warning(f"CRITICAL: No one qualified for {shift.post_name} role {rid} ({req})")

    # Handle Existing Assignments
    ephemeral_lookup = {}
    for sid, shift in shift_map.items():
        ephemeral_lookup[(shift.post_name, shift.start.replace(microsecond=0))] = sid

    boundary_assignments = []
    preassigned_pairs = set()
    
    for pa in existing_assignments:
        key = (pa.shift.post_name, pa.shift.start.replace(microsecond=0))
        if key in ephemeral_lookup:
            sid = ephemeral_lookup[key]
            if pa.role_id < role_count[sid]:
                # Force the solver to include this assignment
                model.Add(assignment_vars[(sid, pa.soldier_id, pa.role_id)] == 1)
                preassigned_pairs.add((sid, pa.soldier_id, pa.role_id))
            else:
                boundary_assignments.append(pa)
        else:
            boundary_assignments.append(pa)

    # Overlap and Cooldown against boundary assignments
    prev_by_soldier = defaultdict(list)
    for pa in boundary_assignments:
        prev_by_soldier[pa.soldier_id].append(pa)

    for soldier in soldiers:
        # Pre-filter shifts that are close in time
        sorted_sids = sorted(shift_map.keys(), key=lambda x: shift_map[x].start)
        
        # Check previous assignments cooldown
        for pa in prev_by_soldier[soldier.id]:
            if not pa.shift or not pa.shift.post:
                # If post data is missing, we at least respect the shift duration for overlap protection
                pa_end = pa.shift.end if pa.shift else datetime.min
                for sid1 in sorted_sids:
                    s1 = shift_map[sid1]
                    if s1.start < pa_end and pa.shift.start < s1.end:
                        for r1 in range(role_count[sid1]):
                            if (sid1, soldier.id, r1) not in preassigned_pairs:
                                model.Add(assignment_vars[(sid1, soldier.id, r1)] == 0)
                continue

            pa_cooldown_limit = pa.shift.end + pa.shift.post.cooldown
            for sid1 in sorted_sids:
                s1 = shift_map[sid1]
                if not s1.post: continue
                s1_cooldown_limit = s1.end + s1.post.cooldown
                
                if s1.start < pa_cooldown_limit and pa.shift.start < s1_cooldown_limit:
                    for r1 in range(role_count[sid1]):
                        if (sid1, soldier.id, r1) not in preassigned_pairs:
                            model.Add(assignment_vars[(sid1, soldier.id, r1)] == 0)

        # Check unavailabilities
        for sid in sorted_sids:
            s1 = shift_map[sid]
            for u in soldier.unavailabilities:
                if not (s1.end <= u.start_datetime or s1.start >= u.end_datetime):
                    for r1 in range(role_count[sid]):
                        if (sid, soldier.id, r1) not in preassigned_pairs:
                            model.Add(assignment_vars[(sid, soldier.id, r1)] == 0)

        # Check overlaps and cooldowns within window
        for i, sid1 in enumerate(sorted_sids):
            s1 = shift_map[sid1]
            cooldown_limit = s1.end + s1.post.cooldown
            for j in range(i + 1, len(sorted_sids)):
                sid2 = sorted_sids[j]
                s2 = shift_map[sid2]
                if s2.start < cooldown_limit:
                    for r1 in range(role_count[sid1]):
                        for r2 in range(role_count[sid2]):
                            # Limit to at most 1, unless the user manually preassigned both
                            if (sid1, soldier.id, r1) not in preassigned_pairs or (sid2, soldier.id, r2) not in preassigned_pairs:
                                model.Add(assignment_vars[(sid1, soldier.id, r1)] + assignment_vars[(sid2, soldier.id, r2)] <= 1)
                else: break

    # Objective
    total_filled = sum(filled_role_vars.values())
    
    # Normalize history scores to keep variables small and prevent overflow
    min_history = min([history_scores.get(s.id, 0.0) for s in soldiers]) if soldiers else 0.0
    
    loads = []
    for soldier in soldiers:
        load = model.NewIntVar(0, 10000000, f"load_{soldier.id}")
        work_parts = []
        for sid, shift in shift_map.items():
            val = int((shift.end - shift.start).total_seconds() / 3600 * shift.post.intensity_weight * 10)
            for r in range(role_count[sid]):
                work_parts.append(assignment_vars[(sid, soldier.id, r)] * val)
        
        normalized_history = int((history_scores.get(soldier.id, 0.0) - min_history) * 10)
        model.Add(load == normalized_history + sum(work_parts))
        loads.append(load)

    sum_load_sq = []
    for soldier, load in zip(soldiers, loads):
        load_sq = model.NewIntVar(0, 10000000000, f"load_sq_{soldier.id}")
        model.AddMultiplicationEquality(load_sq, [load, load])
        sum_load_sq.append(load_sq)
    
    # Maximize filled roles primarily, then minimize variance (by minimizing sum of squares of loads)
    model.Maximize(total_filled * 100000000 - sum(sum_load_sq))
    
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 15.0
    status = solver.Solve(model)
    logger.info(f"Solver finished: {solver.StatusName(status)}")

    if status in [cp_model.OPTIMAL, cp_model.FEASIBLE]:
        results = []
        for sid, shift in shift_map.items():
            for soldier in soldiers:
                for r in range(role_count[sid]):
                    if solver.Value(assignment_vars[(sid, soldier.id, r)]):
                        # Result objects must point to the original objects
                        results.append(Assignment(soldier=soldier, soldier_id=soldier.id, shift=shift, shift_id=shift.id, role_id=r))
        logger.info(f"Found {len(results)} assignments.")
        return results
        
    return []
