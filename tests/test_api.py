import pytest
from fastapi.testclient import TestClient
from main import app
from models import Soldier, Post, Skill, PostTemplateSlot
from datetime import timedelta

@pytest.fixture
def client():
    return TestClient(app)

def test_get_soldiers(client, db):
    # Ensure some data exists in the in-memory DB
    db.add(Soldier(name="API Soldier"))
    db.commit()
    
    response = client.get("/soldiers")
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
    response = client.post("/schedule/draft", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) > 0
