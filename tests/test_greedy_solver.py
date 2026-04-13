import pytest
from datetime import datetime, timedelta, time
from models import Post, Soldier, Skill, PostTemplateSlot, Shift, Assignment
from schedule import generate_shifts, solve_shift_assignment_greedy
from sqlalchemy.orm import Session as SQLAlchemySession

@pytest.fixture
def greedy_data(db: SQLAlchemySession):
    # Skills
    rare_skill = Skill(name="Rare Skill")
    common_skill = Skill(name="Common Skill")
    db.add_all([rare_skill, common_skill])
    db.commit()

    # Soldiers
    s_rare = Soldier(name="Rare Soldier")
    s_rare.skills.append(rare_skill)
    
    s_common1 = Soldier(name="Common 1")
    s_common1.skills.append(common_skill)
    s_common2 = Soldier(name="Common 2")
    s_common2.skills.append(common_skill)
    
    db.add_all([s_rare, s_common1, s_common2])
    db.commit()

    # Posts
    # Post with rare skill
    p_rare = Post(name="Rare Post", shift_length=timedelta(hours=4), cooldown=timedelta(hours=4), start_time=time(0,0))
    db.add(p_rare)
    db.add(PostTemplateSlot(post=p_rare, role_index=0, skill=rare_skill))
    
    # Post with common skill
    p_common = Post(name="Common Post", shift_length=timedelta(hours=4), cooldown=timedelta(hours=4), start_time=time(0,0))
    db.add(p_common)
    db.add(PostTemplateSlot(post=p_common, role_index=0, skill=common_skill))
    
    db.commit()
    
    return {
        "rare_soldier": s_rare,
        "common_soldiers": [s_common1, s_common2],
        "rare_post": p_rare,
        "common_post": p_common,
        "common_skill": common_skill
    }

def test_greedy_rarity_criticality_ordering(db, greedy_data):
    """
    Test that shifts requiring CRITICAL skills (high demand/supply) are processed first,
    even if the absolute number of soldiers is higher.
    
    Scenario:
    Skill A (Rare Skill): 1 soldier, but used in a post that's only active 1h/day (Low Demand).
    Skill B (Common Skill): 10 soldiers, but used in multiple 24/7 posts (High Demand).
    """
    # 1. Setup Skill A (Rare, but Low Demand)
    # 1 soldier has it. Post is active only 1 hour per day.
    s_rare = greedy_data["rare_soldier"] # has rare_skill
    p_rare = greedy_data["rare_post"]
    p_rare.start_time = time(12, 0)
    p_rare.end_time = time(13, 0) # 1 hour activity
    p_rare.shift_length = timedelta(hours=1)
    p_rare.cooldown = timedelta(hours=0)
    db.commit()
    
    # 2. Setup Skill B (Common, but High Demand)
    # We add more soldiers with Common Skill
    for i in range(8):
        s = Soldier(name=f"Common Soldier {i+10}")
        s.skills.append(greedy_data["common_skill"])
        db.add(s)
    db.commit()
    
    # Total common soldiers = 2 (initial) + 8 = 10
    # Demand for common skill: 24/7 post with 4h shift and 4h cooldown.
    # Sustain ratio = (4+4)/4 = 2.0. Active ratio = 24/24 = 1.0. Total demand = 2.0 per slot.
    # Our p_common has 1 slot. So demand = 2.0.
    # Criticality B = 2.0 / 10 = 0.2
    
    # Rare skill demand: (1+0)/1 = 1.0. Active ratio = 1/24. Total demand = 1/24 = 0.0416.
    # Criticality A = 0.0416 / 1 = 0.0416.
    
    # Even though Skill A has fewer soldiers (1 vs 10), Skill B is more critical (0.2 vs 0.04).
    # So Common Post should be processed FIRST.
    
    start = datetime(2026, 1, 1, 0, 0)
    end = datetime(2026, 1, 1, 23, 0)
    
    shifts_rare = generate_shifts([p_rare], start, end, db)
    shifts_common = generate_shifts([greedy_data["common_post"]], start, end, db)
    
    all_shifts = shifts_rare + shifts_common
    all_soldiers = db.query(Soldier).all()
    
    assignments = solve_shift_assignment_greedy(all_shifts, all_soldiers, session=db)
    
    # The first assignment should be for a Common Post shift because it's more critical.
    # (Note: sorted_shifts[0] is used for the first assignment in our loop)
    assert assignments[0].shift.post_name == "Common Post"

def test_greedy_duration_ordering(db, greedy_data):
    """
    Test that longer shifts are prioritized when rarity is equal.
    """
    common_soldiers = greedy_data["common_soldiers"]
    common_post = greedy_data["common_post"] # 4h shift, starts at 00:00
    
    # New post: Long common post, starts at 00:00, 8h duration
    long_common_post = Post(name="Long Common", shift_length=timedelta(hours=8), cooldown=timedelta(hours=4), start_time=time(0,0))
    db.add(long_common_post)
    db.add(PostTemplateSlot(post=long_common_post, role_index=0, skill=greedy_data["common_skill"]))
    db.commit()
    
    start = datetime(2026, 1, 1, 0, 0)
    end = datetime(2026, 1, 1, 12, 0)
    
    shifts_short = generate_shifts([common_post], start, end, db)
    shifts_long = generate_shifts([long_common_post], start, end, db)
    
    all_shifts = shifts_short + shifts_long 
    
    # Use only 1 common soldier to force a choice between overlapping shifts
    # S1 is qualified for both. Rarity is same for both.
    # Long Common (8h) should be processed before Common Post (4h).
    assignments = solve_shift_assignment_greedy(all_shifts, [common_soldiers[0]], session=db)
    
    # They both start at 00:00, so they overlap. Only one should be assigned.
    assert len(assignments) == 1
    assert assignments[0].shift.post_name == "Long Common"
