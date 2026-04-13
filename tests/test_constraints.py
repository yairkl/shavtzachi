import pytest
from datetime import datetime, timedelta
from models import Post, Soldier, Skill, PostTemplateSlot, Unavailability
from schedule import generate_shifts, solve_shift_assignment

@pytest.fixture
def skill_guard(db):
    s = Skill(name="guard_v3")
    db.add(s); db.commit(); return s

@pytest.fixture
def skill_driver(db):
    s = Skill(name="driver_v3")
    db.add(s); db.commit(); return s

def test_skill_constraint(db, skill_guard, skill_driver):
    # Setup: 1 post requiring 'driver', 1 soldier with 'guard' only
    post = Post(name="Ambulance", shift_length=timedelta(hours=4), intensity_weight=1.0)
    slot = PostTemplateSlot(post=post, role_index=0, skill=skill_driver)
    db.add(post); db.add(slot)
    
    soldier = Soldier(name="Only Guard")
    soldier.skills.append(skill_guard)
    db.add(soldier)
    db.commit()
    
    start = datetime(2026, 1, 1, 0, 0)
    end = datetime(2026, 1, 1, 4, 0)
    shifts = generate_shifts([post], start, end)
    for i, s in enumerate(shifts): s.id = i + 100
    
    assignments = solve_shift_assignment(shifts, [soldier])
    # Should be empty because soldier lacks required skill
    assert len(assignments) == 0

def test_cooldown_constraint(db, skill_guard):
    # Setup: Post with 8h cooldown, 2 back-to-back 4h shifts, 1 soldier
    post = Post(name="Gate", shift_length=timedelta(hours=4), cooldown=timedelta(hours=8), intensity_weight=1.0)
    slot = PostTemplateSlot(post=post, role_index=0, skill=skill_guard)
    db.add(post); db.add(slot)
    
    soldier = Soldier(name="Single Soldier")
    soldier.skills.append(skill_guard)
    db.add(soldier)
    db.commit()
    
    start = datetime(2026, 1, 1, 0, 0)
    end = datetime(2026, 1, 1, 8, 0) # 2 shifts: 0-4 and 4-8
    shifts = generate_shifts([post], start, end)
    for i, s in enumerate(shifts): s.id = i + 100
    
    assignments = solve_shift_assignment(shifts, [soldier])
    # Now that cooldown is a soft constraint, the solver should fill both shifts
    # despite the violation, because filling all shifts is a hard constraint.
    assert len(assignments) == 2

def test_overlap_prevention(db, skill_guard):
    # Setup: 2 different posts at the same time, 1 soldier
    p1 = Post(name="Post A", shift_length=timedelta(hours=4), intensity_weight=1.0)
    db.add(p1); db.add(PostTemplateSlot(post=p1, role_index=0, skill=skill_guard))
    
    p2 = Post(name="Post B", shift_length=timedelta(hours=4), intensity_weight=1.0)
    db.add(p2); db.add(PostTemplateSlot(post=p2, role_index=0, skill=skill_guard))
    
    soldier = Soldier(name="Busy Soldier")
    soldier.skills.append(skill_guard)
    db.add(soldier)
    db.commit()
    
    start = datetime(2026, 1, 1, 0, 0)
    end = datetime(2026, 1, 1, 4, 0) # Both posts generate shifts here
    shifts = generate_shifts([p1, p2], start, end)
    for i, s in enumerate(shifts): s.id = i + 100
    
    assignments = solve_shift_assignment(shifts, [soldier])
    # Now that filling all shifts is a hard constraint, this becomes INFEASIBLE
    # (2 concurrent shifts but only 1 soldier).
    assert len(assignments) == 0

def test_unavailability_constraint(db, skill_guard):
    # Setup: 1 shift at 00:00-04:00, soldier unavailable 01:00-02:00
    post = Post(name="Gate", shift_length=timedelta(hours=4), intensity_weight=1.0)
    db.add(post); db.add(PostTemplateSlot(post=post, role_index=0, skill=skill_guard))
    
    soldier = Soldier(name="Vacationing Soldier")
    soldier.skills.append(skill_guard)
    db.add(soldier)
    
    unavail = Unavailability(
        soldier=soldier, 
        start_datetime=datetime(2026, 1, 1, 1, 0), 
        end_datetime=datetime(2026, 1, 1, 3, 0)
    )
    db.add(unavail)
    db.commit()
    
    start = datetime(2026, 1, 1, 0, 0)
    end = datetime(2026, 1, 1, 4, 0)
    shifts = generate_shifts([post], start, end)
    for i, s in enumerate(shifts): s.id = i + 100
    
    from sqlalchemy.orm import joinedload
    soldier_with_unavail = db.query(Soldier).options(joinedload(Soldier.unavailabilities)).filter(Soldier.id == soldier.id).first()
    
    print("UNAVAILABILITIES:", soldier_with_unavail.unavailabilities)
    assignments = solve_shift_assignment(shifts, [soldier_with_unavail])
    # Should be empty because shift overlaps with unavailability
    assert len(assignments) == 0
