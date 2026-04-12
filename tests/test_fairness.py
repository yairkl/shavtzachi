import pytest
from datetime import datetime, timedelta
from collections import Counter
from models import Post, Soldier, Skill, PostTemplateSlot
from schedule import generate_shifts, solve_shift_assignment


@pytest.fixture
def skill_fair(db):
    s = Skill(name="guard_fair")
    db.add(s); db.commit(); return s


@pytest.fixture
def skill_driver_fair(db):
    s = Skill(name="driver_fair")
    db.add(s); db.commit(); return s


def _count_assignments(assignments):
    """Return a Counter of soldier_id -> number of assignments."""
    return Counter(a.soldier_id for a in assignments)


def test_even_distribution_same_skill(db, skill_fair):
    """5 soldiers, 5 shifts on 1 post — each soldier should get exactly 1 shift."""
    post = Post(name="Fair_Gate", shift_length=timedelta(hours=4), intensity_weight=1.0)
    db.add(post)
    db.add(PostTemplateSlot(post=post, role_index=0, skill=skill_fair))

    soldiers = []
    for i in range(5):
        s = Soldier(name=f"Soldier_{i}")
        s.skills.append(skill_fair)
        db.add(s)
        soldiers.append(s)
    db.commit()

    # 20 hours → 5 shifts of 4h each
    start = datetime(2025, 1, 1, 0, 0)
    end = datetime(2025, 1, 1, 20, 0)
    shifts = generate_shifts([post], start, end)
    for i, s in enumerate(shifts): s.id = i + 200

    assignments = solve_shift_assignment(shifts, soldiers)
    counts = _count_assignments(assignments)

    # All 5 shifts should be filled
    assert len(assignments) == 5
    # Each soldier should get exactly 1
    for s in soldiers:
        assert counts[s.id] == 1, f"Soldier {s.name} got {counts[s.id]} shifts, expected 1"


def test_no_idle_while_others_doubled(db, skill_fair):
    """6 soldiers, 6 shifts over 2 days — spread should be at most 1."""
    post = Post(name="Fair_Gate2", shift_length=timedelta(hours=4), intensity_weight=1.0)
    db.add(post)
    db.add(PostTemplateSlot(post=post, role_index=0, skill=skill_fair))

    soldiers = []
    for i in range(6):
        s = Soldier(name=f"Fairness_{i}")
        s.skills.append(skill_fair)
        db.add(s)
        soldiers.append(s)
    db.commit()

    # 24 hours = 6 shifts
    start = datetime(2025, 1, 1, 0, 0)
    end = datetime(2025, 1, 2, 0, 0)
    shifts = generate_shifts([post], start, end)
    for i, s in enumerate(shifts): s.id = i + 300

    assignments = solve_shift_assignment(shifts, soldiers)
    counts = _count_assignments(assignments)

    assert len(assignments) == 6
    # Each soldier should get exactly 1; spread must be 0
    max_count = max(counts.values())
    min_count = min(counts.values()) if len(counts) == len(soldiers) else 0
    assert max_count - min_count <= 1, f"Unfair spread: {dict(counts)}"
    # No soldier should be idle
    assert len(counts) == len(soldiers), f"Only {len(counts)}/{len(soldiers)} soldiers got shifts"


def test_fair_with_more_shifts_than_soldiers(db, skill_fair):
    """3 soldiers, 9 shifts — each should get exactly 3."""
    post = Post(name="Fair_Gate3", shift_length=timedelta(hours=4), intensity_weight=1.0)
    db.add(post)
    db.add(PostTemplateSlot(post=post, role_index=0, skill=skill_fair))

    soldiers = []
    for i in range(3):
        s = Soldier(name=f"Triple_{i}")
        s.skills.append(skill_fair)
        db.add(s)
        soldiers.append(s)
    db.commit()

    # 36 hours = 9 shifts of 4h
    start = datetime(2025, 1, 1, 0, 0)
    end = datetime(2025, 1, 2, 12, 0)
    shifts = generate_shifts([post], start, end)
    for i, s in enumerate(shifts): s.id = i + 400

    assignments = solve_shift_assignment(shifts, soldiers)
    counts = _count_assignments(assignments)

    assert len(assignments) == 9
    for s in soldiers:
        assert counts[s.id] == 3, f"Soldier {s.name} got {counts[s.id]} shifts, expected 3"


