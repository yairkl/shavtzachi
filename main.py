from fastapi import FastAPI, Depends, HTTPException, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import func
from database import engine, Session as DBSession
from models import Soldier, Post, Shift, Assignment, Skill, PostTemplateSlot, Unavailability
from schedule import generate_shifts, solve_shift_assignment
from pydantic import BaseModel, field_validator
from typing import List, Optional
from datetime import datetime, timedelta
import csv
import io
import logging
from collections import defaultdict

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Shavtzachi API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_db():
    db = DBSession()
    try:
        yield db
    finally:
        db.close()

# --- Pydantic Schemas ---

class SoldierCreate(BaseModel):
    name: str
    skills: List[str]
    division: Optional[int] = None

class PostCreate(BaseModel):
    name: str
    shift_length_hours: int
    start_time: str
    end_time: str
    cooldown_hours: int
    intensity_weight: float
    slots: List[str]
    is_active: bool = True

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

def get_history_scores(db: Session, exclude_from: Optional[datetime] = None):
    # Calculate sum of (end - start) * intensity_weight for each soldier
    # SQLite logic: (julianday(end) - julianday(start)) * 24 gives hours
    # We query all assignments joined with shifts and posts
    query = db.query(
        Assignment.soldier_id,
        func.sum(
            (func.julianday(Shift.end) - func.julianday(Shift.start)) * 24 * Post.intensity_weight
        )
    ).join(Shift, Assignment.shift_id == Shift.id)\
     .join(Post, Shift.post_name == Post.name)
     
    if exclude_from:
        # Avoid double-counting assignments inside the new draft window
        query = query.filter(Shift.start < exclude_from.replace(tzinfo=None))
        
    res = query.group_by(Assignment.soldier_id).all()
    
    return {r[0]: float(r[1]) if r[1] else 0.0 for r in res}

# --- Endpoints: Personnel ---

@app.get("/skills")
def get_all_skills(db: Session = Depends(get_db)):
    skills = db.query(Skill).all()
    return [s.name for s in skills]

@app.get("/soldiers")
def get_soldiers(db: Session = Depends(get_db)):
    soldiers = db.query(Soldier).options(joinedload(Soldier.skills)).all()
    scores = get_history_scores(db)
    return [{"id": s.id, "name": s.name, "history_score": scores.get(s.id, 0.0), "skills": [sk.name for sk in s.skills], "division": s.division} for s in soldiers]

@app.post("/soldiers")
def create_soldier(s_data: SoldierCreate, db: Session = Depends(get_db)):
    soldier = Soldier(name=s_data.name, division=s_data.division)
    for sk_name in s_data.skills:
        skill = db.query(Skill).filter(Skill.name == sk_name).first()
        if not skill: skill = Skill(name=sk_name); db.add(skill)
        soldier.skills.append(skill)
    db.add(soldier)
    db.commit(); db.refresh(soldier)
    return soldier

@app.put("/soldiers/{s_id}")
def update_soldier(s_id: int, s_data: SoldierCreate, db: Session = Depends(get_db)):
    soldier = db.query(Soldier).filter(Soldier.id == s_id).first()
    if not soldier: raise HTTPException(status_code=404, detail="Soldier not found")
    soldier.name = s_data.name
    soldier.division = s_data.division
    soldier.skills = []
    for sk_name in s_data.skills:
        skill = db.query(Skill).filter(Skill.name == sk_name).first()
        if not skill: skill = Skill(name=sk_name); db.add(skill)
        soldier.skills.append(skill)
    db.commit()
    return {"status": "success"}

@app.delete("/soldiers/{s_id}")
def delete_soldier(s_id: int, db: Session = Depends(get_db)):
    soldier = db.query(Soldier).filter(Soldier.id == s_id).first()
    if not soldier: raise HTTPException(status_code=404, detail="Soldier not found")
    db.delete(soldier)
    db.commit()
    return {"status": "success"}

# --- Endpoints: Posts ---

@app.get("/posts")
def get_posts(db: Session = Depends(get_db)):
    posts = db.query(Post).options(joinedload(Post.slots).joinedload(PostTemplateSlot.skill)).all()
    return [{
        "name": p.name,
        "shift_length_hours": p.shift_length.total_seconds() / 3600,
        "start_time": p.start_time.strftime("%H:%M"),
        "end_time": p.end_time.strftime("%H:%M"),
        "cooldown_hours": p.cooldown.total_seconds() / 3600,
        "intensity_weight": p.intensity_weight,
        "is_active": bool(p.is_active),
        "slots": [{"role_index": s.role_index, "skill": s.skill.name} for s in p.slots]
    } for p in posts]

