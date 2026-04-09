from sqlalchemy import create_engine, Column, Integer, String, Text, ForeignKey, DateTime, JSON, PrimaryKeyConstraint, Interval, Time, UniqueConstraint
from sqlalchemy.orm import sessionmaker, relationship, Session, declarative_base
from datetime import datetime, timezone, timedelta,time

Base = declarative_base()

class Soldier(Base):
    __tablename__ = 'soldier'
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(Text, nullable=False)
    age = Column(Integer, nullable=True)
    division = Column(Integer, ForeignKey('division.id'), nullable=True)
    qualifications = Column(JSON, nullable=False, default=['soldier'])

    def __repr__(self):
        return f"<Soldier {self.name}>"

class Division(Base):
    __tablename__ = 'division'
    id = Column(Integer, primary_key=True)
    name = Column(Text, nullable=False)
    commander = Column(Integer, ForeignKey('soldier.id'))

    def __repr__(self):
        return f"<Division {self.name}>"

class Post(Base):
    __tablename__ = 'post'
    # id = Column(Integer, primary_key=True)
    name = Column(Text, primary_key=True)
    shift_length = Column(Interval, nullable=False, default=lambda: timedelta(hours=4))
    start_time = Column(Time, nullable=False, default=lambda: time(6,0,0))
    end_time = Column(Time, nullable=False, default=lambda: time(5,59,0))
    requirements = Column(JSON, nullable=False, default=['soldier'])
    cooldown = Column(Interval, nullable=False, default=lambda: timedelta(hours=0))
    
        
    def __repr__(self):
        return f"<Post {self.name}>"

class Shift(Base):
    __tablename__ = 'shift'
    id = Column(Integer, primary_key=True, autoincrement=True)
    post_name = Column(Text, ForeignKey('post.name'))
    post = relationship("Post")
    start = Column(DateTime, nullable=False)
    end = Column(DateTime, nullable=False)
    
    __table_args__ = (
        UniqueConstraint('post_name', 'start', 'end'),
    )
    
    def __repr__(self):
        return f"<Shift {self.post.name} {self.start} {self.end} >"

class Assignment(Base):
    __tablename__ = 'assignment'
    id = Column(Integer, primary_key=True, autoincrement=True)
    soldier_id = Column(Integer, ForeignKey('soldier.id'),nullable=False)
    soldier = relationship("Soldier")
    shift_id = Column(Integer, ForeignKey('shift.id'), nullable=False)
    shift = relationship("Shift")
    role_id = Column(Integer)
    
    
    __table_args__ = (
        UniqueConstraint('soldier_id', 'shift_id'),
    )
    def __repr__(self):
        return f"<Assignment {self.soldier.name} as number {self.role_id} in {self.shift.post.name} from {self.shift.start} to {self.shift.end} >"
        # return f"<Assignment {self.soldier_id} as number {self.role_id} in {self.shift_id}>"
engine = create_engine('sqlite:///data.db')

