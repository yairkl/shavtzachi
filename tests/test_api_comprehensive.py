import pytest
from fastapi.testclient import TestClient
from main import app
from models import Soldier, Post, Skill, PostTemplateSlot, Shift, Assignment, Unavailability
from datetime import timedelta, datetime, time
import io
import csv

@pytest.fixture
def client():
    return TestClient(app)

class TestPersonnel:
    def test_get_skills(self, client, db):
        db.get_or_create_skill("Combat")
        db.get_or_create_skill("Medic")
        db.commit()
        
        response = client.get("/skills")
        assert response.status_code == 200
        data = response.json()
        assert "Combat" in data
        assert "Medic" in data

    def test_soldiers_crud(self, client, db):
        # 1. Create
        payload = {
            "name": "Test Soldier",
            "skills": ["Driver", "Guard"],
            "division": 1
        }
        response = client.post("/soldiers", json=payload)
        assert response.status_code == 200
        soldier_id = response.json()["id"]

        # 2. Read
        response = client.get("/soldiers")
        data = response.json()
        soldier = next(s for s in data if s["id"] == soldier_id)
        assert soldier["name"] == "Test Soldier"
        assert set(soldier["skills"]) == {"Driver", "Guard"}
        assert soldier["division"] == 1

        # 3. Update
        update_payload = {
            "name": "Updated Soldier",
            "skills": ["Medic"],
            "division": 2
        }
        response = client.put(f"/soldiers/{soldier_id}", json=update_payload)
        assert response.status_code == 200
        
        response = client.get("/soldiers")
        soldier = next(s for s in response.json() if s["id"] == soldier_id)
        assert soldier["name"] == "Updated Soldier"
        assert soldier["skills"] == ["Medic"]

        # 4. Delete
        response = client.delete(f"/soldiers/{soldier_id}")
        assert response.status_code == 200
        
        response = client.get("/soldiers")
        assert not any(s["id"] == soldier_id for s in response.json())

class TestPosts:
    def test_posts_crud(self, client, db):
        # 1. Create
        payload = {
            "name": "Gate Guard",
            "shift_length_hours": 4,
            "start_time": "08:00",
            "end_time": "20:00",
            "cooldown_hours": 8,
            "intensity_weight": 1.5,
            "slots": ["Guard", "Guard"],
            "is_active": True
        }
        response = client.post("/posts", json=payload)
        assert response.status_code == 200

        # 2. Read
        response = client.get("/posts")
        data = response.json()
        post = next(p for p in data if p["name"] == "Gate Guard")
        assert post["shift_length_hours"] == 4
        assert post["intensity_weight"] == 1.5
        assert len(post["slots"]) == 2

        # 3. Update
        update_payload = payload.copy()
        update_payload["intensity_weight"] = 2.0
        update_payload["slots"] = ["Medic"]
        response = client.put("/posts/Gate Guard", json=update_payload)
        assert response.status_code == 200
        
        response = client.get("/posts")
        post = next(p for p in response.json() if p["name"] == "Gate Guard")
        assert post["intensity_weight"] == 2.0
        assert len(post["slots"]) == 1
        assert post["slots"][0]["skill"] == "Medic"

        # 4. Delete
        response = client.delete("/posts/Gate Guard")
        assert response.status_code == 200
        
        response = client.get("/posts")
        assert not any(p["name"] == "Gate Guard" for p in response.json())

class TestCSV:
    def test_soldiers_export_import(self, client, db):
        # 1. Create a soldier
        db.create_soldier("Export Soldier", ["Skill1"], 1)
        
        # 2. Export
        response = client.get("/soldiers/export")
        assert response.status_code == 200
        csv_content = response.text
        assert "Export Soldier" in csv_content
        
        # 3. Modify CSV and Import
        # Add a new soldier to the CSV
        modified_csv = csv_content + "Imported Soldier,2,Skill2,0.0\n"
        file = ("soldiers.csv", io.BytesIO(modified_csv.encode("utf-8")))
        response = client.post("/soldiers/import", files={"file": file})
        assert response.status_code == 200
        
        # 4. Verify Import
        response = client.get("/soldiers")
        data = response.json()
        assert any(s["name"] == "Imported Soldier" for s in data)

    def test_posts_export_import(self, client, db):
        # 1. Create a post
        db.create_post("Export Post", 4, time(8,0), time(12,0), 8, 1.0, ["Skill1"])
        
        # 2. Export
        response = client.get("/posts/export")
        assert response.status_code == 200
        csv_content = response.text
        assert "Export Post" in csv_content
        
        # 3. Modify CSV and Import
        modified_csv = csv_content + "Imported Post,8.0,12:00,20:00,16.0,1.2,Skill2\n"
        file = ("posts.csv", io.BytesIO(modified_csv.encode("utf-8")))
        response = client.post("/posts/import", files={"file": file})
        assert response.status_code == 200
        
        # 4. Verify Import
        response = client.get("/posts")
        data = response.json()
        assert any(p["name"] == "Imported Post" for p in data)

