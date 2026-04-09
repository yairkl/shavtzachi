import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import database
from main import app, get_db
import os

@pytest.fixture(scope="session", autouse=True)
def test_setup():
    test_db = "test_data.db"
    if os.path.exists(test_db):
        os.remove(test_db)
    
    # Session-wide engine on a separate file
    engine = create_engine(f"sqlite:///{test_db}", connect_args={"check_same_thread": False})
    database.Base.metadata.create_all(engine)
    
    # Patch only the Session and engine, not the models
    database.engine = engine
    database.Session = sessionmaker(bind=engine)
    
    yield
    
    engine.dispose()
    if os.path.exists(test_db):
        os.remove(test_db)

@pytest.fixture
def db():
    # Provide a session and ensure it is cleaned up between tests
    with database.Session() as session:
        # Clear data before each test
        from models import Soldier, Post, Skill, Shift, Assignment, PostTemplateSlot, soldier_skill_table
        session.execute(soldier_skill_table.delete())
        session.query(Assignment).delete()
        session.query(Shift).delete()
        session.query(PostTemplateSlot).delete()
        session.query(Post).delete()
        session.query(Soldier).delete()
        session.query(Skill).delete()
        session.commit()
        
        yield session

@pytest.fixture(autouse=True)
def override_get_db(db):
    def _get_db_override():
        yield db
    app.dependency_overrides[get_db] = _get_db_override
    yield
    app.dependency_overrides.clear()
