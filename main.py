from fastapi import FastAPI, Depends, HTTPException, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import func
from database import engine, Session as DBSession, ShavtzachiDB
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

app = FastAPI(title="Shavtzachi API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_db():
    db_session = DBSession()
    db = ShavtzachiDB(db_session)
    try:
        yield db
    finally:
        db_session.close()

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

@app.get("/skills")
def get_all_skills(db: ShavtzachiDB = Depends(get_db)):
    skills = db.get_all_skills()
    return [s.name for s in skills]

@app.get("/soldiers")
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

@app.post("/soldiers")
def create_soldier(s_data: SoldierCreate, db: ShavtzachiDB = Depends(get_db)):
    return db.create_soldier(s_data.name, s_data.skills, s_data.division, s_data.excluded_posts)

@app.put("/soldiers/{s_id}")
def update_soldier(s_id: int, s_data: SoldierCreate, db: ShavtzachiDB = Depends(get_db)):
    success = db.update_soldier(s_id, s_data.name, s_data.skills, s_data.division, s_data.excluded_posts)
    if not success: raise HTTPException(status_code=404, detail="Soldier not found")
    return {"status": "success"}

@app.delete("/soldiers/{s_id}")
def delete_soldier(s_id: int, db: ShavtzachiDB = Depends(get_db)):
    success = db.delete_soldier(s_id)
    if not success: raise HTTPException(status_code=404, detail="Soldier not found")
    return {"status": "success"}

# --- Endpoints: Posts ---

@app.get("/posts")
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

@app.post("/posts")
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

@app.put("/posts/{name}")
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

@app.delete("/posts/{name}")
def delete_post(name: str, db: ShavtzachiDB = Depends(get_db)):
    success = db.delete_post(name)
    if not success: raise HTTPException(status_code=404, detail="Post not found")
    return {"status": "success"}

# --- CSV Endpoints ---

@app.get("/soldiers/export")
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

@app.post("/soldiers/import")
async def import_soldiers(file: UploadFile = File(...), db: ShavtzachiDB = Depends(get_db)):
    content = await file.read()
    reader = csv.DictReader(io.StringIO(content.decode("utf-8")))
    for row in reader:
        soldier = db.get_soldier_by_name(row["name"])
        if not soldier:
            soldier = Soldier(name=row["name"])
            db.session.add(soldier)
        soldier.division = int(row["division"]) if row["division"] else None
        soldier.skills = []
        for sk_name in row["skills"].split(","):
            if not sk_name.strip(): continue
            skill = db.get_or_create_skill(sk_name.strip())
            soldier.skills.append(skill)
            
        soldier.excluded_posts = []
        if "excluded_posts" in row:
            for p_name in row["excluded_posts"].split(","):
                if not p_name.strip(): continue
                post = db.get_post_by_name(p_name.strip())
                if post:
                    soldier.excluded_posts.append(post)
    db.commit()
    return {"status": "success"}

@app.get("/posts/export")
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

@app.post("/posts/import")
async def import_posts(file: UploadFile = File(...), db: ShavtzachiDB = Depends(get_db)):
    content = await file.read()
    reader = csv.DictReader(io.StringIO(content.decode("utf-8")))
    for row in reader:
        post = db.get_post_by_name(row["name"])
        if not post:
            post = Post(name=row["name"])
            db.session.add(post)
        post.shift_length = timedelta(hours=float(row["shift_length_hours"]))
        post.start_time = datetime.strptime(row["start_time"], "%H:%M").time()
        post.end_time = datetime.strptime(row["end_time"], "%H:%M").time()
        post.cooldown = timedelta(hours=float(row["cooldown_hours"]))
        post.intensity_weight = float(row["intensity_weight"])
        post.active_from = datetime.fromisoformat(row["active_from"]) if row.get("active_from") else None
        post.active_until = datetime.fromisoformat(row["active_until"]) if row.get("active_until") else None
        
        db.session.query(PostTemplateSlot).filter(PostTemplateSlot.post_name == post.name).delete()
        for i, sk_name in enumerate(row["slots"].split(",")):
            if not sk_name.strip(): continue
            skill = db.get_or_create_skill(sk_name.strip())
            db.session.add(PostTemplateSlot(post=post, role_index=i, skill=skill))
    db.commit()
    return {"status": "success"}

# --- Endpoints: Scheduler ---

@app.get("/schedule/shifts")
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
        return result
    except Exception as e:
        logger.error(f"Get shifts error: {e}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/schedule/candidates", response_model=List[CandidateResponse])
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

@app.get("/schedule")
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

@app.get("/schedule/export")
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

@app.post("/schedule/draft")
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

@app.post("/schedule/save")
def save_schedule(req: SaveScheduleRequest, db: ShavtzachiDB = Depends(get_db)):
    try:
        start_naive = req.start_date.replace(tzinfo=None)
        end_naive = req.end_date.replace(tzinfo=None)

        posts = db.get_all_posts()
        all_shifts = generate_shifts(posts, start_naive, end_naive, db=db)
        shift_lookup = {(s.post_name, s.start.replace(microsecond=0).isoformat()): s.id for s in all_shifts}

        shift_ids_to_clear = {s.id for s in all_shifts if s.start >= start_naive and s.start < end_naive}
        
        payload_with_sids = []
        for a_data in req.assignments:
            start_iso = a_data.start.replace(tzinfo=None, microsecond=0).isoformat()
            sid = shift_lookup.get((a_data.post_name, start_iso))
            if sid:
                shift_ids_to_clear.add(sid)
                payload_with_sids.append((sid, a_data))
            else:
                logger.warning(f"Could not find shift for {a_data.post_name} at {start_iso}")

        if shift_ids_to_clear:
            db.clear_assignments_by_ids(list(shift_ids_to_clear))

        seen_assignments = set()
        for sid, a_data in payload_with_sids:
            if (a_data.soldier_id, sid) in seen_assignments:
                logger.warning(f"Duplicate assignment detected in payload for soldier {a_data.soldier_id} in shift {sid}. Skipping.")
                continue
            db.add_assignment(a_data.soldier_id, sid, a_data.role_id)
            seen_assignments.add((a_data.soldier_id, sid))
        
        db.commit()
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Save schedule error: {str(e)}")
        import traceback; traceback.print_exc()
        db.rollback(); 
        raise HTTPException(status_code=500, detail=str(e))

# --- Endpoints: Unavailability ---

@app.get("/unavailabilities", response_model=List[UnavailabilityResponse])
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

@app.post("/unavailabilities")
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

@app.put("/unavailabilities/{u_id}")
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

@app.delete("/unavailabilities/{u_id}")
def delete_unavailability(u_id: int, db: ShavtzachiDB = Depends(get_db)):
    success = db.delete_unavailability(u_id)
    if not success: raise HTTPException(status_code=404, detail="Unavailability not found")
    return {"status": "success"}

@app.get("/unavailabilities/check-manpower")
def check_manpower(start_date: datetime, end_date: datetime, db: ShavtzachiDB = Depends(get_db)):
    try:
        return db.check_manpower(start_date, end_date)
    except Exception as e:
        logger.error(f"Manpower check error: {e}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.error(f"Manpower check error: {e}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