class TestScheduler:
    @pytest.fixture
    def setup_data(self, db):
        s1 = db.get_or_create_skill("Guard")
        db.commit()
        sol = db.create_soldier("Scheduler Soldier", ["Guard"], 1)
        post = db.create_post("Scheduler Post", 4, time(0,0), time(23,59), 8, 1.0, ["Guard"])
        db.commit()
        return sol, post

    def test_get_shifts_with_assignments(self, client, db, setup_data):
        start = datetime(2025, 1, 1, 0, 0)
        end = datetime(2025, 1, 1, 12, 0)
        response = client.get(f"/schedule/shifts?start_date={start.isoformat()}&end_date={end.isoformat()}")
        assert response.status_code == 200
        data = response.json()
        assert len(data) > 0
        assert data[0]["post_name"] == "Scheduler Post"

    def test_get_candidates(self, client, db, setup_data):
        sol, post = setup_data
        payload = {
            "post_name": "Scheduler Post",
            "start": "2025-01-01T08:00:00",
            "end": "2025-01-01T12:00:00",
            "role_id": 0,
            "draft_assignments": []
        }
        response = client.post("/schedule/candidates", json=payload)
        assert response.status_code == 200
        data = response.json()
        assert any(c["name"] == "Scheduler Soldier" for c in data)

    def test_draft_schedule_algorithms(self, client, db, setup_data):
        payload = {
            "start_date": "2025-01-01T00:00:00",
            "end_date": "2025-01-01T08:00:00",
            "algorithm": "optimal"
        }
        # Test Optimal
        response = client.post("/schedule/draft", json=payload)
        assert response.status_code == 200
        assert len(response.json()) > 0

        # Test Greedy
        payload["algorithm"] = "greedy"
        response = client.post("/schedule/draft", json=payload)
        assert response.status_code == 200
        assert len(response.json()) > 0

    def test_save_and_get_schedule(self, client, db, setup_data):
        sol, post = setup_data
        start = "2025-01-01T08:00:00"
        end = "2025-01-01T12:00:00"
        
        payload = {
            "start_date": "2025-01-01T00:00:00",
            "end_date": "2025-01-02T00:00:00",
            "assignments": [
                {
                    "soldier_id": sol.id,
                    "post_name": "Scheduler Post",
                    "start": start,
                    "end": end,
                    "role_id": 0
                }
            ]
        }
        response = client.post("/schedule/save", json=payload)
        assert response.status_code == 200

        # Verify via GET /schedule
        response = client.get(f"/schedule?start_date=2025-01-01T00:00:00&end_date=2025-01-02T00:00:00")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["soldier_name"] == "Scheduler Soldier"

class TestUnavailabilities:
    def test_unavailabilities_crud(self, client, db):
        # 1. Setup soldier
        sol = db.create_soldier("Unavailability Soldier", ["Guard"], 1)
        
        # 2. Create Unavailability
        payload = {
            "soldier_id": sol.id,
            "start_datetime": "2025-01-01T08:00:00",
            "end_datetime": "2025-01-01T12:00:00",
            "reason": "Test Reason"
        }
        response = client.post("/unavailabilities", json=payload)
        assert response.status_code == 200
        u_id = response.json()["id"]

        # 3. Read
        response = client.get("/unavailabilities")
        assert response.status_code == 200
        data = response.json()
        record = next(r for r in data if r["id"] == u_id)
        assert record["reason"] == "Test Reason"

        # 4. Update
        update_payload = payload.copy()
        update_payload["reason"] = "Updated Reason"
        response = client.put(f"/unavailabilities/{u_id}", json=update_payload)
        assert response.status_code == 200
        
        response = client.get("/unavailabilities")
        record = next(r for r in response.json() if r["id"] == u_id)
        assert record["reason"] == "Updated Reason"

        # 5. Delete
        response = client.delete(f"/unavailabilities/{u_id}")
        assert response.status_code == 200
        
        response = client.get("/unavailabilities")
        assert not any(r["id"] == u_id for r in response.json())

    def test_check_manpower(self, client, db):
        # 1. Setup data
        db.get_or_create_skill("Guard")
        db.create_post("Post A", 4, time(0,0), time(23,59), 8, 1.0, ["Guard"])
        db.create_soldier("Soldier A", ["Guard"], 1)
        db.commit()
        
        # 2. Check manpower
        start = "2025-01-01T00:00:00"
        end = "2025-01-02T00:00:00"
        response = client.get(f"/unavailabilities/check-manpower?start_date={start}&end_date={end}")
        assert response.status_code == 200
        data = response.json()
        assert len(data) > 0 # Should have info for at least one day
        assert "report" in data[0]


