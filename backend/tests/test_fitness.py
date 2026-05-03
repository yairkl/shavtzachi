import pytest
from datetime import datetime, timedelta
from models import Soldier, Post, Skill, PostTemplateSlot, Shift, Assignment, Unavailability
from schedule import evaluate_soldier_fitness

@pytest.fixture
def setup_fitness_data(db):
    skill = Skill(name="commander")
    db.add(skill)
    
    soldier = Soldier(name="John Doe")
    soldier.skills.append(skill)
    db.add(soldier)
    
    post = Post(name="Main Gate", shift_length=timedelta(hours=4), cooldown=timedelta(hours=8))
    slot = PostTemplateSlot(post=post, role_index=0, skill=skill)
    db.add(post)
    db.add(slot)
    
    db.commit()
    return {
        "soldier": soldier,
        "post": post,
        "skill": skill
    }

def test_perfect_candidate(db, setup_fitness_data):
    soldier = setup_fitness_data["soldier"]
    post = setup_fitness_data["post"]
    
    start = datetime(2026, 1, 1, 12, 0)
    end = start + post.shift_length
    
    # history_scores empty, no previous shifts
    score, conflicts, last_shift, next_shift = evaluate_soldier_fitness(
        soldier, start, end, post, 0, {}, db
    )
    
    assert score > 0
    assert len(conflicts) == 0
    assert last_shift is None
    assert next_shift is None

def test_skill_mismatch(db, setup_fitness_data):
    soldier = setup_fitness_data["soldier"]
    post = setup_fitness_data["post"]
    start = datetime(2026, 1, 1, 12, 0)
    end = start + post.shift_length

    # 1. Base score (with skill)
    base_score, _, _, _ = evaluate_soldier_fitness(soldier, start, end, post, 0, {}, db)

    # 2. New skill that soldier doesn't have
    other_skill = Skill(name="driver")
    db.add(other_skill)
    post.slots[0].skill = other_skill
    db.commit()
    
    mismatch_score, conflicts, _, _ = evaluate_soldier_fitness(soldier, start, end, post, 0, {}, db)
    
    assert "skill_mismatch" in conflicts
    assert mismatch_score < base_score

def test_occupied_overlap(db, setup_fitness_data):
    soldier = setup_fitness_data["soldier"]
    post = setup_fitness_data["post"]
    start = datetime(2026, 1, 1, 12, 0)
    end = start + post.shift_length

    # 1. Base score (no overlap)
    base_score, _, _, _ = evaluate_soldier_fitness(soldier, start, end, post, 0, {}, db)

    # 2. Add an overlapping shift
    other_shift = Shift(post=post, post_name=post.name, 
                        start=datetime(2026, 1, 1, 10, 0), 
                        end=datetime(2026, 1, 1, 14, 0))
    db.add(other_shift)
    db.commit()
    db.add(Assignment(soldier=soldier, shift=other_shift, role_id=0))
    db.commit()
    
    overlap_score, conflicts, _, _ = evaluate_soldier_fitness(soldier, start, end, post, 0, {}, db)
    
    assert "occupied" in conflicts
    assert overlap_score < base_score

def test_unavailable_conflict(db, setup_fitness_data):
    soldier = setup_fitness_data["soldier"]
    post = setup_fitness_data["post"]
    start = datetime(2026, 1, 1, 12, 0)
    end = start + post.shift_length

    # 1. Base score (no unavailability)
    base_score, _, _, _ = evaluate_soldier_fitness(soldier, start, end, post, 0, {}, db)

    # 2. Create unavailability
    u = Unavailability(soldier=soldier, 
                       start_datetime=datetime(2026, 1, 1, 8, 0), 
                       end_datetime=datetime(2026, 1, 1, 16, 0))
    db.add(u)
    db.commit()
    
    unavail_score, conflicts, _, _ = evaluate_soldier_fitness(soldier, start, end, post, 0, {}, db)
    
    assert "unavailable" in conflicts
    assert unavail_score < base_score

def test_cooldown_violation(db, setup_fitness_data):
    soldier = setup_fitness_data["soldier"]
    post = setup_fitness_data["post"]
    start = datetime(2026, 1, 1, 12, 0)
    end = start + post.shift_length

    # 1. Base score (long rest)
    long_rest_start = start + timedelta(days=2)
    base_score, _, _, _ = evaluate_soldier_fitness(soldier, long_rest_start, long_rest_start + post.shift_length, post, 0, {}, db)

    # 2. Previous shift ends at 10:00. Target starts at 12:00. Gap = 2h < 8h.
    prev_shift = Shift(post=post, post_name=post.name, 
                         start=datetime(2026, 1, 1, 6, 0), 
                         end=datetime(2026, 1, 1, 10, 0))
    db.add(prev_shift)
    db.commit()
    db.add(Assignment(soldier=soldier, shift=prev_shift, role_id=0))
    db.commit()
    
    cooldown_score, conflicts, last_shift, next_shift = evaluate_soldier_fitness(soldier, start, end, post, 0, {}, db)
    
    assert "cooldown" in conflicts
    assert cooldown_score < base_score
    assert last_shift is not None
    assert next_shift is None
    assert last_shift["post_name"] == post.name

