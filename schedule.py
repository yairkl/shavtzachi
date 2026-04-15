from datetime import datetime, time, timedelta
import pandas as pd
import numpy as np
from database import engine, Session, ShavtzachiDB
from models import Post, Soldier, Shift, Assignment, Unavailability
from typing import List, Optional, Dict, Set, Tuple
from ortools.sat.python import cp_model
import itertools
import logging
from collections import defaultdict

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shift generation
# ---------------------------------------------------------------------------

def generate_shifts(posts, start_date, end_date, db: Optional[ShavtzachiDB] = None, include_overflow: bool = False):
    shifts = []
    if isinstance(start_date, str): start_date = datetime.fromisoformat(start_date)
    if isinstance(end_date, str): end_date = datetime.fromisoformat(end_date)
    
    # Ensure precision to seconds to avoid subtle comparison issues
    start_date = start_date.replace(microsecond=0)
    end_date = end_date.replace(microsecond=0)
    
    for post in posts:
        # Stable lookback: align the generation to a fixed anchor using multiples of shift_length.
        # This ensures the sequence of shifts is identical regardless of the requested window.
        anchor = datetime(2024, 1, 1, post.start_time.hour, post.start_time.minute, post.start_time.second)
        
        # Find a safe starting point before the requested window
        lookback_target = start_date - timedelta(days=int(post.shift_length.total_seconds() // 86400) + 2)
        
        # Calculate shifts to skip from anchor to reach lookback_target
        delta_seconds = (lookback_target - anchor).total_seconds()
        shift_length_seconds = post.shift_length.total_seconds()
        shifts_to_skip = int(delta_seconds // shift_length_seconds)
        
        # The first shift in our sequence
        current_shift_start = anchor + timedelta(seconds=shifts_to_skip * shift_length_seconds)
        
        # We still use the daily-oriented loop structure for compatibility with non-24/7 posts,
        # but we anchor the current_day and inner start times.
        current_day = current_shift_start.replace(hour=0, minute=0, second=0)

        while current_day < end_date:
            active_start = current_day.replace(hour=post.start_time.hour, minute=post.start_time.minute, second=post.start_time.second)
            
            if post.start_time >= post.end_time:
                active_end = (current_day + timedelta(days=1)).replace(hour=post.end_time.hour, minute=post.end_time.minute, second=post.end_time.second)
            else:
                active_end = current_day.replace(hour=post.end_time.hour, minute=post.end_time.minute, second=post.end_time.second)
                
            # If our sequence start is already beyond the day's active window, move next.
            # But normally we align current_shift_start with active_start.
            if current_shift_start < active_start:
                 current_shift_start = active_start

            while current_shift_start < active_end:
                current_shift_end = current_shift_start + post.shift_length
                
                # Logic for display vs logic for solver/tests:
                # - include_overflow=True: include any shift that OVERLAPS with the requested range
                # - include_overflow=False (default): only include shifts that START within the requested range (legacy behavior)
                is_overlap = current_shift_start < end_date and current_shift_end > start_date
                is_starting_in_window = current_shift_start >= start_date and current_shift_start < end_date
                
                should_include = is_overlap if include_overflow else is_starting_in_window

                if should_include:
                    # Deduplicate based on post and start time
                    if not any(s.post_name == post.name and s.start == current_shift_start for s in shifts):
                        shift = Shift(post=post, post_name=post.name, start=current_shift_start, end=current_shift_end)
                        shifts.append(shift)
                        if db:
                            existing = db.get_or_create_shift(post, current_shift_start, current_shift_end)
                            shifts[-1] = existing
                
                current_shift_start = current_shift_end
            
            # For multiday shifts, skip days already covered by the ongoing shift.
            if current_shift_start > active_end:
                # Fast-forward to the day of the next potential start, ensuring we always progress at least one day.
                new_day = current_shift_start.replace(hour=0, minute=0, second=0)
                current_day = max(current_day + timedelta(days=1), new_day)
            else:
                current_day += timedelta(days=1)
    
    if db: db.commit()
    # Sort for deterministic output
    shifts.sort(key=lambda s: (s.post_name, s.start))
    return shifts

# ---------------------------------------------------------------------------
# Solver — helper types
# ---------------------------------------------------------------------------

class _SolverContext:
    """Bundles all shared state for the constraint-building helpers."""
    def __init__(self, model, shift_map, role_count, soldiers, assignment_vars, filled_role_vars):
        self.model = model
        self.shift_map = shift_map
        self.role_count = role_count
        self.soldiers = soldiers
        self.assignment_vars = assignment_vars
        self.filled_role_vars = filled_role_vars
        self.preassigned_pairs: Set[Tuple[int, int, int]] = set()
        self.sorted_sids = sorted(shift_map.keys(), key=lambda x: shift_map[x].start)
        self.cooldown_violations: List[cp_model.BoolVar] = []

# ---------------------------------------------------------------------------
# Solver — step 1: build shift map & decision variables
# ---------------------------------------------------------------------------

def _build_shift_map(shifts: List[Shift]):
    """Create a mapping of unique IDs to shifts, and per-shift role counts."""
    shift_map = {}
    for i, s in enumerate(shifts):
        sid = s.id if s.id is not None else (100000 + i)
        shift_map[sid] = s
    role_count = {sid: len(s.post.slots) for sid, s in shift_map.items()}
    return shift_map, role_count


def _create_decision_variables(model, shift_map, role_count, soldiers):
    """Create the core assignment and role-filled boolean variables.

    Returns:
        assignment_vars:  dict[(shift_id, soldier_id, role_id)] → BoolVar
        filled_role_vars: dict[(shift_id, role_id)] → BoolVar
    """
    assignment_vars = {}
    filled_role_vars = {}

    for sid, shift in shift_map.items():
        for role_id in range(role_count[sid]):
            # Every role MUST be filled (hard constraint)
            role_filled = model.NewBoolVar(f"filled_{sid}_{role_id}")
            model.Add(role_filled == 1)
            filled_role_vars[(sid, role_id)] = role_filled
            
            soldier_vars = []
            for soldier in soldiers:
                v = model.NewBoolVar(f"A_{sid}_{soldier.id}_{role_id}")
                assignment_vars[(sid, soldier.id, role_id)] = v
                soldier_vars.append(v)
            model.Add(sum(soldier_vars) == role_filled)

    # Each soldier can fill at most one role per shift
    for sid in shift_map:
        for soldier in soldiers:
            model.Add(sum(assignment_vars[(sid, soldier.id, r)] for r in range(role_count[sid])) <= 1)

    return assignment_vars, filled_role_vars

# ---------------------------------------------------------------------------
# Solver — step 2: skill qualification constraints
# ---------------------------------------------------------------------------

def _add_skill_constraints(ctx: _SolverContext):
    """Prevent soldiers from being assigned to roles they are not qualified for."""
    qualifications = {s.id: {sk.name for sk in s.skills} for s in ctx.soldiers}
    
    for sid, shift in ctx.shift_map.items():
        for slot in shift.post.slots:
            rid = slot.role_index
            req = slot.skill.name
            q_count = 0
            for soldier in ctx.soldiers:
                if req not in qualifications[soldier.id]:
                    ctx.model.Add(ctx.assignment_vars[(sid, soldier.id, rid)] == 0)
                else:
                    q_count += 1
            if q_count == 0:
                logger.warning(f"CRITICAL: No one qualified for {shift.post_name} role {rid} ({req})")

# ---------------------------------------------------------------------------
# Solver — step 3: handle existing / pre-assigned shifts
# ---------------------------------------------------------------------------

def _process_existing_assignments(ctx: _SolverContext, existing_assignments: List[Assignment]):
    """Pin already-committed assignments and identify boundary assignments
    (those outside the current window) for cooldown enforcement.

    Returns:
        boundary_assignments: assignments that fall outside the current shift window.
    """
    ephemeral_lookup = {}
    for sid, shift in ctx.shift_map.items():
        ephemeral_lookup[(shift.post_name, shift.start.replace(microsecond=0))] = sid

    boundary_assignments = []

    for pa in existing_assignments:
        key = (pa.shift.post_name, pa.shift.start.replace(microsecond=0))
        if key in ephemeral_lookup:
            sid = ephemeral_lookup[key]
            if pa.role_id < ctx.role_count[sid]:
                # Force the solver to include this assignment
                ctx.model.Add(ctx.assignment_vars[(sid, pa.soldier_id, pa.role_id)] == 1)
                ctx.preassigned_pairs.add((sid, pa.soldier_id, pa.role_id))
            else:
                boundary_assignments.append(pa)
        else:
            boundary_assignments.append(pa)

    return boundary_assignments

# ---------------------------------------------------------------------------
# Solver — step 4: temporal constraints (cooldown, overlap, unavailability)
# ---------------------------------------------------------------------------

def _add_temporal_constraints(ctx: _SolverContext, boundary_assignments: List[Assignment]):
    """Add cooldown, overlap, and unavailability constraints for each soldier."""
    prev_by_soldier = defaultdict(list)
    for pa in boundary_assignments:
        prev_by_soldier[pa.soldier_id].append(pa)

    for soldier in ctx.soldiers:
        _add_boundary_cooldowns(ctx, soldier, prev_by_soldier[soldier.id])
        _add_unavailability_constraints(ctx, soldier)
        _add_intra_window_cooldowns(ctx, soldier)


def _add_boundary_cooldowns(ctx, soldier, prev_assignments):
    """Handle conflicts with assignments that fall outside the current shift window.
    
    Direct time overlaps are HARD constraints.
    Cooldown violations are SOFT constraints.
    """
    for pa in prev_assignments:
        if not pa.shift or not pa.shift.post:
            # Basic overlap-only check for legacy/partial data
            pa_end = pa.shift.end if pa.shift else datetime.min
            for sid1 in ctx.sorted_sids:
                s1 = ctx.shift_map[sid1]
                if s1.start < pa_end and pa.shift.start < s1.end:
                    for r1 in range(ctx.role_count[sid1]):
                        if (sid1, soldier.id, r1) not in ctx.preassigned_pairs:
                            ctx.model.Add(ctx.assignment_vars[(sid1, soldier.id, r1)] == 0)
            continue

        pa_end = pa.shift.end
        pa_cooldown_limit = pa_end + pa.shift.post.cooldown
        
        for sid1 in ctx.sorted_sids:
            s1 = ctx.shift_map[sid1]
            if not s1.post: continue
            
            # Use original limits for future boundary assignments too
            s1_cooldown_limit = s1.end + s1.post.cooldown
            
            # 1. Direct Time Overlap (HARD)
            if s1.start < pa_end and pa.shift.start < s1.end:
                for r1 in range(ctx.role_count[sid1]):
                    if (sid1, soldier.id, r1) not in ctx.preassigned_pairs:
                        ctx.model.Add(ctx.assignment_vars[(sid1, soldier.id, r1)] == 0)
            
            # 2. Cooldown Violation (SOFT)
            elif (s1.start < pa_cooldown_limit and pa.shift.start < s1.end) or \
                 (pa.shift.start < s1_cooldown_limit and s1.start < pa.shift.end):
                for r1 in range(ctx.role_count[sid1]):
                    if (sid1, soldier.id, r1) not in ctx.preassigned_pairs:
                        v_assign = ctx.assignment_vars[(sid1, soldier.id, r1)]
                        v_violation = ctx.model.NewBoolVar(f"bv_{soldier.id}_{sid1}_{pa.id}")
                        ctx.model.Add(v_assign <= v_violation)
                        ctx.cooldown_violations.append(v_violation)


def _add_unavailability_constraints(ctx, soldier):
    """Prevent assignment during the soldier's unavailability windows."""
    for sid in ctx.sorted_sids:
        s1 = ctx.shift_map[sid]
        for u in soldier.unavailabilities:
            if not (s1.end <= u.start_datetime or s1.start >= u.end_datetime):
                for r1 in range(ctx.role_count[sid]):
                    if (sid, soldier.id, r1) not in ctx.preassigned_pairs:
                        ctx.model.Add(ctx.assignment_vars[(sid, soldier.id, r1)] == 0)


def _add_intra_window_cooldowns(ctx, soldier):
    """Handle conflicts between two shifts within the current window.
    
    Direct overlaps are HARD constraints.
    Cooldown violations are SOFT constraints.
    """
    for i, sid1 in enumerate(ctx.sorted_sids):
        s1 = ctx.shift_map[sid1]
        cooldown_limit = s1.end + s1.post.cooldown
        for j in range(i + 1, len(ctx.sorted_sids)):
            sid2 = ctx.sorted_sids[j]
            s2 = ctx.shift_map[sid2]
            
            # 1. Direct Time Overlap (HARD)
            if s2.start < s1.end:
                for r1 in range(ctx.role_count[sid1]):
                    for r2 in range(ctx.role_count[sid2]):
                        if (sid1, soldier.id, r1) not in ctx.preassigned_pairs or (sid2, soldier.id, r2) not in ctx.preassigned_pairs:
                            ctx.model.Add(ctx.assignment_vars[(sid1, soldier.id, r1)] + ctx.assignment_vars[(sid2, soldier.id, r2)] <= 1)
            
            # 2. Cooldown Violation (SOFT)
            elif s2.start < cooldown_limit:
                v_violation = ctx.model.NewBoolVar(f"v_{soldier.id}_{sid1}_{sid2}")
                s1_vars = [ctx.assignment_vars[(sid1, soldier.id, r)] for r in range(ctx.role_count[sid1])]
                s2_vars = [ctx.assignment_vars[(sid2, soldier.id, r)] for r in range(ctx.role_count[sid2])]
                ctx.model.Add(sum(s1_vars) + sum(s2_vars) <= 1 + v_violation)
                ctx.cooldown_violations.append(v_violation)
            else:
                break

# ---------------------------------------------------------------------------
# Solver — step 5: daily spread (intra-day fairness)
# ---------------------------------------------------------------------------

def _add_daily_spread_terms(ctx: _SolverContext):
    """Penalize uneven shift distribution within each calendar day.

    Returns:
        daily_spreads: list of IntVars, one per day, representing the 
                       max-min shift count gap across soldiers for that day.
    """
    shifts_by_day = defaultdict(list)
    for sid, shift in ctx.shift_map.items():
        shifts_by_day[shift.start.date()].append(sid)
    
    daily_spreads = []
    max_daily_shifts = max(len(sids) for sids in shifts_by_day.values()) if shifts_by_day else 1

    for day_key, day_sids in shifts_by_day.items():
        day_counts = []
        for soldier in ctx.soldiers:
            cnt = ctx.model.NewIntVar(0, max_daily_shifts, f"dcnt_{soldier.id}_{day_key}")
            parts = []
            for sid in day_sids:
                for r in range(ctx.role_count[sid]):
                    parts.append(ctx.assignment_vars[(sid, soldier.id, r)])
            ctx.model.Add(cnt == sum(parts))
            day_counts.append(cnt)

        day_max = ctx.model.NewIntVar(0, max_daily_shifts, f"dmax_{day_key}")
        day_min = ctx.model.NewIntVar(0, max_daily_shifts, f"dmin_{day_key}")
        ctx.model.AddMaxEquality(day_max, day_counts)
        ctx.model.AddMinEquality(day_min, day_counts)
        day_spread = ctx.model.NewIntVar(0, max_daily_shifts, f"dspread_{day_key}")
        ctx.model.Add(day_spread == day_max - day_min)
        daily_spreads.append(day_spread)

    return daily_spreads

# ---------------------------------------------------------------------------
# Solver — step 6: rest-time optimization (spacing & rest-fairness)
# ---------------------------------------------------------------------------

REST_WINDOW_HOURS = 48

def _add_rest_optimization_terms(ctx: _SolverContext):
    """Maximize rest between consecutive shifts and ensure rest-fairness
    across soldiers.

    Creates per-soldier aggregate shift variables, proximity penalties,
    and minimum-rest tracking.

    Returns:
        overall_min_rest: IntVar — worst-case minimum rest across all soldiers.
        max_prox:         IntVar — highest per-soldier proximity penalty.
        min_rest_vars:    list of IntVars — per-soldier minimum rest gap.
        max_gap:          int   — upper bound used for min_rest scaling.
    """
    model = ctx.model

    # Per-soldier aggregate shift vars (is soldier assigned to this shift?)
    soldier_in_shift = {}
    for sid in ctx.shift_map:
        for soldier in ctx.soldiers:
            sv = model.NewBoolVar(f"sa_{sid}_{soldier.id}")
            model.Add(sv == sum(ctx.assignment_vars[(sid, soldier.id, r)] for r in range(ctx.role_count[sid])))
            soldier_in_shift[(sid, soldier.id)] = sv

    # Upper bound for rest gaps (tenths of hours)
    if len(ctx.sorted_sids) >= 2:
        max_gap = int((ctx.shift_map[ctx.sorted_sids[-1]].start - ctx.shift_map[ctx.sorted_sids[0]].end).total_seconds() / 360)
    else:
        max_gap = REST_WINDOW_HOURS * 10
    max_gap = max(max_gap, 1)

    min_rest_vars = []
    soldier_prox_penalties = []

    for soldier in ctx.soldiers:
        min_rest, prox_var = _build_soldier_rest_terms(
            ctx, soldier, soldier_in_shift, max_gap
        )
        min_rest_vars.append(min_rest)
        if prox_var is not None:
            soldier_prox_penalties.append(prox_var)

    # Overall min rest — worst-case across soldiers
    overall_min_rest = model.NewIntVar(0, max_gap, "overall_min_rest")
    if min_rest_vars:
        model.AddMinEquality(overall_min_rest, min_rest_vars)

    # Max per-soldier proximity — minimize for fair burden distribution
    prox_bound = REST_WINDOW_HOURS * 10 * len(ctx.sorted_sids)
    if soldier_prox_penalties:
        max_prox = model.NewIntVar(0, prox_bound, "max_prox")
        model.AddMaxEquality(max_prox, soldier_prox_penalties)
    else:
        max_prox = model.NewIntVar(0, 0, "max_prox")
    return overall_min_rest, max_prox, min_rest_vars, max_gap


def _build_soldier_rest_terms(ctx, soldier, soldier_in_shift, max_gap):
    """Build min-rest and proximity penalty terms for a single soldier.

    Returns:
        min_rest:  IntVar — minimum rest gap for this soldier (tenths of hours).
        prox_var:  IntVar or None — total proximity penalty for this soldier.
    """
    model = ctx.model
    min_rest = model.NewIntVar(0, max_gap, f"minrest_{soldier.id}")
    has_pair = False
    prox_parts = []

    for i in range(len(ctx.sorted_sids)):
        sid1 = ctx.sorted_sids[i]
        s1 = ctx.shift_map[sid1]

        for j in range(i + 1, len(ctx.sorted_sids)):
            sid2 = ctx.sorted_sids[j]
            s2 = ctx.shift_map[sid2]

            gap_seconds = (s2.start - s1.end).total_seconds()
            gap_hours = gap_seconds / 3600

            if gap_hours >= REST_WINDOW_HOURS:
                break
            if gap_seconds < 0:
                continue

            penalty = int((REST_WINDOW_HOURS - gap_hours) * 10)
            if penalty <= 0:
                continue

            # "Both shifts assigned to this soldier"
            both = model.NewBoolVar(f"both_{soldier.id}_{sid1}_{sid2}")
            sv1 = soldier_in_shift[(sid1, soldier.id)]
            sv2 = soldier_in_shift[(sid2, soldier.id)]
            model.AddBoolAnd([sv1, sv2]).OnlyEnforceIf(both)
            model.AddBoolOr([sv1.Not(), sv2.Not()]).OnlyEnforceIf(both.Not())

            prox_parts.append(both * penalty)

            gap_scaled = int(gap_seconds / 360)  # tenths of hours
            model.Add(min_rest <= gap_scaled).OnlyEnforceIf(both)
            has_pair = True

    if not has_pair:
        model.Add(min_rest == max_gap)

    prox_var = None
    if prox_parts:
        prox_var = model.NewIntVar(0, REST_WINDOW_HOURS * 10 * len(ctx.sorted_sids), f"prox_{soldier.id}")
        model.Add(prox_var == sum(prox_parts))

    return min_rest, prox_var

# ---------------------------------------------------------------------------
# Solver — step 7: multi-tier fairness objective
# ---------------------------------------------------------------------------

def _build_objective(ctx: _SolverContext, shifts, daily_spreads, overall_min_rest,
                     max_prox, min_rest_vars, max_gap, history_scores):
    """Assemble and register the multi-tier objective function.

    Priority hierarchy (each tier dominates the ones below):
      1. Minimize cooldown violations (soft but important)
      2. Minimize shift-count spread (count fairness)
      3. Minimize daily spread (intra-day fairness)
      4. Maximize overall min rest (rest-fairness)
      5. Maximize per-soldier min rest (push to true values)
      6. Minimize max per-soldier proximity (fair close-shift burden)
      7. Minimize sum-of-squared weighted loads (history-aware variance)
      (Note: "Fill all shifts" and "No direct overlaps" are hard constraints)
    """
    model = ctx.model

    # Shift-count spread
    shift_counts = []
    for soldier in ctx.soldiers:
        cnt = model.NewIntVar(0, len(shifts) * 3, f"cnt_{soldier.id}")
        parts = [ctx.assignment_vars[(sid, soldier.id, r)]
                 for sid in ctx.shift_map for r in range(ctx.role_count[sid])]
        model.Add(cnt == sum(parts))
        shift_counts.append(cnt)

    max_shifts_var = model.NewIntVar(0, len(shifts) * 3, "max_shifts")
    min_shifts_var = model.NewIntVar(0, len(shifts) * 3, "min_shifts")
    model.AddMaxEquality(max_shifts_var, shift_counts)
    model.AddMinEquality(min_shifts_var, shift_counts)
    spread = model.NewIntVar(0, len(shifts) * 3, "spread")
    model.Add(spread == max_shifts_var - min_shifts_var)

    # History-aware weighted loads
    min_history = min(history_scores.get(s.id, 0.0) for s in ctx.soldiers) if ctx.soldiers else 0.0
    loads = []
    for soldier in ctx.soldiers:
        load = model.NewIntVar(0, 10000000, f"load_{soldier.id}")
        work_parts = []
        for sid, shift in ctx.shift_map.items():
            val = int((shift.end - shift.start).total_seconds() / 3600 * shift.post.intensity_weight * 10)
            for r in range(ctx.role_count[sid]):
                work_parts.append(ctx.assignment_vars[(sid, soldier.id, r)] * val)
        normalized_history = int((history_scores.get(soldier.id, 0.0) - min_history) * 10)
        model.Add(load == normalized_history + sum(work_parts))
        loads.append(load)

    sum_load_sq = []
    for soldier, load in zip(ctx.soldiers, loads):
        load_sq = model.NewIntVar(0, 10000000000, f"load_sq_{soldier.id}")
        model.AddMultiplicationEquality(load_sq, [load, load])
        sum_load_sq.append(load_sq)

    # Dynamic weight scaling — ensures each tier strictly dominates the next
    n = max(len(ctx.soldiers), 1)
    g = max(max_gap, 1)

    MIN_REST_WEIGHT = 100
    OVERALL_REST_W  = 1000
    MAX_PROX_WEIGHT = 50

    max_rest_contribution = (n * g * MIN_REST_WEIGHT
                             + g * OVERALL_REST_W
                             + REST_WINDOW_HOURS * 10 * len(ctx.sorted_sids) * MAX_PROX_WEIGHT)
    DAILY_SPREAD_W = max_rest_contribution + 1
    SPREAD_WEIGHT  = DAILY_SPREAD_W * (len(shifts) + 1)
    
    COOLDOWN_WEIGHT = SPREAD_WEIGHT * (len(shifts) + 1)

    # Assemble weighted terms
    total_cooldown_violations = sum(ctx.cooldown_violations)
    obj_terms = [total_cooldown_violations, spread, max_prox, overall_min_rest] + daily_spreads + min_rest_vars + sum_load_sq
    obj_weights = (
        [-COOLDOWN_WEIGHT, -SPREAD_WEIGHT, -MAX_PROX_WEIGHT, OVERALL_REST_W]
        + [-DAILY_SPREAD_W] * len(daily_spreads)
        + [MIN_REST_WEIGHT] * len(min_rest_vars)
        + [-1] * len(sum_load_sq)
    )
    model.Maximize(cp_model.LinearExpr.WeightedSum(obj_terms, obj_weights))

# ---------------------------------------------------------------------------
# Solver — step 8: extract and log results
# ---------------------------------------------------------------------------

def _extract_results(solver, ctx: _SolverContext):
    """Read the solved assignment values and build Assignment objects.
    Also logs fairness and rest statistics."""
    results = []
    for sid, shift in ctx.shift_map.items():
        for soldier in ctx.soldiers:
            for r in range(ctx.role_count[sid]):
                if solver.Value(ctx.assignment_vars[(sid, soldier.id, r)]):
                    results.append(Assignment(
                        soldier=soldier, soldier_id=soldier.id,
                        shift=shift, shift_id=shift.id, role_id=r
                    ))

    _log_fairness_stats(results, ctx.soldiers)
    _log_rest_stats(results)

    logger.info(f"Found {len(results)} assignments.")
    return results


def _log_fairness_stats(results, soldiers):
    """Log shift-count distribution across soldiers."""
    final_counts = defaultdict(int)
    for a in results:
        final_counts[a.soldier_id] += 1
    if final_counts:
        counts = list(final_counts.values())
        idle = len(soldiers) - len(final_counts)
        logger.info(f"Fairness stats: assigned={len(final_counts)}/{len(soldiers)} soldiers, "
                    f"shifts/soldier: min={min(counts)}, max={max(counts)}, "
                    f"idle={idle}, spread={max(counts)-min(counts) if counts else 0}")


def _log_rest_stats(results):
    """Log minimum rest gap statistics per soldier."""
    soldier_shifts = defaultdict(list)
    for a in results:
        soldier_shifts[a.soldier_id].append(a.shift)
    rest_gaps = {}
    for s_id, s_shifts in soldier_shifts.items():
        sorted_s = sorted(s_shifts, key=lambda x: x.start)
        if len(sorted_s) >= 2:
            gaps = [(sorted_s[i+1].start - sorted_s[i].end).total_seconds() / 3600
                    for i in range(len(sorted_s) - 1)]
            rest_gaps[s_id] = min(gaps)
        else:
            rest_gaps[s_id] = float('inf')
    finite_rests = [v for v in rest_gaps.values() if v != float('inf')]
    if finite_rests:
        logger.info(f"Rest stats: min_rest={min(finite_rests):.1f}h, "
                    f"max_min_rest={max(finite_rests):.1f}h, "
                    f"avg_min_rest={sum(finite_rests)/len(finite_rests):.1f}h")

# ---------------------------------------------------------------------------
# Public API — main solver entry point
# ---------------------------------------------------------------------------

def solve_shift_assignment(shifts: List[Shift], soldiers: List[Soldier],
                           history_scores: Optional[dict] = None,
                           existing_assignments: Optional[List[Assignment]] = None):
    """Assign soldiers to shifts using constraint optimization.

    Optimises for:
      - Filling all roles
      - Fair shift-count distribution
      - Daily spread evenness
      - Maximised and fair rest between shifts
      - History-aware load balancing
    """
    if not shifts or not soldiers:
        logger.warning("No shifts or soldiers provided to solver.")
        return []

    if history_scores is None:
        history_scores = {s.id: 0.0 for s in soldiers}
    if existing_assignments is None:
        existing_assignments = []

    # --- Build model ---
    model = cp_model.CpModel()
    shift_map, role_count = _build_shift_map(shifts)

    logger.info(f"Building model: {len(shifts)} shifts, {len(soldiers)} soldiers.")

    assignment_vars, filled_role_vars = _create_decision_variables(model, shift_map, role_count, soldiers)

    ctx = _SolverContext(model, shift_map, role_count, soldiers, assignment_vars, filled_role_vars)

    # --- Add constraints ---
    _add_skill_constraints(ctx)

    boundary_assignments = _process_existing_assignments(ctx, existing_assignments)

    _add_temporal_constraints(ctx, boundary_assignments)

    # --- Build objective components ---
    daily_spreads = _add_daily_spread_terms(ctx)

    overall_min_rest, max_prox, min_rest_vars, max_gap = _add_rest_optimization_terms(ctx)

    _build_objective(ctx, shifts, daily_spreads, overall_min_rest,
                     max_prox, min_rest_vars, max_gap, history_scores)

    # --- Solve ---
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 30.0
    status = solver.Solve(model)
    logger.info(f"Solver finished: {solver.StatusName(status)}")

    if status in [cp_model.OPTIMAL, cp_model.FEASIBLE]:
        return _extract_results(solver, ctx)

    if status == cp_model.INFEASIBLE:
        logger.error("Solver status: INFEASIBLE. Hard constraint 'fill all shifts' cannot be met.")
    else:
        logger.warning(f"Solver status: {solver.StatusName(status)}. No solution found.")

    return []

def solve_shift_assignment_greedy(shifts: List[Shift], soldiers: List[Soldier],
                                  history_scores: Optional[dict] = None,
                                  existing_assignments: Optional[List[Assignment]] = None,
                                  session: Optional[ShavtzachiDB] = None):
    """
    Assign soldiers to shifts using a greedy algorithm.
    Orders shifts by rarest qualifications and longest duration.
    """
    if not shifts or not soldiers:
        logger.warning("No shifts or soldiers provided to greedy solver.")
        return []

    if history_scores is None:
        history_scores = {s.id: 0.0 for s in soldiers}
    
    # 1. Calculate Skill Demand (Sustainment)
    # Only consider posts from the shifts being assigned
    active_posts = list({s.post for s in shifts if s.post and s.post.is_active})
    demand_by_skill = defaultdict(float)
    
    for post in active_posts:
        l = post.shift_length.total_seconds() / 3600
        c = post.cooldown.total_seconds() / 3600
        if l == 0: l = 1.0 # Prevent division by zero
        sustain_ratio = (l + c) / l
        
        # Calculate active hours per day
        if post.start_time < post.end_time:
            active_hours = (datetime.combine(datetime.min, post.end_time) - datetime.combine(datetime.min, post.start_time)).total_seconds() / 3600
        else:
            active_hours = 24 - (datetime.combine(datetime.min, post.start_time) - datetime.combine(datetime.min, post.end_time)).total_seconds() / 3600
            
        active_ratio = active_hours / 24.0
        post_demand = sustain_ratio * active_ratio
        
        for slot in post.slots:
            demand_by_skill[slot.skill.name] += post_demand

    # 2. Calculate Skill Supply
    supply_by_skill = defaultdict(int)
    for s in soldiers:
        for sk in s.skills:
            supply_by_skill[sk.name] += 1
            
    # 3. Calculate Criticality (Demand / Supply)
    criticality = {}
    all_needed_skills = set(demand_by_skill.keys())
    for sk_name in all_needed_skills:
        supply = supply_by_skill.get(sk_name, 0)
        demand = demand_by_skill[sk_name]
        if supply == 0:
            criticality[sk_name] = 9999.0 # Very high criticality for unfillable roles
        else:
            criticality[sk_name] = demand / supply

    def get_shift_rarity(shift):
        if not shift.post.slots:
            return 0.0
        # Rarity is the maximum criticality among its requested skills
        return max(criticality.get(slot.skill.name, 0.0) for slot in shift.post.slots)

    # 4. Sort Shifts
    # Higher criticality (rarity) first, then longer shifts.
    sorted_shifts = sorted(shifts, key=lambda s: (get_shift_rarity(s), (s.end - s.start).total_seconds()), reverse=True)

    draft_assignments = []
    if existing_assignments:
        for a in existing_assignments:
            draft_assignments.append({
                "soldier_id": a.soldier_id,
                "start": a.shift.start,
                "end": a.shift.end,
                "post_name": a.shift.post_name,
                "role_id": a.role_id,
                "post": a.shift.post
            })

    results = []
    
    # db is now used directly via session parameter

    logger.info(f"Greedy Solver: Processing {len(shifts)} shifts for {len(soldiers)} soldiers.")

    for shift in sorted_shifts:
        # For each slot in the shift (ordered by role_index)
        for slot in sorted(shift.post.slots, key=lambda x: x.role_index):
            role_id = slot.role_index
            
            best_soldier = None
            best_score = -float('inf')
            
            for soldier in soldiers:
                score, conflicts, _, _ = evaluate_soldier_fitness(
                    soldier, shift.start, shift.end, shift.post, role_id,
                    history_scores, session, draft_assignments
                )
                
                # Hard constraints
                if any(c in conflicts for c in ["occupied", "unavailable", "skill_mismatch"]):
                    continue
                
                if score > best_score:
                    best_score = score
                    best_soldier = soldier
            
            if best_soldier:
                assignment = Assignment(
                    soldier=best_soldier, soldier_id=best_soldier.id,
                    shift=shift, shift_id=shift.id, role_id=role_id
                )
                results.append(assignment)
                draft_assignments.append({
                    "soldier_id": best_soldier.id,
                    "start": shift.start,
                    "end": shift.end,
                    "post_name": shift.post_name,
                    "role_id": role_id,
                    "post": shift.post
                })
            else:
                logger.warning(f"Greedy Solver: Could not find any fitting soldier for {shift.post_name} at {shift.start}")

    _log_fairness_stats(results, soldiers)
    _log_rest_stats(results)
    
    logger.info(f"Greedy Solver: Found {len(results)} assignments.")
    return results

def evaluate_soldier_fitness(soldier: Soldier, shift_start: datetime, shift_end: datetime, post: Post, role_id: int, history_scores: Dict[int, float], session: ShavtzachiDB, draft_assignments: List[dict] = None):
    """
    Evaluates how fitting a soldier is for a specific shift.
    Considers both database assignments and provided draft assignments.
    Returns (score, conflicts, last_shift_info, next_shift_info).
    """
    score = 0
    conflicts = []
    
    # Normalize datetimes
    if shift_start.tzinfo: shift_start = shift_start.replace(tzinfo=None)
    if shift_end.tzinfo: shift_end = shift_end.replace(tzinfo=None)

    # 1. Skill mismatch
    required_skill = None
    if post.slots:
        # Find the specific slot for this role_id
        slot = next((s for s in post.slots if s.role_index == role_id), None)
        if slot:
            required_skill = slot.skill.name
        
    soldier_skills = {s.name for s in soldier.skills}
    if required_skill and required_skill not in soldier_skills:
        score -= 1000
        conflicts.append("skill_mismatch")
    else:
        score += 100 # Match bonus
        
    # 2. Overlap, Cooldown & Diversity
    # Diversity window is 30 days back/forward.
    window_start = shift_start - timedelta(days=30)
    window_end = shift_end + timedelta(days=30)
    
    # Collect assignments from DB
    combined_assignments = []
    db_assignments = session.session.query(Assignment).join(Shift).filter(
        Assignment.soldier_id == soldier.id,
        Shift.start < window_end,
        Shift.end > window_start
    ).all()
    
    for a in db_assignments:
        combined_assignments.append({
            "start": a.shift.start,
            "end": a.shift.end,
            "post_name": a.shift.post_name,
            "role_id": a.role_id,
            "post": a.shift.post
        })

    # Add draft assignments (filtering for this soldier and window)
    if draft_assignments:
        # Pre-fetch posts for draft lookups
        post_cache = {p.name: p for p in session.get_all_posts(include_slots=False)}
        for a in draft_assignments:
            if a.get("soldier_id") == soldier.id:
                a_start = a["start"] if isinstance(a["start"], datetime) else datetime.fromisoformat(a["start"].replace('Z', ''))
                a_end = a["end"] if isinstance(a["end"], datetime) else datetime.fromisoformat(a["end"].replace('Z', ''))
                
                if a_start < window_end and a_end > window_start:
                    combined_assignments.append({
                        "start": a_start,
                        "end": a_end,
                        "post_name": a["post_name"],
                        "role_id": a["role_id"],
                        "post": post_cache.get(a["post_name"])
                    })
    
    last_shift_info_obj = None 
    next_shift_info_obj = None 
    
    for a in combined_assignments:
        other_start = a["start"]
        other_end = a["end"]
        
        # Exact overlap
        if shift_start < other_end and other_start < shift_end:
            if a["post_name"] == post.name and other_start == shift_start and a["role_id"] == role_id:
                continue
            score -= 2000
            conflicts.append("occupied")
            
        # Cooldown Check - Before
        if other_end <= shift_start:
            gap = (shift_start - other_end).total_seconds() / 3600
            cooldown_needed = post.cooldown.total_seconds() / 3600
            if gap < cooldown_needed:
                score -= 500
                conflicts.append("cooldown")
            
            # Mission Diversity (Decay over 30 days)
            if a["post_name"] == post.name:
                days_since = (shift_start - other_end).total_seconds() / (24 * 3600)
                if days_since < 30:
                    decay_weight = 1.0 - (days_since / 30.0)
                    score -= 30 * decay_weight
            
            # Keep track of last shift
            if last_shift_info_obj is None or other_end > last_shift_info_obj["end"]:
                last_shift_info_obj = a
                
        # Cooldown Check - After
        elif other_start >= shift_end:
            gap = (other_start - shift_end).total_seconds() / 3600
            other_post = a["post"]
            cooldown_needed = other_post.cooldown.total_seconds() / 3600 if other_post else 0
            if gap < cooldown_needed:
                score -= 500
                conflicts.append("cooldown")

            # Mission Diversity (Future)
            if a["post_name"] == post.name:
                days_until = (other_start - shift_end).total_seconds() / (24 * 3600)
                if days_until < 30:
                    decay_weight = 1.0 - (days_until / 30.0)
                    score -= 30 * decay_weight
            
            # Keep track of next shift
            if next_shift_info_obj is None or other_start < next_shift_info_obj["start"]:
                next_shift_info_obj = a

    # 3. Unavailability
    for u in soldier.unavailabilities:
        if shift_start < u.end_datetime and u.start_datetime < shift_end:
            score -= 2000
            conflicts.append("unavailable")
            
    # 4. Fairness (History Score) - currently commented out in original
    # h_score = history_scores.get(soldier.id, 0.0)
    # score -= h_score * 5 
    
    # 5. Rest bonus
    if last_shift_info_obj:
        intensity = last_shift_info_obj["post"].intensity_weight if last_shift_info_obj["post"] else 1.0
        rest_hours = (shift_start - last_shift_info_obj["end"]).total_seconds() / 3600
        score += min(rest_hours, 168) * (5/intensity) 
    else:
        score += 168 * 2.5
        
    if next_shift_info_obj:
        intensity = post.intensity_weight 
        rest_hours = (next_shift_info_obj["start"] - shift_end).total_seconds() / 3600
        score += min(rest_hours, 168) * (5/intensity)
    else:
        score += 168 * 2.5
        
    last_shift_info = None
    if last_shift_info_obj:
        last_shift_info = {
            "end": last_shift_info_obj["end"].isoformat(),
            "post_name": last_shift_info_obj["post_name"]
        }
        
    next_shift_info = None
    if next_shift_info_obj:
        next_shift_info = {
            "start": next_shift_info_obj["start"].isoformat(),
            "post_name": next_shift_info_obj["post_name"]
        }
        
    return score, list(set(conflicts)), last_shift_info, next_shift_info

