import pytest
from datetime import datetime, timedelta, time
from database import Post, Soldier, Skill, PostTemplateSlot, Shift
from schedule import generate_shifts

def test_temporary_post_filtering(db):
    skill = Skill(name="temp_skill")
    db.add(skill)
    
    # Create a temporary post active only for Jan 2nd
    active_from = datetime(2026, 1, 2, 0, 0)
    active_until = datetime(2026, 1, 3, 0, 0)
    post = Post(
        name="Temporary Post", 
        shift_length=timedelta(hours=4),
        start_time=time(0,0),
        end_time=time(23,59),
        active_from=active_from,
        active_until=active_until
    )
    db.add(post)
    db.add(PostTemplateSlot(post=post, role_index=0, skill=skill))
    db.commit()

    # Case 1: Window before active range (Jan 1st)
    start1 = datetime(2026, 1, 1, 0, 0)
    end1 = datetime(2026, 1, 2, 0, 0)
    shifts1 = generate_shifts([post], start1, end1)
    assert len(shifts1) == 0

    # Case 2: Window overlaps active range (Jan 2nd)
    start2 = datetime(2026, 1, 1, 0, 0)
    end2 = datetime(2026, 1, 3, 0, 0)
    shifts2 = generate_shifts([post], start2, end2)
    # 24 hours / 4 hours = 6 shifts
    assert len(shifts2) == 6
    for s in shifts2:
        assert s.start >= active_from
        assert s.end <= active_until

    # Case 3: Window after active range (Jan 4th)
    start3 = datetime(2026, 1, 4, 0, 0)
    end3 = datetime(2026, 1, 5, 0, 0)
    shifts3 = generate_shifts([post], start3, end3)
    assert len(shifts3) == 0

def test_post_active_boundary_shifts(db):
    skill = Skill(name="boundary_skill")
    db.add(skill)
    
    # Post active from Jan 1st 10:00 to Jan 1st 14:00 (exactly one 4h shift)
    active_from = datetime(2026, 1, 1, 10, 0)
    active_until = datetime(2026, 1, 1, 14, 0)
    post = Post(
        name="Boundary Post", 
        shift_length=timedelta(hours=4),
        start_time=time(6,0), # Shifts: 6-10, 10-14, 14-18...
        active_from=active_from,
        active_until=active_until
    )
    db.add(post)
    db.add(PostTemplateSlot(post=post, role_index=0, skill=skill))
    db.commit()

    start = datetime(2026, 1, 1, 0, 0)
    end = datetime(2026, 1, 2, 0, 0)
    shifts = generate_shifts([post], start, end)
    
    # Only the 10:00-14:00 shift should be included
    assert len(shifts) == 1
    assert shifts[0].start == datetime(2026, 1, 1, 10, 0)
    assert shifts[0].end == datetime(2026, 1, 1, 14, 0)

def test_manpower_check_with_temp_posts(db):
    skill = Skill(name="manpower_temp_skill")
    db.session.add(skill)
    
    # Post 1: Permanent (active 24/7)
    p1 = Post(name="Permanent", shift_length=timedelta(hours=4), start_time=time(0,0), end_time=time(23,59))
    p1.slots.append(PostTemplateSlot(role_index=0, skill=skill))
    db.session.add(p1)
    
    # Post 2: Temporary (active only on Jan 2nd)
    active_from = datetime(2026, 1, 2, 0, 0)
    active_until = datetime(2026, 1, 3, 0, 0)
    p2 = Post(name="Temporary", shift_length=timedelta(hours=4), start_time=time(0,0), end_time=time(23,59), active_from=active_from, active_until=active_until)
    p2.slots.append(PostTemplateSlot(role_index=0, skill=skill))
    db.session.add(p2)
    
    db.session.commit()
    
    # Manpower check for Jan 1st - Jan 3rd
    start = datetime(2026, 1, 1, 0, 0)
    end = datetime(2026, 1, 3, 0, 0)
    report = db.check_manpower(start, end)
    
    # report is list of dicts: [{"date": "2026-01-01", "report": [...]}, ...]
    day1 = next(d for d in report if d["date"] == "2026-01-01")
    day2 = next(d for d in report if d["date"] == "2026-01-02")
    
    skill_report1 = next(m for m in day1["report"] if m["skill"] == "manpower_temp_skill")
    skill_report2 = next(m for m in day2["report"] if m["skill"] == "manpower_temp_skill")
    
    # Day 1: Only Permanent Post active. 
    # ratio = (4+0)/4 = 1. Sustenance = 1 * (24/24) = 1.0 needed.
    assert skill_report1["needed"] == 1.0
    
    # Day 2: Both active. Both need 1.0. Total 2.0.
    assert skill_report2["needed"] == 2.0
