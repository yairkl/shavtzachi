from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker, joinedload
from models import Base, Soldier, Skill, Post, PostTemplateSlot, Shift, Assignment, soldier_skill_table, Unavailability, Division
from datetime import datetime, timedelta, time
import os
import pandas as pd
from typing import List, Optional
from collections import defaultdict

engine = create_engine('sqlite:///data.db', connect_args={"check_same_thread": False})
Session = sessionmaker(bind=engine)

class ShavtzachiDB:
    def __init__(self, session):
        self.session = session

    def add(self, instance):
        self.session.add(instance)

    def add_all(self, instances):
        self.session.add_all(instances)

    def commit(self):
        self.session.commit()

    def rollback(self):
        self.session.rollback()

    def flush(self):
        self.session.flush()

    def merge(self, instance):
        return self.session.merge(instance)

    def query(self, *args, **kwargs):
        return self.session.query(*args, **kwargs)

    def delete(self, instance):
        self.session.delete(instance)

    def refresh(self, instance):
        self.session.refresh(instance)

    # --- Skills ---
    def get_all_skills(self) -> List[Skill]:
        return self.session.query(Skill).all()

    def get_skill_by_name(self, name: str) -> Optional[Skill]:
        return self.session.query(Skill).filter(Skill.name == name).first()

    def get_or_create_skill(self, name: str) -> Skill:
        skill = self.get_skill_by_name(name)
        if not skill:
            skill = Skill(name=name)
            self.session.add(skill)
            # Not committing here to allow batch operations
        return skill

    # --- Soldiers ---
    def get_all_soldiers(self, include_skills=True, include_unavailabilities=False) -> List[Soldier]:
        query = self.session.query(Soldier)
        if include_skills:
            query = query.options(joinedload(Soldier.skills))
        if include_unavailabilities:
            query = query.options(joinedload(Soldier.unavailabilities))
        return query.all()

    def get_soldier_by_id(self, soldier_id: int) -> Optional[Soldier]:
        return self.session.query(Soldier).filter(Soldier.id == soldier_id).first()

    def get_soldier_by_name(self, name: str) -> Optional[Soldier]:
        return self.session.query(Soldier).filter(Soldier.name == name).first()

    def create_soldier(self, name: str, skill_names: List[str], division: Optional[int] = None) -> Soldier:
        soldier = Soldier(name=name, division=division)
        for sk_name in skill_names:
            skill = self.get_or_create_skill(sk_name)
            soldier.skills.append(skill)
        self.session.add(soldier)
        self.session.commit()
        self.session.refresh(soldier)
        return soldier

    def update_soldier(self, soldier_id: int, name: str, skill_names: List[str], division: Optional[int] = None) -> bool:
        soldier = self.get_soldier_by_id(soldier_id)
        if not soldier:
            return False
        soldier.name = name
        soldier.division = division
        soldier.skills = []
        for sk_name in skill_names:
            skill = self.get_or_create_skill(sk_name)
            soldier.skills.append(skill)
        self.session.commit()
        return True

    def delete_soldier(self, soldier_id: int) -> bool:
        soldier = self.get_soldier_by_id(soldier_id)
        if not soldier:
            return False
        self.session.delete(soldier)
        self.session.commit()
        return True

    # --- Posts ---
    def get_all_posts(self, include_slots=True) -> List[Post]:
        query = self.session.query(Post)
        if include_slots:
            query = query.options(joinedload(Post.slots).joinedload(PostTemplateSlot.skill))
        return query.all()

    def get_active_posts(self) -> List[Post]:
        return self.session.query(Post).filter(Post.is_active == 1).options(
            joinedload(Post.slots).joinedload(PostTemplateSlot.skill)
        ).all()

    def get_post_by_name(self, name: str) -> Optional[Post]:
        return self.session.query(Post).filter(Post.name == name).first()

    def create_post(self, name: str, shift_length_hours: float, start_time: time, end_time: time, cooldown_hours: float, intensity_weight: float, slots: List[str], is_active: bool = True, active_from: Optional[datetime] = None, active_until: Optional[datetime] = None) -> bool:
        post = Post(
            name=name,
            shift_length=timedelta(hours=shift_length_hours),
            start_time=start_time,
            end_time=end_time,
            cooldown=timedelta(hours=cooldown_hours),
            intensity_weight=intensity_weight,
            is_active=1 if is_active else 0,
            active_from=active_from,
            active_until=active_until
        )
        for i, sk_name in enumerate(slots):
            skill = self.get_or_create_skill(sk_name)
            self.session.add(PostTemplateSlot(post=post, role_index=i, skill=skill))
        self.session.add(post)
        self.session.commit()
        return True

    def update_post(self, name: str, shift_length_hours: float, start_time: time, end_time: time, cooldown_hours: float, intensity_weight: float, slots: List[str], is_active: bool = True, active_from: Optional[datetime] = None, active_until: Optional[datetime] = None) -> bool:
        post = self.get_post_by_name(name)
        if not post:
            return False
        post.shift_length = timedelta(hours=shift_length_hours)
        post.start_time = start_time
        post.end_time = end_time
        post.cooldown = timedelta(hours=cooldown_hours)
        post.intensity_weight = intensity_weight
        post.is_active = 1 if is_active else 0
        post.active_from = active_from
        post.active_until = active_until
        
        self.session.query(PostTemplateSlot).filter(PostTemplateSlot.post_name == name).delete()
        for i, sk_name in enumerate(slots):
            skill = self.get_or_create_skill(sk_name)
            self.session.add(PostTemplateSlot(post=post, role_index=i, skill=skill))
        self.session.commit()
        return True

    def delete_post(self, name: str) -> bool:
        post = self.get_post_by_name(name)
        if not post:
            return False
        self.session.delete(post)
        self.session.commit()
        return True

    # --- Shifts ---
    def get_shifts_in_range(self, start: datetime, end: datetime) -> List[Shift]:
        return self.session.query(Shift).filter(
            Shift.start < end,
            Shift.end > start
        ).all()

    def get_or_create_shift(self, post: Post, start: datetime, end: datetime) -> Shift:
        shift = self.session.query(Shift).filter(Shift.post_name == post.name, Shift.start == start).first()
        if not shift:
            shift = Shift(post=post, post_name=post.name, start=start, end=end)
            self.session.add(shift)
        return shift

    # --- Assignments ---
    def get_assignments_in_range(self, start: datetime, end: datetime) -> List[Assignment]:
        return self.session.query(Assignment).join(Shift).filter(
            Shift.start < end,
            Shift.end > start
        ).options(
            joinedload(Assignment.soldier),
            joinedload(Assignment.shift).joinedload(Shift.post)
        ).all()

    def get_assignments_for_cooldown_lookback(self, lookback_date: datetime, end_date: datetime) -> List[Assignment]:
        return self.session.query(Assignment).join(Shift).filter(
            Shift.start >= lookback_date,
            Shift.start < end_date
        ).options(
            joinedload(Assignment.shift).joinedload(Shift.post),
            joinedload(Assignment.soldier)
        ).all()

    def clear_assignments_by_ids(self, assignment_ids: List[int]):
        if not assignment_ids:
            return
        self.session.query(Assignment).filter(Assignment.shift_id.in_(assignment_ids)).delete(synchronize_session=False)

    def add_assignment(self, soldier_id: int, shift_id: int, role_id: int):
        self.session.add(Assignment(soldier_id=soldier_id, shift_id=shift_id, role_id=role_id))

    def commit(self):
        self.session.commit()

    def rollback(self):
        self.session.rollback()

    # --- Unavailabilities ---
    def get_unavailabilities(self, start_date: Optional[datetime] = None, end_date: Optional[datetime] = None) -> List[Unavailability]:
        query = self.session.query(Unavailability).options(joinedload(Unavailability.soldier))
        if start_date:
            query = query.filter(Unavailability.end_datetime > start_date)
        if end_date:
            query = query.filter(Unavailability.start_datetime < end_date)
        return query.all()

    def check_overlapping_unavailability(self, soldier_id: int, start: datetime, end: datetime) -> Optional[Unavailability]:
        return self.session.query(Unavailability).filter(
            Unavailability.soldier_id == soldier_id,
            Unavailability.start_datetime < end,
            Unavailability.end_datetime > start
        ).first()

    def create_unavailability(self, soldier_id: int, start: datetime, end: datetime, reason: Optional[str] = None) -> Unavailability:
        record = Unavailability(
            soldier_id=soldier_id,
            start_datetime=start,
            end_datetime=end,
            reason=reason
        )
        self.session.add(record)
        self.session.commit()
        return record

    def update_unavailability(self, u_id: int, soldier_id: int, start: datetime, end: datetime, reason: Optional[str] = None) -> bool:
        record = self.session.query(Unavailability).filter(Unavailability.id == u_id).first()
        if not record:
            return False
        record.soldier_id = soldier_id
        record.start_datetime = start
        record.end_datetime = end
        record.reason = reason
        self.session.commit()
        return True

    def delete_unavailability(self, u_id: int) -> bool:
        record = self.session.query(Unavailability).filter(Unavailability.id == u_id).first()
        if not record:
            return False
        self.session.delete(record)
        self.session.commit()
        return True

    # --- Complex Logic ---
    def get_history_scores(self, exclude_from: Optional[datetime] = None) -> dict:
        query = self.session.query(
            Assignment.soldier_id,
            func.sum(
                (func.julianday(Shift.end) - func.julianday(Shift.start)) * 24 * Post.intensity_weight
            )
        ).join(Shift, Assignment.shift_id == Shift.id)\
         .join(Post, Shift.post_name == Post.name)
         
        if exclude_from:
            query = query.filter(Shift.start < exclude_from.replace(tzinfo=None))
            
        res = query.group_by(Assignment.soldier_id).all()
        return {r[0]: float(r[1]) if r[1] else 0.0 for r in res}

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
            
            # Filter posts active on this day
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

