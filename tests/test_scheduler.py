import pytest
from datetime import datetime, timedelta
from database import Post, Soldier, Skill, PostTemplateSlot, Shift
from schedule import generate_shifts, solve_shift_assignment

@pytest.fixture
def sample_data(db):
    skill = Skill(name="guard_sample")
    db.add(skill)
    
    soldier = Soldier(name="John Sample")
    soldier.skills.append(skill)
    db.add(soldier)
    
    post = Post(name="Gate_Sample", shift_length=timedelta(hours=4))
    slot = PostTemplateSlot(post=post, role_index=0, skill=skill)
    db.add(post)
    db.add(slot)
    db.commit()
    return {
        "soldiers": [soldier],
        "posts": [post]
    }

def test_generate_shifts(sample_data):
    posts = sample_data["posts"]
    start = datetime(2025, 1, 1, 0, 0)
    end = datetime(2025, 1, 1, 12, 0)
    shifts = generate_shifts(posts, start, end)
    assert len(shifts) >= 3

def test_solver_feasibility(sample_data):
    soldiers = sample_data["soldiers"]
    posts = sample_data["posts"]
    start = datetime(2025, 1, 1, 0, 0)
    end = datetime(2025, 1, 1, 8, 0) # 2 shifts
    shifts = generate_shifts(posts, start, end)
    
    # Manually assign IDs since they are not committed yet
    for i, s in enumerate(shifts):
        s.id = i + 100
        
    assignments = solve_shift_assignment(shifts, soldiers)
    # The solver might find a solution with ANY number of assignments >= 1
    assert len(assignments) > 0


@pytest.fixture
def skill_consecutive(db):
    s = Skill(name="consecutive_skill")
    db.add(s)
    db.commit()
    return s


def test_respect_cooldown_with_multiple_soldiers(db, skill_consecutive):
    """
    Scenario: 2 back-to-back shifts, 2 soldiers, 4h cooldown.
    Each soldier should get 1 shift to avoid cooldown violation.
    """
    post = Post(name="Gate", shift_length=timedelta(hours=4), cooldown=timedelta(hours=4), intensity_weight=1.0)
    db.add(post)
    db.add(PostTemplateSlot(post=post, role_index=0, skill=skill_consecutive))
    
    s1 = Soldier(name="Soldier 1")
    s1.skills.append(skill_consecutive)
    s2 = Soldier(name="Soldier 2")
    s2.skills.append(skill_consecutive)
    db.add(s1); db.add(s2)
    db.commit()
    
    start = datetime(2026, 1, 1, 0, 0)
    end = datetime(2026, 1, 1, 8, 0) # 2 shifts: 0-4 and 4-8
    shifts = generate_shifts([post], start, end)
    # Ensure they have IDs for the solver
    for i, s in enumerate(shifts): 
        if s.id is None:
            s.id = i + 1000
    
    assignments = solve_shift_assignment(shifts, [s1, s2])
    
    assert len(assignments) == 2
    # Ensure they are assigned to different soldiers
    assigned_soldier_ids = {a.soldier_id for a in assignments}
    assert len(assigned_soldier_ids) == 2
    assert s1.id in assigned_soldier_ids
    assert s2.id in assigned_soldier_ids


def test_allow_consecutive_with_zero_cooldown(db, skill_consecutive):
    """
    Scenario: 2 back-to-back shifts, 1 soldier, 0h cooldown.
    Same soldier should be assigned to both.
    """
    post = Post(name="Gate Zero", shift_length=timedelta(hours=4), cooldown=timedelta(hours=0), intensity_weight=1.0)
    db.add(post)
    db.add(PostTemplateSlot(post=post, role_index=0, skill=skill_consecutive))
    
    s1 = Soldier(name="Solo Soldier")
    s1.skills.append(skill_consecutive)
    db.add(s1)
    db.commit()
    
    start = datetime(2026, 1, 1, 0, 0)
    end = datetime(2026, 1, 1, 8, 0) # 2 shifts: 0-4 and 4-8
    shifts = generate_shifts([post], start, end)
    for i, s in enumerate(shifts): 
        if s.id is None:
            s.id = i + 2000
    
    assignments = solve_shift_assignment(shifts, [s1])
    
    assert len(assignments) == 2
    for a in assignments:
        assert a.soldier_id == s1.id


