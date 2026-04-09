from fastapi import FastAPI, Depends, HTTPException, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, joinedload
from database import engine, Session as DBSession
from models import Soldier, Post, Shift, Assignment, Skill, PostTemplateSlot
from schedule import generate_shifts, solve_shift_assignment
from pydantic import BaseModel, field_validator
from typing import List, Optional
from datetime import datetime, timedelta
import csv
import io
import logging

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

def get_history_scores(db: Session):
    # Calculate sum of (end - start) * intensity_weight for each soldier
    # SQLite logic: (julianday(end) - julianday(start)) * 24 gives hours
    from sqlalchemy import func
    from models import Assignment, Shift, Post
    
    # We query all assignments joined with shifts and posts
    res = db.query(
        Assignment.soldier_id,
        func.sum(
            (func.julianday(Shift.end) - func.julianday(Shift.start)) * 24 * Post.intensity_weight
        )
    ).join(Shift, Assignment.shift_id == Shift.id)\
     .join(Post, Shift.post_name == Post.name)\
     .group_by(Assignment.soldier_id).all()
    
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
        intensity_weight=p_data.intensity_weight
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
        # Use joinedload to ensure all relationships are available without lazy loading issues in the solver
        soldiers = db.query(Soldier).options(joinedload(Soldier.skills), joinedload(Soldier.unavailabilities)).all()
        posts = db.query(Post).options(joinedload(Post.slots).joinedload(PostTemplateSlot.skill)).all()
        
        # Normalize to naive datetimes
        start_naive = req.start_date.replace(tzinfo=None)
        end_naive = req.end_date.replace(tzinfo=None)
        
        shifts = generate_shifts(posts, start_naive, end_naive, session=None)
        
        # Get dynamic history scores
        history_scores = get_history_scores(db)
            
        assignments = solve_shift_assignment(shifts, soldiers, history_scores=history_scores)
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