@app.post("/posts")
def create_post(p_data: PostCreate, db: Session = Depends(get_db)):
    post = Post(
        name=p_data.name,
        shift_length=timedelta(hours=p_data.shift_length_hours),
        start_time=datetime.strptime(p_data.start_time, "%H:%M").time(),
        end_time=datetime.strptime(p_data.end_time, "%H:%M").time(),
        cooldown=timedelta(hours=p_data.cooldown_hours),
        intensity_weight=p_data.intensity_weight,
        is_active=1 if p_data.is_active else 0
    )
    for i, sk_name in enumerate(p_data.slots):
        skill = db.query(Skill).filter(Skill.name == sk_name).first()
        if not skill: skill = Skill(name=sk_name); db.add(skill)
        db.add(PostTemplateSlot(post=post, role_index=i, skill=skill))
    db.add(post); db.commit()
    return {"status": "success"}

@app.put("/posts/{name}")
def update_post(name: str, p_data: PostCreate, db: Session = Depends(get_db)):
    post = db.query(Post).filter(Post.name == name).first()
    if not post: raise HTTPException(status_code=404, detail="Post not found")
    post.shift_length = timedelta(hours=p_data.shift_length_hours)
    post.start_time = datetime.strptime(p_data.start_time, "%H:%M").time()
    post.end_time = datetime.strptime(p_data.end_time, "%H:%M").time()
    post.cooldown = timedelta(hours=p_data.cooldown_hours)
    post.intensity_weight = p_data.intensity_weight
    post.is_active = 1 if p_data.is_active else 0
    db.query(PostTemplateSlot).filter(PostTemplateSlot.post_name == name).delete()
    for i, sk_name in enumerate(p_data.slots):
        skill = db.query(Skill).filter(Skill.name == sk_name).first()
        if not skill: skill = Skill(name=sk_name); db.add(skill)
        db.add(PostTemplateSlot(post=post, role_index=i, skill=skill))
    db.commit()
    return {"status": "success"}

@app.delete("/posts/{name}")
def delete_post(name: str, db: Session = Depends(get_db)):
    post = db.query(Post).filter(Post.name == name).first()
    if not post: raise HTTPException(status_code=404, detail="Post not found")
    db.delete(post); db.commit()
    return {"status": "success"}

# --- CSV Endpoints ---

@app.get("/soldiers/export")
def export_soldiers(db: Session = Depends(get_db)):
    output = io.StringIO()
    writer = csv.writer(output)
    scores = get_history_scores(db)
    writer.writerow(["name", "division", "skills", "history_score"])
    for s in db.query(Soldier).options(joinedload(Soldier.skills)).all():
        writer.writerow([s.name, s.division, ",".join([sk.name for sk in s.skills]), scores.get(s.id, 0.0)])
    output.seek(0)
    return StreamingResponse(output, media_type="text/csv", headers={"Content-Disposition": "attachment; filename=soldiers.csv"})

@app.post("/soldiers/import")
async def import_soldiers(file: UploadFile = File(...), db: Session = Depends(get_db)):
    content = await file.read()
    reader = csv.DictReader(io.StringIO(content.decode("utf-8")))
    for row in reader:
        soldier = db.query(Soldier).filter(Soldier.name == row["name"]).first()
        if not soldier:
            soldier = Soldier(name=row["name"])
            db.add(soldier)
        soldier.division = int(row["division"]) if row["division"] else None
        soldier.skills = []
        for sk_name in row["skills"].split(","):
            if not sk_name.strip(): continue
            skill = db.query(Skill).filter(Skill.name == sk_name.strip()).first()
            if not skill: skill = Skill(name=sk_name.strip()); db.add(skill)
            soldier.skills.append(skill)
    db.commit()
    return {"status": "success"}