def test_prevent_direct_overlaps_hard_constraint(db, skill_consecutive):
    """
    Scenario: 2 overlapping shifts, 1 soldier.
    Filling all is hard, but overlap prevention is also hard.
    """
    p1 = Post(name="Post 1", shift_length=timedelta(hours=4), intensity_weight=1.0)
    db.add(p1); db.add(PostTemplateSlot(post=p1, role_index=0, skill=skill_consecutive))
    
    p2 = Post(name="Post 2", shift_length=timedelta(hours=4), intensity_weight=1.0)
    db.add(p2); db.add(PostTemplateSlot(post=p2, role_index=0, skill=skill_consecutive))
    
    s1 = Soldier(name="Overlap Soldier")
    s1.skills.append(skill_consecutive)
    db.add(s1)
    db.commit()
    
    # Manually create overlapping shifts
    s1_shift = Shift(post=p1, post_name=p1.name, start=datetime(2026, 1, 1, 0, 0), end=datetime(2026, 1, 1, 4, 0))
    s2_shift = Shift(post=p2, post_name=p2.name, start=datetime(2026, 1, 1, 2, 0), end=datetime(2026, 1, 1, 6, 0))
    db.add(s1_shift); db.add(s2_shift); db.commit()
    
    all_shifts = [s1_shift, s2_shift]
    for i, s in enumerate(all_shifts): 
        if s.id is None:
            s.id = i + 3000
    
    assignments = solve_shift_assignment(all_shifts, [s1])
    
    # Since overlap is a HARD constraint and filling roles is hard, 
    # and we only have 1 soldier, it's INFEASIBLE -> 0 assignments
    assert len(assignments) == 0


def test_enforce_cooldown_between_different_posts(db, skill_consecutive):
    """
    Scenario: Post A (0-4) and Post B (4-8), 2 soldiers, 4h cooldown.
    """
    p1 = Post(name="Post A", shift_length=timedelta(hours=4), cooldown=timedelta(hours=4), intensity_weight=1.0)
    db.add(p1); db.add(PostTemplateSlot(post=p1, role_index=0, skill=skill_consecutive))
    
    p2 = Post(name="Post B", shift_length=timedelta(hours=4), cooldown=timedelta(hours=4), intensity_weight=1.0)
    db.add(p2); db.add(PostTemplateSlot(post=p2, role_index=0, skill=skill_consecutive))
    
    s1 = Soldier(name="Soldier A")
    s1.skills.append(skill_consecutive)
    s2 = Soldier(name="Soldier B")
    s2.skills.append(skill_consecutive)
    db.add(s1); db.add(s2)
    db.commit()
    
    # Post A: 0-4
    s1_shifts = generate_shifts([p1], datetime(2026, 1, 1, 0, 0), datetime(2026, 1, 1, 4, 0))
    # Post B: 4-8
    s2_shifts = generate_shifts([p2], datetime(2026, 1, 1, 4, 0), datetime(2026, 1, 1, 8, 0))
    
    shifts = s1_shifts + s2_shifts
    for i, s in enumerate(shifts): 
        if s.id is None:
            s.id = i + 4000
    
    assignments = solve_shift_assignment(shifts, [s1, s2])
    
    assert len(assignments) == 2
    assigned_soldier_ids = {a.soldier_id for a in assignments}
    assert len(assigned_soldier_ids) == 2


def test_multi_call_cooldown_persistence(db, skill_consecutive):
    """
    Scenario:
    Round 1: Soldier 1 assigned to 00:00-04:00.
    Round 2: Shift is 04:00-08:00. 2 soldiers available.
    Soldier 2 should be assigned to respect S1's cooldown from Round 1.
    """
    post = Post(name="MultiCallGate", shift_length=timedelta(hours=4), cooldown=timedelta(hours=4), intensity_weight=1.0)
    db.add(post); db.add(PostTemplateSlot(post=post, role_index=0, skill=skill_consecutive))
    
    s1 = Soldier(name="Veteran S1")
    s1.skills.append(skill_consecutive)
    s2 = Soldier(name="Fresh S2")
    s2.skills.append(skill_consecutive)
    db.add(s1); db.add(s2)
    db.commit()
    
    # Round 1: 00:00 - 04:00
    shifts1 = generate_shifts([post], datetime(2026, 1, 1, 0, 0), datetime(2026, 1, 1, 4, 0))
    for i, s in enumerate(shifts1): s.id = i + 5000
    
    # Call 1: S1 gets the first shift
    assignments1 = solve_shift_assignment(shifts1, [s1])
    assert len(assignments1) == 1
    assert assignments1[0].soldier_id == s1.id
    
    # Round 2: 04:00 - 08:00
    shifts2 = generate_shifts([post], datetime(2026, 1, 1, 4, 0), datetime(2026, 1, 1, 8, 0))
    for i, s in enumerate(shifts2): s.id = i + 6000
    
    # Call 2: Both soldiers available, but S1 should be in cooldown
    assignments2 = solve_shift_assignment(
        shifts=shifts2, 
        soldiers=[s1, s2], 
        existing_assignments=assignments1
    )
    
    assert len(assignments2) == 1
    # S2 should be chosen over S1
    assert assignments2[0].soldier_id == s2.id