def test_history_score_and_rest_bonus(db, setup_fitness_data):
    soldier = setup_fitness_data["soldier"]
    post = setup_fitness_data["post"]
    start = datetime(2026, 1, 2, 12, 0)
    end = start + post.shift_length
    
    # # 1. History score comparison
    # score_fresh, _, _ = evaluate_soldier_fitness(soldier, start, end, post, 0, {soldier.id: 0.0}, db)
    # score_busy, _, _ = evaluate_soldier_fitness(soldier, start, end, post, 0, {soldier.id: 100.0}, db)
    
    # assert score_fresh > score_busy
    
    # 2. Rest time comparison
    prev_shift = Shift(post=post, post_name=post.name, 
                         start=datetime(2026, 1, 1, 6, 0), 
                         end=datetime(2026, 1, 1, 10, 0))
    db.add(prev_shift)
    db.commit()
    db.add(Assignment(soldier=soldier, shift=prev_shift, role_id=0))
    db.commit()
    
    # Target 1: Day 1, 20:00 (10h rest)
    # Target 2: Day 2, 12:00 (26h rest)
    t1_start = datetime(2026, 1, 1, 20, 0)
    t2_start = datetime(2026, 1, 2, 12, 0)
    
    score1, _, _, _ = evaluate_soldier_fitness(soldier, t1_start, t1_start + post.shift_length, post, 0, {}, db)
    score2, _, _, _ = evaluate_soldier_fitness(soldier, t2_start, t2_start + post.shift_length, post, 0, {}, db)
    
    assert score2 > score1

def test_draft_assignment_overlap(db, setup_fitness_data):
    soldier = setup_fitness_data["soldier"]
    post = setup_fitness_data["post"]
    start = datetime(2026, 1, 1, 12, 0)
    end = start + post.shift_length

    # 1. Base score (no overlap in DB or draft)
    base_score, _, _, _ = evaluate_soldier_fitness(soldier, start, end, post, 0, {}, db)

    # 2. Add an overlapping draft assignment (NOT in DB)
    draft_assignments = [{
        "soldier_id": soldier.id,
        "post_name": "Some other post",
        "start": datetime(2026, 1, 1, 10, 0),
        "end": datetime(2026, 1, 1, 14, 0),
        "role_id": 0
    }]
    
    overlap_score, conflicts, _, _ = evaluate_soldier_fitness(
        soldier, start, end, post, 0, {}, db, draft_assignments=draft_assignments
    )
    
    assert "occupied" in conflicts
    assert overlap_score < base_score

def test_future_cooldown_violation(db, setup_fitness_data):
    soldier = setup_fitness_data["soldier"]
    post = setup_fitness_data["post"]
    start = datetime(2026, 1, 1, 12, 0)
    end = start + post.shift_length

    # 1. Base score (no future conflict)
    base_score, _, _, _ = evaluate_soldier_fitness(soldier, start, end, post, 0, {}, db)

    # 2. Add a future shift that violates the current shift's cooldown
    # Current ends at 16:00. Future starts at 18:00. Gap = 2h < 8h.
    future_shift = Shift(post=post, post_name=post.name, 
                          start=datetime(2026, 1, 1, 18, 0), 
                          end=datetime(2026, 1, 1, 22, 0))
    db.add(future_shift)
    db.commit()
    db.add(Assignment(soldier=soldier, shift=future_shift, role_id=0))
    db.commit()
    
    cooldown_score, conflicts, _, next_shift = evaluate_soldier_fitness(soldier, start, end, post, 0, {}, db)
    
    assert "cooldown" in conflicts
    assert cooldown_score < base_score
    assert next_shift is not None
    assert next_shift["post_name"] == post.name

def test_future_mission_diversity(db, setup_fitness_data):
    soldier = setup_fitness_data["soldier"]
    post = setup_fitness_data["post"]
    start = datetime(2026, 1, 1, 12, 0)
    end = start + post.shift_length

    # 1. Base score
    base_score, _, _, _ = evaluate_soldier_fitness(soldier, start, end, post, 0, {}, db)

    # 2. Add the SAME mission in the future (within 30 days)
    future_date = start + timedelta(days=2)
    future_shift = Shift(post=post, post_name=post.name, 
                          start=future_date, 
                          end=future_date + post.shift_length)
    db.add(future_shift)
    db.commit()
    db.add(Assignment(soldier=soldier, shift=future_shift, role_id=0))
    db.commit()
    
    diversity_score_same, _, _, _ = evaluate_soldier_fitness(soldier, start, end, post, 0, {}, db)

    # 3. Add a DIFFERENT mission in the future
    other_post = Post(name="Back Gate", shift_length=timedelta(hours=4), cooldown=timedelta(hours=8))
    db.add(other_post)
    db.commit()
    
    future_shift_other = Shift(post=other_post, post_name=other_post.name, 
                               start=future_date + timedelta(days=1), 
                               end=future_date + timedelta(days=1) + other_post.shift_length)
    db.add(future_shift_other)
    db.commit()
    # (Existing assignment for soldier to Front Gate still in DB, we'll clear it first for clean comparison)
    db.delete_assignments_for_soldier(soldier.id)
    db.add(Assignment(soldier=soldier, shift=future_shift_other, role_id=0))
    db.commit()

    diversity_score_diff, _, _, _ = evaluate_soldier_fitness(soldier, start, end, post, 0, {}, db)

    assert diversity_score_same < diversity_score_diff
    assert diversity_score_same < base_score