def init_db(eng=engine):
    Base.metadata.create_all(eng)

if __name__ == '__main__':
    if os.path.exists('data.db'): os.remove('data.db')
    init_db()
    with Session() as session:
        db_handler = ShavtzachiDB(session)
        # Seeding
        skill_names = ['רובאי', 'מפקד', 'סמל', 'מפקד מחלקה', 'נהג', 'חובש', 'חמליסט', 'קצין', 'מפקד פלוגה', 'קשר']
        for name in skill_names:
            db_handler.get_or_create_skill(name)
        session.commit()
        
        skills = {s.name: s for s in db_handler.get_all_skills()}

        soldiers = pd.read_csv("data/soldiers.csv")
        for i, soldier in soldiers.iterrows():
            s = Soldier(name=soldier["name"], division=soldier["division"])
            for s_skill in soldier["skills"].split(","):
                s.skills.append(skills[s_skill])
            session.add(s)

        posts = pd.read_csv("data/posts.csv")
        for i, post in posts.iterrows():
            p = Post(
                name=post["name"],
                shift_length=timedelta(hours=post["shift_length_hours"]),
                start_time=datetime.strptime(post["start_time"], "%H:%M").time(),
                end_time=datetime.strptime(post["end_time"], "%H:%M").time(),
                cooldown=timedelta(hours=post["cooldown_hours"]),
                intensity_weight=post["intensity_weight"]
            )
            session.add(p)
            for i, sk_name in enumerate(post["slots"].split(",")):
                session.add(PostTemplateSlot(post=p, role_index=i, skill=skills[sk_name]))

        session.commit()
