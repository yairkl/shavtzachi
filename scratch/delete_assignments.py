from database import Session
from models import Assignment

def delete_all_assignments():
    db = Session()
    try:
        num_deleted = db.query(Assignment).delete()
        db.commit()
        print(f"Deleted {num_deleted} assignments.")
    except Exception as e:
        db.rollback()
        print(f"Error: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    delete_all_assignments()
