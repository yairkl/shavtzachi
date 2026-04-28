import pytest
from database import Soldier, Skill, Post, PostTemplateSlot
from datetime import timedelta, time

def test_soldier_creation(db):
    new_soldier = Soldier(name="Test Soldier")
    db.add(new_soldier)
    db.commit()
    
    retrieved = db.get_soldier_by_name("Test Soldier")
    assert retrieved.name == "Test Soldier"

def test_post_relationship(db):
    skill = Skill(name="test_skill")
    db.add(skill)
    db.commit()
    
    post = Post(name="Test Post", shift_length=timedelta(hours=4), start_time=time(6,0), end_time=time(10,0))
    slot = PostTemplateSlot(post=post, role_index=0, skill=skill)
    db.add(post)
    db.add(slot)
    db.commit()
    
    assert len(post.slots) == 1
    assert post.slots[0].skill.name == "test_skill"
