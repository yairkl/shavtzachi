from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from models import Base, Soldier, Skill, Post, PostTemplateSlot, Shift, Assignment, soldier_skill_table, Unavailability, Division
from datetime import datetime, timedelta, time
import os
import pandas as pd
engine = create_engine('sqlite:///data.db', connect_args={"check_same_thread": False})
Session = sessionmaker(bind=engine)

def init_db(eng=engine):
    Base.metadata.create_all(eng)

if __name__ == '__main__':
    if os.path.exists('data.db'): os.remove('data.db')
    init_db()
    with Session() as session:
        # Seeding
        skill_names = ['רובאי', 'מפקד', 'סמל', 'מפקד מחלקה', 'נהג', 'חובש', 'חמליסט', 'קצין', 'מפקד פלוגה', 'קשר']
        skills = {name: Skill(name=name) for name in skill_names}
        session.add_all(skills.values())
        session.commit()

        soldiers = pd.read_csv("data/soldiers.csv")
        for i, soldier in soldiers.iterrows():
            s = Soldier(name=soldier["name"], division=soldier["division"])
            for s_skill in soldier["skills"].split(","):
                s.skills.append(skills[s_skill])
            session.add(s)

        posts = pd.read_csv("data/posts.csv")
        for i, post in posts.iterrows():
            p = Post(
                name=post["name"],
                shift_length=timedelta(hours=post["shift_length_hours"]),
                start_time=datetime.strptime(post["start_time"], "%H:%M").time(),
                end_time=datetime.strptime(post["end_time"], "%H:%M").time(),
                cooldown=timedelta(hours=post["cooldown_hours"]),
                intensity_weight=post["intensity_weight"]
            )
            session.add(p)
            for i, sk_name in enumerate(post["slots"].split(",")):
                session.add(PostTemplateSlot(post=p, role_index=i, skill=skills[sk_name]))

        session.commit()