def test_history_scores_bias_toward_underloaded(db, skill_fair):
    """2 soldiers, 1 shift — soldier with lower history should be preferred."""
    post = Post(name="Fair_Gate4", shift_length=timedelta(hours=4), intensity_weight=1.0)
    db.add(post)
    db.add(PostTemplateSlot(post=post, role_index=0, skill=skill_fair))

    s1 = Soldier(name="HighHistory")
    s1.skills.append(skill_fair)
    s2 = Soldier(name="LowHistory")
    s2.skills.append(skill_fair)
    db.add(s1); db.add(s2)
    db.commit()

    start = datetime(2025, 1, 1, 0, 0)
    end = datetime(2025, 1, 1, 4, 0)
    shifts = generate_shifts([post], start, end)
    for i, s in enumerate(shifts): s.id = i + 500

    # s1 has done much more work historically
    history = {s1.id: 100.0, s2.id: 10.0}
    assignments = solve_shift_assignment(shifts, [s1, s2], history_scores=history)

    assert len(assignments) == 1
    assert assignments[0].soldier_id == s2.id, "Solver should prefer the soldier with lower history"


def test_fairness_with_mixed_skills(db, skill_fair, skill_driver_fair):
    """4 soldiers: 3 guards + 1 driver. Guard post has 6 shifts.
    
    All 3 guards should share the 6 shifts evenly (2 each).
    The driver should get 0 (unqualified)."""
    post = Post(name="Guard_Only_Post", shift_length=timedelta(hours=4), intensity_weight=1.0)
    db.add(post)
    db.add(PostTemplateSlot(post=post, role_index=0, skill=skill_fair))

    guards = []
    for i in range(3):
        s = Soldier(name=f"Guard_{i}")
        s.skills.append(skill_fair)
        db.add(s)
        guards.append(s)

    driver = Soldier(name="Driver_Only")
    driver.skills.append(skill_driver_fair)
    db.add(driver)
    db.commit()

    all_soldiers = guards + [driver]

    start = datetime(2025, 1, 1, 0, 0)
    end = datetime(2025, 1, 2, 0, 0)  # 24h = 6 shifts of 4h
    shifts = generate_shifts([post], start, end)
    for i, s in enumerate(shifts): s.id = i + 600

    assignments = solve_shift_assignment(shifts, all_soldiers)
    counts = _count_assignments(assignments)

    assert len(assignments) == 6
    # Driver should not be assigned
    assert driver.id not in counts, "Driver should not be assigned to guard post"
    # Each guard should get 2 shifts
    for g in guards:
        assert counts[g.id] == 2, f"{g.name} got {counts[g.id]} shifts, expected 2"


def test_daily_spread_across_multiple_posts(db, skill_fair):
    """4 soldiers, 2 posts, 1 day — 2 shifts each = 4 total slots.
    
    Each soldier should get exactly 1 shift."""
    p1 = Post(name="Post_Alpha", shift_length=timedelta(hours=4), intensity_weight=1.0)
    db.add(p1); db.add(PostTemplateSlot(post=p1, role_index=0, skill=skill_fair))
    
    p2 = Post(name="Post_Beta", shift_length=timedelta(hours=4), intensity_weight=1.0)
    db.add(p2); db.add(PostTemplateSlot(post=p2, role_index=0, skill=skill_fair))

    soldiers = []
    for i in range(4):
        s = Soldier(name=f"Multi_{i}")
        s.skills.append(skill_fair)
        db.add(s)
        soldiers.append(s)
    db.commit()

    # 8 hours = 2 shifts per post = 4 total
    start = datetime(2025, 1, 1, 0, 0)
    end = datetime(2025, 1, 1, 8, 0)
    shifts = generate_shifts([p1, p2], start, end)
    for i, s in enumerate(shifts): s.id = i + 700

    assignments = solve_shift_assignment(shifts, soldiers)
    counts = _count_assignments(assignments)

    assert len(assignments) == 4
    # Each soldier should get exactly 1
    for s in soldiers:
        assert counts[s.id] == 1, f"{s.name} got {counts.get(s.id, 0)} shifts, expected 1"