@app.get("/posts/export")
def export_posts(db: Session = Depends(get_db)):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["name", "shift_length_hours", "start_time", "end_time", "cooldown_hours", "intensity_weight", "slots"])
    for p in db.query(Post).options(joinedload(Post.slots).joinedload(PostTemplateSlot.skill)).all():
        slots = ",".join([s.skill.name for s in sorted(p.slots, key=lambda x: x.role_index)])
        writer.writerow([p.name, p.shift_length.total_seconds()/3600, p.start_time.strftime("%H:%M"), p.end_time.strftime("%H:%M"), p.cooldown.total_seconds()/3600, p.intensity_weight, slots])
    output.seek(0)
    return StreamingResponse(output, media_type="text/csv", headers={"Content-Disposition": "attachment; filename=posts.csv"})

@app.post("/posts/import")
async def import_posts(file: UploadFile = File(...), db: Session = Depends(get_db)):
    content = await file.read()
    reader = csv.DictReader(io.StringIO(content.decode("utf-8")))
    for row in reader:
        post = db.query(Post).filter(Post.name == row["name"]).first()
        if not post:
            post = Post(name=row["name"])
            db.add(post)
        post.shift_length = timedelta(hours=float(row["shift_length_hours"]))
        post.start_time = datetime.strptime(row["start_time"], "%H:%M").time()
        post.end_time = datetime.strptime(row["end_time"], "%H:%M").time()
        post.cooldown = timedelta(hours=float(row["cooldown_hours"]))
        post.intensity_weight = float(row["intensity_weight"])
        db.query(PostTemplateSlot).filter(PostTemplateSlot.post_name == post.name).delete()
        for i, sk_name in enumerate(row["slots"].split(",")):
            if not sk_name.strip(): continue
            skill = db.query(Skill).filter(Skill.name == sk_name.strip()).first()
            if not skill: skill = Skill(name=sk_name.strip()); db.add(skill)
            db.add(PostTemplateSlot(post=post, role_index=i, skill=skill))
    db.commit()
    return {"status": "success"}

# --- Endpoints: Scheduler ---

@app.get("/schedule/shifts")
def get_shifts_with_assignments(start_date: datetime, end_date: datetime, db: Session = Depends(get_db)):
    """Return every shift slot (filled or empty) for the given date range.
    
    Each slot is a combination of (shift × role). If an assignment exists for
    that slot, soldier_id / soldier_name are populated; otherwise they are null.
    """
    try:
        start_naive = start_date.replace(tzinfo=None)
        end_naive = end_date.replace(tzinfo=None)

        # Generate all shifts from active posts
        posts = db.query(Post).filter(Post.is_active == 1).options(
            joinedload(Post.slots).joinedload(PostTemplateSlot.skill)
        ).all()
        shifts = generate_shifts(posts, start_naive, end_naive, session=db)

        # Fetch existing assignments in this range
        assignments = db.query(Assignment).join(Shift).filter(
            Shift.start < end_naive,
            Shift.end > start_naive
        ).options(
            joinedload(Assignment.soldier),
            joinedload(Assignment.shift).joinedload(Shift.post)
        ).all()

        # Build lookup: (post_name, start_iso, role_id) -> assignment
        assignment_lookup = {}
        for a in assignments:
            key = (a.shift.post_name, a.shift.start.replace(microsecond=0).isoformat(), a.role_id)
            assignment_lookup[key] = a

        # Produce one entry per (shift × role)
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
        return result
    except Exception as e:
        logger.error(f"Get shifts error: {e}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/schedule/candidates", response_model=List[CandidateResponse])
def get_candidates(post_name: str, start: datetime, end: datetime, role_id: int, db: Session = Depends(get_db)):
    try:
        # Normalize datetimes
        start_naive = start.replace(tzinfo=None)
        end_naive = end.replace(tzinfo=None)
        
        post = db.query(Post).filter(Post.name == post_name).options(
            joinedload(Post.slots).joinedload(PostTemplateSlot.skill)
        ).first()
        if not post: raise HTTPException(status_code=404, detail="Post not found")
        
        soldiers = db.query(Soldier).options(
            joinedload(Soldier.skills), 
            joinedload(Soldier.unavailabilities)
        ).all()
        
        history_scores = get_history_scores(db, exclude_from=start)
        
        from schedule import evaluate_soldier_fitness
        
        results = []
        for s in soldiers:
            score, conflicts, last_shift = evaluate_soldier_fitness(s, start_naive, end_naive, post, role_id, history_scores, db)
            results.append({
                "id": s.id,
                "name": s.name,
                "fitness_score": score,
                "conflicts": conflicts,
                "last_shift": last_shift
            })
            
        # Sort by fitness score descending
        results.sort(key=lambda x: x["fitness_score"], reverse=True)
        return results
    except Exception as e:
        logger.error(f"Get candidates error: {e}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/schedule")