# Create the SQLite database (you can change to any other database)
if __name__ == '__main__':
    import os
    if os.path.exists('data.db'):
        os.remove('data.db')
    Base.metadata.create_all(engine)

    Session = sessionmaker(bind=engine)
    session = Session()
    
    posts = [
        Post(name='ש"ג', shift_length=timedelta(hours=4), start_time=time(6,0,0), end_time=time(5,59,0), requirements=['soldier'], cooldown=timedelta(hours=0)),
        Post(name='ק"ד 19', shift_length=timedelta(hours=4), start_time=time(22,0,0), end_time=time(5,59,0), requirements=['soldier'], cooldown=timedelta(hours=0)),
        Post(name='סיור', shift_length=timedelta(hours=8), start_time=time(6,0,0), end_time=time(5,59,0), requirements=['commander'] + ['soldier'] * 2, cooldown=timedelta(hours=0)),
        Post(name='חמל', shift_length=timedelta(hours=8), start_time=time(6,0,0), end_time=time(5,59,0), requirements=['hamalist'], cooldown=timedelta(hours=0)),
        Post(name='תורנות מטבח', shift_length=timedelta(hours=12), start_time=time(9,0,0), end_time=time(20,59,0), requirements=['soldier'] * 2, cooldown=timedelta(hours=0)),
        Post(name='של"ז', shift_length=timedelta(hours=12), start_time=time(9,0,0), end_time=time(8,59,0), requirements=['soldier'], cooldown=timedelta(hours=0)),
        Post(name='חפ"ק', shift_length=timedelta(hours=24), start_time=time(9,0,0), end_time=time(8,59,0), requirements=['senior officer', 'driver', 'medic', 'soldier'], cooldown=timedelta(hours=0)),
        Post(name='מפקד מוצב', shift_length=timedelta(hours=24), start_time=time(6,0,0), end_time=time(5,59,0), requirements=['officer'], cooldown=timedelta(hours=0)),
        # Post(name='יזומה', shift_length=timedelta(hours=24), start_time=time(12,0,0), end_time=time(11,59,0), requirements=['officer', 'commander'] + ['soldier'] * 6, cooldown=timedelta(hours=0)),
        # Post(name='כוננות', shift_length=timedelta(hours=12), start_time=time(12,0,0), end_time=time(11,59,0), requirements=['commander', 'driver'] + ['soldier'] * 6, cooldown=timedelta(hours=0)),
        Post(name='אגרופן', shift_length=timedelta(days=4), start_time=time(12,0,0), end_time=time(11,59,0), requirements=['commander'] + ['soldier'] * 3, cooldown=timedelta(hours=0)),
    ]
    session.add_all(posts)
    session.commit()

    soldiers = [
        Soldier(name="גלעד אשל", division=0, qualifications=["senior officer"]),
        Soldier(name="איתמר לוינסקי", division=0, qualifications=["senior officer"]),
        Soldier(name="מתן חורגין", division=1, qualifications=["officer", "commander"]),
        Soldier(name="אביעד לוי", division=2, qualifications=["officer", "commander"]),
        Soldier(name="שחר דמרי", division=3, qualifications=["officer", "commander"]),
        Soldier(name="נמרוד כהן", division=1, qualifications=["commander"]),
        Soldier(name="עידו אליהו", division=1, qualifications=["commander"]),
        Soldier(name="אורי לוי", division=2, qualifications=["commander"]),
        Soldier(name="תומר לוי", division=1, qualifications=["commander"]),
        Soldier(name="רועי טיילור", division=3, qualifications=["commander"]),
        Soldier(name="מאור אוחנה", division=2, qualifications=["commander"]),
        Soldier(name="עומר דור", division=1, qualifications=["commander"]),
        Soldier(name="יוגב קורקט", division=1, qualifications=["soldier"]),
        Soldier(name="אלדד זהרי", division=1, qualifications=["soldier"]),
        Soldier(name="נתן דוידסון", division=1, qualifications=["soldier"]),
        Soldier(name="אנטולי בסוב", division=1, qualifications=["soldier"]),
        Soldier(name="פיני יוסף", division=2, qualifications=["soldier"]),
        Soldier(name="אביב אלול", division=2, qualifications=["soldier"]),
        Soldier(name="פנחס נייברגר", division=1, qualifications=["soldier"]),
        Soldier(name="יהונתן פלד", division=2, qualifications=["soldier"]),
        Soldier(name="הבטמו בקלה", division=2, qualifications=["soldier"]),
        Soldier(name="חיים ביינסגן", division=1, qualifications=["soldier"]),
        Soldier(name="נתנאל יעקובי", division=1, qualifications=["soldier"]),
        Soldier(name="אלכס ליזינגר", division=1, qualifications=["soldier"]),
        Soldier(name="חגי גרינולד", division=1, qualifications=["soldier"]),
        Soldier(name="גיל אנדרייב", division=1, qualifications=["soldier"]),
        Soldier(name="עומר שחף", division=1, qualifications=["soldier"]),
        Soldier(name="שמעון כהן", division=1, qualifications=["soldier"]),
        Soldier(name="דוד טמליאקוב", division=5, qualifications=["soldier"]),
        Soldier(name="איליה ילקין", division=5, qualifications=["soldier"]),
        Soldier(name="הלל נדיב", division=1, qualifications=["soldier", "driver"]),
        Soldier(name="יוסף פילנט", division=1, qualifications=["soldier", "driver"]),
        Soldier(name="נועם עזרא", division=1, qualifications=["soldier", "medic"]),
        Soldier(name="שמואל ליברמן", division=2, qualifications=["soldier"]),
        Soldier(name="נדב שטרית", division=3, qualifications=["soldier"]),
        Soldier(name="סולומון ניסנוב", division=3, qualifications=["soldier"]),
        Soldier(name="מנדי פורסט", division=1, qualifications=["soldier"]),
        Soldier(name="ויקטור לונדון", division=1, qualifications=["soldier"]),
        Soldier(name="מיכאל סעדון", division=1, qualifications=["soldier"]),
        Soldier(name="יאיר קליין", division=1, qualifications=["soldier", "medic"]),
        Soldier(name="שלמה לינדלבאום", division=1, qualifications=["soldier"]),
        Soldier(name="אביאל דסלה", division=3, qualifications=["soldier"]),
        Soldier(name="אור קינצלר", division=1, qualifications=["hamalist"]),
        Soldier(name="אור בן-צבי", division=1, qualifications=["hamalist"]),
        Soldier(name="דימה פיסמני", division=1, qualifications=["hamalist"]),
    ]
    session.add_all(soldiers)
    session.commit()