def _min_rest_gap(assignments, soldier_id):
    """Compute the minimum rest gap (hours) between consecutive shifts for a soldier."""
    soldier_shifts = sorted(
        [a.shift for a in assignments if a.soldier_id == soldier_id],
        key=lambda s: s.start
    )
    if len(soldier_shifts) < 2:
        return float('inf')
    gaps = [(soldier_shifts[i+1].start - soldier_shifts[i].end).total_seconds() / 3600
            for i in range(len(soldier_shifts) - 1)]
    return min(gaps)


def test_rest_maximization(db, skill_fair):
    """2 soldiers, 4 shifts (16h) — solver should space each soldier's shifts apart.
    
    Optimal: each soldier gets 2 shifts, spaced 8h apart (e.g. 0-4 & 8-12, 4-8 & 12-16)
    rather than back-to-back (e.g. 0-4 & 4-8)."""
    post = Post(name="Rest_Post", shift_length=timedelta(hours=4), intensity_weight=1.0)
    db.add(post)
    db.add(PostTemplateSlot(post=post, role_index=0, skill=skill_fair))

    soldiers = []
    for i in range(2):
        s = Soldier(name=f"Rest_{i}")
        s.skills.append(skill_fair)
        db.add(s)
        soldiers.append(s)
    db.commit()

    # 16 hours = 4 shifts of 4h: 0-4, 4-8, 8-12, 12-16
    start = datetime(2025, 1, 1, 0, 0)
    end = datetime(2025, 1, 1, 16, 0)
    shifts = generate_shifts([post], start, end)
    for i, s in enumerate(shifts): s.id = i + 800

    assignments = solve_shift_assignment(shifts, soldiers)
    counts = _count_assignments(assignments)

    # Each soldier should get 2 shifts
    assert len(assignments) == 4
    for s in soldiers:
        assert counts[s.id] == 2, f"{s.name} got {counts[s.id]} shifts, expected 2"

    # Each soldier's min rest should be > 0 (not back-to-back)
    # With optimal spacing, rest gap should be 4h (alternating: A, B, A, B)
    for s in soldiers:
        gap = _min_rest_gap(assignments, s.id)
        assert gap >= 4.0, (
            f"{s.name} has rest gap of {gap:.1f}h, expected >= 4h (shifts should be spaced apart)"
        )


def test_rest_fairness_across_soldiers(db, skill_fair):
    """3 soldiers, 6 shifts over 24h — rest gaps should be similar for all soldiers.
    
    Each soldier gets 2 shifts. The solver should distribute so all soldiers
    have comparable rest, not give one soldier back-to-back and another widely spaced."""
    post = Post(name="RestFair_Post", shift_length=timedelta(hours=4), intensity_weight=1.0)
    db.add(post)
    db.add(PostTemplateSlot(post=post, role_index=0, skill=skill_fair))

    soldiers = []
    for i in range(3):
        s = Soldier(name=f"RestFair_{i}")
        s.skills.append(skill_fair)
        db.add(s)
        soldiers.append(s)
    db.commit()

    # 24 hours = 6 shifts of 4h
    start = datetime(2025, 1, 1, 0, 0)
    end = datetime(2025, 1, 2, 0, 0)
    shifts = generate_shifts([post], start, end)
    for i, s in enumerate(shifts): s.id = i + 900

    assignments = solve_shift_assignment(shifts, soldiers)
    counts = _count_assignments(assignments)

    assert len(assignments) == 6
    for s in soldiers:
        assert counts[s.id] == 2

    # All soldiers should have similar min-rest gaps
    rest_gaps = [_min_rest_gap(assignments, s.id) for s in soldiers]
    rest_spread = max(rest_gaps) - min(rest_gaps)
    # With the optimal stagger pattern (A,B,C,A,B,C), all soldiers get 8h rest
    assert rest_spread <= 4.0, (
        f"Rest gap spread is {rest_spread:.1f}h (gaps: {[f'{g:.1f}h' for g in rest_gaps]}). "
        f"Soldiers should have similar rest between their shifts."
    )
    # Each soldier should have at least 4h rest (shifts spaced by at least 1 shift)
    for s, gap in zip(soldiers, rest_gaps):
        assert gap >= 4.0, (
            f"{s.name} has rest gap of {gap:.1f}h, expected >= 4h"
        )

