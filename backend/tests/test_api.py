import pytest
from fastapi.testclient import TestClient
from main import app
from models import Soldier, Post, Skill, PostTemplateSlot, Shift, Assignment
from datetime import timedelta, datetime, time

@pytest.fixture
def client():
    return TestClient(app)

def test_get_soldiers(client, db):
    # Ensure some data exists in the in-memory DB
    db.add(Soldier(name="API Soldier"))
    db.commit()
    
    response = client.get("/api/soldiers")
    assert response.status_code == 200
    data = response.json()
    assert any(s["name"] == "API Soldier" for s in data)

def test_schedule_draft(client, db):
    # Setup data in the in-memory DB
    s1 = Skill(name="guard_api_v2")
    db.add(s1)
    db.commit()
    
    sol = Soldier(name="Solver API Soldier")
    sol.skills.append(s1)
    db.add(sol)
    
    post = Post(name="Gate_API_V2", shift_length=timedelta(hours=4))
    slot = PostTemplateSlot(post=post, role_index=0, skill=s1)
    db.add(post)
    db.add(slot)
    db.commit()

    payload = {
        "start_date": "2026-10-01T00:00:00",
        "end_date": "2026-10-01T12:00:00"
    }
    response = client.post("/api/schedule/draft", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) > 0

def test_save_schedule_preserves_crossing_shift(client, db):
    # Setup metadata
    skill = Skill(name="Guard")
    db.add(skill)
    db.commit()
    
    soldier = Soldier(name="John Doe")
    soldier.skills.append(skill)
    db.add(soldier)
    
    # Post with 4h shifts, starting at 18:00 (so 18-22, 22-02, 02-06, etc.)
    post = Post(
        name="Post Alpha", 
        shift_length=timedelta(hours=4),
        start_time=time(18, 0),
        end_time=time(17, 59)
    )
    db.add(post)
    db.add(PostTemplateSlot(post=post, role_index=0, skill=skill))
    db.commit()
    
    # Setup a shift crossing midnight between Day 0 and Day 1
    # Day 0: 2026-04-13
    # Day 1: 2026-04-14
    start_day0_late = datetime(2026, 4, 13, 22, 0)
    end_day1_early = datetime(2026, 4, 14, 2, 0)
    
    shift_crossing = Shift(post_name="Post Alpha", start=start_day0_late, end=end_day1_early)
    db.add(shift_crossing)
    db.commit()
    
    assignment = Assignment(soldier_id=soldier.id, shift_id=shift_crossing.id, role_id=0)
    db.add(assignment)
    db.commit()
    
    # Verify it exists
    assert db.count_assignments() == 1
    
    # Simulate saving schedule for Day 1 (starting at midnight)
    payload = {
        "start_date": "2026-04-14T00:00:00",
        "end_date": "2026-04-15T06:00:00",
        "assignments": [
            {
                "soldier_id": soldier.id,
                "post_name": "Post Alpha",
                "start": "2026-04-14T02:00:00",
                "end": "2026-04-14T06:00:00",
                "role_id": 0
            }
        ]
    }
    
    response = client.post("/api/schedule/save", json=payload)
    assert response.status_code == 200
    
    # Verify the crossing assignment was preserved
    crossing_assignments = db.get_assignments_in_range(start_day0_late, start_day0_late + timedelta(seconds=1))
    crossing_assignment = crossing_assignments[0] if crossing_assignments else None
    assert crossing_assignment is not None, "Assignment crossing midnight should have been preserved"