def get_schedule(start_date: datetime, end_date: datetime, db: Session = Depends(get_db)):
    try:
        start_naive = start_date.replace(tzinfo=None)
        end_naive = end_date.replace(tzinfo=None)
        
        assignments = db.query(Assignment).join(Shift).filter(
            Shift.start < end_naive,
            Shift.end > start_naive
        ).options(joinedload(Assignment.soldier), joinedload(Assignment.shift).joinedload(Shift.post)).all()
        
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

@app.post("/schedule/draft")
def draft_schedule(req: DraftRequest, db: Session = Depends(get_db)):
    try:
        # Only draft for active posts
        soldiers = db.query(Soldier).options(joinedload(Soldier.skills), joinedload(Soldier.unavailabilities)).all()
        posts = db.query(Post).filter(Post.is_active == 1).options(joinedload(Post.slots).joinedload(PostTemplateSlot.skill)).all()
        
        # Normalize to naive datetimes
        start_naive = req.start_date.replace(tzinfo=None)
        end_naive = req.end_date.replace(tzinfo=None)
        
        shifts = generate_shifts(posts, start_naive, end_naive, session=None)
        
        # Get dynamic history scores strictly prior to the drafting window
        history_scores = get_history_scores(db, exclude_from=req.start_date)
            
        # Consider a cooldown lookback of up to 7 days, evaluating everything up until window end 
        lookback_date = start_naive - timedelta(days=7)
        existing_assignments = db.query(Assignment).join(Shift).filter(
            Shift.start >= lookback_date,
            Shift.start < end_naive
        ).options(
            joinedload(Assignment.shift).joinedload(Shift.post),
            joinedload(Assignment.soldier)
        ).all()
            
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
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.error(f"Draft error: {str(e)}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/schedule/save")
def save_schedule(req: SaveScheduleRequest, db: Session = Depends(get_db)):
    try:
        start_naive = req.start_date.replace(tzinfo=None)
        end_naive = req.end_date.replace(tzinfo=None)

        # Clear existing assignments in this range
        shifts_to_clear = db.query(Shift.id).filter(Shift.start < end_naive, Shift.end > start_naive).all()
        shift_ids = [s[0] for s in shifts_to_clear]
        if shift_ids:
            db.query(Assignment).filter(Assignment.shift_id.in_(shift_ids)).delete(synchronize_session=False)

        # Ensure shifts exist for this range
        posts = db.query(Post).all()
        all_shifts = generate_shifts(posts, start_naive, end_naive, session=db)
        # Build map for quick lookup: (post_name, start_iso) -> shift_id
        # Truncate microseconds for consistent lookup
        shift_lookup = {(s.post_name, s.start.replace(microsecond=0).isoformat()): s.id for s in all_shifts}

        # Create new assignments from the request
        for a_data in req.assignments:
            start_iso = a_data.start.replace(tzinfo=None, microsecond=0).isoformat()
            sid = shift_lookup.get((a_data.post_name, start_iso))
            if sid:
                db.add(Assignment(soldier_id=a_data.soldier_id, shift_id=sid, role_id=a_data.role_id))
            else:
                logger.warning(f"Could not find shift for {a_data.post_name} at {start_iso}")
        
        db.commit()
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Save schedule error: {str(e)}")
        import traceback; traceback.print_exc()
        db.rollback(); 
        raise HTTPException(status_code=500, detail=str(e))

# --- Endpoints: Unavailability ---

@app.get("/unavailabilities", response_model=List[UnavailabilityResponse])
def get_unavailabilities(db: Session = Depends(get_db)):
    records = db.query(Unavailability).options(joinedload(Unavailability.soldier)).all()
    return [{
        "id": r.id,
        "soldier_id": r.soldier_id,
        "soldier_name": r.soldier.name,
        "start_datetime": r.start_datetime,
        "end_datetime": r.end_datetime,
        "reason": r.reason
    } for r in records]

