import pytest
from datetime import datetime, timedelta
from database import Post, Soldier, Skill, PostTemplateSlot
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
