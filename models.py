from sqlalchemy import Column, Integer, Text, ForeignKey, DateTime, Interval, Time, UniqueConstraint, Float, Table
from sqlalchemy.orm import relationship, declarative_base
from datetime import timedelta, time

Base = declarative_base()

def get_soldier_skill_table(metadata):
    if 'soldier_skill' in metadata.tables:
        return metadata.tables['soldier_skill']
    return Table(
        'soldier_skill',
        metadata,
        Column('soldier_id', Integer, ForeignKey('soldier.id'), primary_key=True),
        Column('skill_id', Integer, ForeignKey('skill.id'), primary_key=True),
        extend_existing=True
    )

soldier_skill_table = get_soldier_skill_table(Base.metadata)

def get_soldier_excluded_post_table(metadata):
    if 'soldier_excluded_post' in metadata.tables:
        return metadata.tables['soldier_excluded_post']
    return Table(
        'soldier_excluded_post',
        metadata,
        Column('soldier_id', Integer, ForeignKey('soldier.id'), primary_key=True),
        Column('post_name', Text, ForeignKey('post.name'), primary_key=True),
        extend_existing=True
    )

soldier_excluded_post_table = get_soldier_excluded_post_table(Base.metadata)

class Skill(Base):
    __tablename__ = 'skill'
    __table_args__ = {'extend_existing': True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(Text, nullable=False, unique=True)
    soldiers = relationship('Soldier', secondary=soldier_skill_table, back_populates='skills')

class Soldier(Base):
    __tablename__ = 'soldier'
    __table_args__ = {'extend_existing': True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(Text, nullable=False)
    age = Column(Integer, nullable=True)
    division = Column(Integer, ForeignKey('division.id'), nullable=True)
    skills = relationship('Skill', secondary=soldier_skill_table, back_populates='soldiers')
    excluded_posts = relationship('Post', secondary=soldier_excluded_post_table)
    unavailabilities = relationship('Unavailability', back_populates='soldier')

class Unavailability(Base):
    __tablename__ = 'unavailability'
    __table_args__ = {'extend_existing': True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    soldier_id = Column(Integer, ForeignKey('soldier.id'), nullable=False)
    start_datetime = Column(DateTime, nullable=False)
    end_datetime = Column(DateTime, nullable=False)
    reason = Column(Text, nullable=True)
    soldier = relationship("Soldier", back_populates="unavailabilities")

class Division(Base):
    __tablename__ = 'division'
    __table_args__ = {'extend_existing': True}
    id = Column(Integer, primary_key=True)
    name = Column(Text, nullable=False)
    commander = Column(Integer, ForeignKey('soldier.id'))

class Post(Base):
    __tablename__ = 'post'
    __table_args__ = {'extend_existing': True}
    name = Column(Text, primary_key=True)
    shift_length = Column(Interval, nullable=False, default=lambda: timedelta(hours=4))
    start_time = Column(Time, nullable=False, default=lambda: time(6,0,0))
    end_time = Column(Time, nullable=False, default=lambda: time(5,59,0))
    cooldown = Column(Interval, nullable=False, default=lambda: timedelta(hours=0))
    intensity_weight = Column(Float, nullable=False, default=1.0)
    is_active = Column(Integer, nullable=False, default=1)
    active_from = Column(DateTime, nullable=True)
    active_until = Column(DateTime, nullable=True)
    slots = relationship("PostTemplateSlot", back_populates="post", cascade="all, delete, delete-orphan")

class PostTemplateSlot(Base):
    __tablename__ = 'post_template_slot'
    __table_args__ = {'extend_existing': True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    post_name = Column(Text, ForeignKey('post.name'), nullable=False)
    role_index = Column(Integer, nullable=False)
    req_skill_id = Column(Integer, ForeignKey('skill.id'), nullable=False)
    post = relationship("Post", back_populates="slots")
    skill = relationship("Skill")

class Shift(Base):
    __tablename__ = 'shift'
    __table_args__ = (UniqueConstraint('post_name', 'start', 'end'), {'extend_existing': True})
    id = Column(Integer, primary_key=True, autoincrement=True)
    post_name = Column(Text, ForeignKey('post.name'))
    post = relationship("Post")
    start = Column(DateTime, nullable=False)
    end = Column(DateTime, nullable=False)

class Assignment(Base):
    __tablename__ = 'assignment'
    __table_args__ = (UniqueConstraint('soldier_id', 'shift_id'), {'extend_existing': True})
    id = Column(Integer, primary_key=True, autoincrement=True)
    soldier_id = Column(Integer, ForeignKey('soldier.id'),nullable=False)
    soldier = relationship("Soldier")
    shift_id = Column(Integer, ForeignKey('shift.id'), nullable=False)
    shift = relationship("Shift")
    role_id = Column(Integer)
