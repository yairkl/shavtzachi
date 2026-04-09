from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from models import Base, Soldier, Skill, Post, PostTemplateSlot, Shift, Assignment, soldier_skill_table, Unavailability, Division
from datetime import datetime, timedelta, time
import os

engine = create_engine('sqlite:///data.db', connect_args={"check_same_thread": False})
Session = sessionmaker(bind=engine)

def init_db(eng=engine):
    Base.metadata.create_all(eng)

if __name__ == '__main__':
    if os.path.exists('data.db'): os.remove('data.db')
    init_db()
    with Session() as session:
        # Seeding
        skill_names = ['רובאי', 'מפקד כיתה', 'סמל מחלקה', 'מפקד מחלקה', 'נהג', 'חובש', 'חמליסט', 'קצין', 'מפקד פלוגה', 'סגן מפקד פלוגה']
        skills = {name: Skill(name=name) for name in skill_names}
        session.add_all(skills.values())
        session.commit()

        soldier_defs = [
            ("גלעד אשל", 0, ["קצין", "מפקד פלוגה"]),
            ("איתמר לוינסקי", 0, ["קצין", "מפקד פלוגה"]),
            ("מתן חורגין", 1, ["קצין", "מפקד מחלקה"]),
            ("אביעד לוי", 2, ["קצין", "מפקד מחלקה"]),
            ("שחר דמרי", 3, ["קצין", "מפקד מחלקה"]),
            ("נמרוד כהן", 1, ["סמל מחלקה"]),
            ("עידו אליהו", 1, ["סמל מחלקה"]),
            ("עומר דור", 1, ["סמל מחלקה"]),
            ("אורי לוי", 2, ["מפקד כיתה"]),
            ("תומר לוי", 1, ["מפקד כיתה"]),
            ("רועי טיילור", 3, ["מפקד כיתה"]),
            ("מאור אוחנה", 2, ["מפקד כיתה"]),
            ("יוגב קורקט", 1, ["רובאי"]),
            ("אלדד זהרי", 1, ["רובאי"]),
            ("נתן דוידסון", 1, ["רובאי"]),
            ("אנטולי בסוב", 1, ["רובאי"]),
            ("פיני יוסף", 2, ["רובאי"]),
            ("אביב אלול", 2, ["רובאי"]),
            ("פנחס נייברגר", 1, ["רובאי"]),
            ("יהונתן פלד", 2, ["רובאי"]),
            ("הבטמו בקלה", 2, ["רובאי"]),
            ("חיים ביינסגן", 1, ["רובאי"]),
            ("נתנאל יעקובי", 1, ["רובאי"]),
            ("אלכס ליזינגר", 1, ["רובאי"]),
            ("חגי גרינולד", 1, ["רובאי"]),
            ("גיל אנדרייב", 1, ["רובאי"]),
            ("עומר שחף", 1, ["רובאי"]),
            ("שמעון כהן", 1, ["רובאי"]),
            ("דוד טמליאקוב", 5, ["רובאי"]),
            ("איליה ילקין", 5, ["רובאי"]),
            ("הלל נדיב", 1, ["רובאי", "נהג"]),
            ("יוסף פילנט", 1, ["רובאי", "נהג"]),
            ("נועם עזרא", 1, ["רובאי", "חובש"]),
            ("שמואל ליברמן", 2, ["רובאי"]),
            ("נדב שטרית", 3, ["רובאי"]),
            ("סולומון ניסנוב", 3, ["רובאי"]),
            ("מנדי פורסט", 1, ["רובאי"]),
            ("ויקטור לונדון", 1, ["רובאי"]),
            ("מיכאל סעדון", 1, ["רובאי"]),
            ("יאיר קליין", 1, ["רובאי", "חובש"]),
            ("שלמה לינדלבאום", 1, ["רובאי"]),
            ("אביאל דסלה", 3, ["רובאי"]),
            ("אור קינצלר", 1, ["חמליסט"]),
            ("אור בן-צבי", 1, ["חמליסט"]),
            ("דימה פיסמני", 1, ["חמליסט"]),
        ]

        for s_name, div, s_skills in soldier_defs:
            s = Soldier(name=s_name, division=div)
            for s_skill in s_skills:
                s.skills.append(skills[s_skill])
            session.add(s)

        post_defs = [
            ("תל 3", 4, time(6,0), time(5,59), 8, 1.0, ["רובאי"]),
            ("תל 9", 4, time(6,0), time(5,59), 8, 1.0, ["רובאי"]),
            ("תל 11", 4, time(6,0), time(5,59), 8, 1.0, ["רובאי"]),
            ("תל 7", 4, time(6,0), time(5,59), 8, 1.0, ["רובאי"]),
            ("מטבח", 12, time(6,0), time(5,59), 12, 2.0, ["רובאי", "רובאי"]),
            ("חסם שוטר", 4, time(6,0), time(5,59), 8, 1.0, ["מפקד כיתה", "רובאי"]),
        ]

        for p_name, length, start, end, cooldown, weight, p_slots in post_defs:
            post = Post(
                name=p_name,
                shift_length=timedelta(hours=length),
                start_time=start,
                end_time=end,
                cooldown=timedelta(hours=cooldown),
                intensity_weight=weight
            )
            session.add(post)
            for i, sk_name in enumerate(p_slots):
                session.add(PostTemplateSlot(post=post, role_index=i, skill=skills[sk_name]))

        session.commit()