@app.post("/unavailabilities")
def create_unavailability(u_data: UnavailabilityCreate, db: Session = Depends(get_db)):
    # Check for overlapping unavailability for the same soldier
    existing = db.query(Unavailability).filter(
        Unavailability.soldier_id == u_data.soldier_id,
        Unavailability.start_datetime < u_data.end_datetime.replace(tzinfo=None),
        Unavailability.end_datetime > u_data.start_datetime.replace(tzinfo=None)
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Overlapping unavailability exists for this soldier")
        
    record = Unavailability(
        soldier_id=u_data.soldier_id,
        start_datetime=u_data.start_datetime.replace(tzinfo=None),
        end_datetime=u_data.end_datetime.replace(tzinfo=None),
        reason=u_data.reason
    )
    db.add(record)
    db.commit()
    return {"status": "success", "id": record.id}

@app.put("/unavailabilities/{u_id}")
def update_unavailability(u_id: int, u_data: UnavailabilityCreate, db: Session = Depends(get_db)):
    record = db.query(Unavailability).filter(Unavailability.id == u_id).first()
    if not record: raise HTTPException(status_code=404, detail="Unavailability not found")
    
    record.soldier_id = u_data.soldier_id
    record.start_datetime = u_data.start_datetime.replace(tzinfo=None)
    record.end_datetime = u_data.end_datetime.replace(tzinfo=None)
    record.reason = u_data.reason
    db.commit()
    return {"status": "success"}

@app.delete("/unavailabilities/{u_id}")
def delete_unavailability(u_id: int, db: Session = Depends(get_db)):
    record = db.query(Unavailability).filter(Unavailability.id == u_id).first()
    if not record: raise HTTPException(status_code=404, detail="Unavailability not found")
    db.delete(record)
    db.commit()
    return {"status": "success"}

@app.get("/unavailabilities/check-manpower")
def check_manpower(start_date: datetime, end_date: datetime, db: Session = Depends(get_db)):
    try:
        start_naive = start_date.replace(tzinfo=None)
        end_naive = end_date.replace(tzinfo=None)
        
        # 1. Sustainability: How many soldiers of each skill do we need to sustain all posts?
        # Only consider active posts for manpower checking
        posts = db.query(Post).filter(Post.is_active == 1).options(joinedload(Post.slots).joinedload(PostTemplateSlot.skill)).all()
        required_by_skill = defaultdict(float)
        
        for post in posts:
            # (L + C) / L is the number of soldiers needed to cover one slot 24/7
            l = post.shift_length.total_seconds() / 3600
            c = post.cooldown.total_seconds() / 3600
            ratio = (l + c) / l
            
            # Adjust ratio if post is not 24/7
            # Calculate active hours per day
            if post.start_time < post.end_time:
                active_hours = (datetime.combine(datetime.min, post.end_time) - datetime.combine(datetime.min, post.start_time)).total_seconds() / 3600
            else:
                active_hours = 24 - (datetime.combine(datetime.min, post.start_time) - datetime.combine(datetime.min, post.end_time)).total_seconds() / 3600
            
            # The sustain ratio for a non-24/7 post is slightly different.
            # If active 8h, shift 4h, cooldown 8h. 
            # Needs 2 soldiers (one for first shift, one for second shift because of cooldown).
            # Heuristic: ceil( (ActiveHours + Cooldown) / (ShiftLength + Cooldown) ) * slots? No.
            # Let's stick to the 24/7 ratio as a baseline for "sustainable personnel" but scale it by active_hours/24
            active_ratio = active_hours / 24.0
            sustenance_needed = ratio * active_ratio
            
            for slot in post.slots:
                required_by_skill[slot.skill.name] += sustenance_needed

        # 2. Availability per day
        soldiers = db.query(Soldier).options(joinedload(Soldier.skills), joinedload(Soldier.unavailabilities)).all()
        skills = db.query(Skill).all()
        all_skills = [sk.name for sk in skills]
        
        results = []
        current_date = start_naive
        
        # If start and end are on the same day but different times, ensure at least one iteration
        if current_date.date() == end_naive.date():
             end_naive = current_date + timedelta(days=1)

        while current_date.date() < end_naive.date():
            day_start = datetime.combine(current_date.date(), datetime.min.time())
            day_end = day_start + timedelta(days=1)
            
            total_pool_by_skill = defaultdict(int)
            for s in soldiers:
                for sk in s.skills:
                    total_pool_by_skill[sk.name] += 1

            # Identify all sub-intervals where availability might change
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
                
                # Check availability at the midpoint of this interval
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
                "date": current_date.isoformat(),
                "report": day_report
            })
            
            current_date += timedelta(days=1)
            
        return results
    except Exception as e:
        logger.error(f"Manpower check error: {e}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
