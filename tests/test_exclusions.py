import pytest
from datetime import datetime, timedelta
from models import Soldier, Post, Skill, PostTemplateSlot, Shift, Assignment
from schedule import evaluate_soldier_fitness, solve_shift_assignment

@pytest.fixture
def exclusion_data(db):
    skill = Skill(name="guard")
    db.add(skill)
    
    soldier = Soldier(name="Excluded Joe")
    soldier.skills.append(skill)
    db.add(soldier)
    
    post = Post(name="Kitchen", shift_length=timedelta(hours=4), cooldown=timedelta(hours=8))
    slot = PostTemplateSlot(post=post, role_index=0, skill=skill)
    db.add(post)
    db.add(slot)
    
    db.commit()
    return {
        "soldier": soldier,
        "post": post,
        "skill": skill
    }

def test_exclusion_fitness(db, exclusion_data):
    soldier = exclusion_data["soldier"]
    post = exclusion_data["post"]
    
    # 1. Base score (not excluded)
    start = datetime(2026, 1, 1, 12, 0)
    end = start + post.shift_length
    score_normal, conflicts_normal, _, _ = evaluate_soldier_fitness(soldier, start, end, post, 0, {}, db)
    assert "excluded_post" not in conflicts_normal
    
    # 2. Exclude soldier from this post
    soldier.excluded_posts.append(post)
    db.commit()
    
    score_excluded, conflicts_excluded, _, _ = evaluate_soldier_fitness(soldier, start, end, post, 0, {}, db)
    assert "excluded_post" in conflicts_excluded
    assert score_excluded < score_normal

def test_exclusion_solver(db, exclusion_data):
    soldier = exclusion_data["soldier"]
    post = exclusion_data["post"]
    
    # Exclude soldier from Kitchen
    soldier.excluded_posts.append(post)
    db.commit()
    
    # Create a shift for Kitchen
    start = datetime(2026, 1, 1, 12, 0)
    end = start + post.shift_length
    shift = Shift(post=post, post_name=post.name, start=start, end=end)
    
    # Try to solve. Since there's only one soldier and he's excluded, it should fail to find a solution or at least not assign him.
    # Note: the solver has a hard constraint to fill all shifts. If no one is qualified, it returns [].
    assignments = solve_shift_assignment([shift], [soldier])
    
    assert len(assignments) == 0
    
    # Now add another soldier who is NOT excluded
    soldier2 = Soldier(name="Available Bob")
    soldier2.skills.append(exclusion_data["skill"])
    db.add(soldier2)
    db.commit()
    
    assignments = solve_shift_assignment([shift], [soldier, soldier2])
    
    assert len(assignments) == 1
    assert assignments[0].soldier_id == soldier2.id
    assert assignments[0].soldier_id != soldier.id
