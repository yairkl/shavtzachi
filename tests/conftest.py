import pytest
import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from main import app, get_db


# ---------------------------------------------------------------------------
# SQLite fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def sqlite_test_engine():
    """Create a temporary SQLite database for the test session."""
    from models import Base
    test_db = "test_data.db"
    if os.path.exists(test_db):
        os.remove(test_db)

    engine = create_engine(f"sqlite:///{test_db}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)

    yield engine

    engine.dispose()
    if os.path.exists(test_db):
        os.remove(test_db)


# ---------------------------------------------------------------------------
# GSheets fixtures (only resolved when engine_type == "gsheets")
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def gsheets_test_spreadsheets():
    """Provision temporary Google Sheets for a test session.

    Skips automatically when no valid token.json is present.
    To generate a token, run: python setup_sheets.py
    """
    # Lazy imports so non-gsheets test runs don't require google libs
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google.auth.exceptions import RefreshError
    from googleapiclient.discovery import build

    SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

    if not os.path.exists("token.json"):
        pytest.skip("No token.json found. Run `python setup_sheets.py` to authenticate.")

    creds = Credentials.from_authorized_user_file("token.json", SCOPES)

    if not creds.valid:
        if creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                with open("token.json", "w") as token_file:
                    token_file.write(creds.to_json())
            except RefreshError as e:
                # Token has been revoked — delete it so setup_sheets.py can re-auth cleanly
                os.remove("token.json")
                pytest.skip(
                    f"Google token was revoked or expired permanently ({e}). "
                    "Run `python setup_sheets.py` to re-authenticate."
                )
            except Exception as e:
                pytest.skip(f"Failed to refresh Google token: {e}. Run `python setup_sheets.py`.")
        else:
            pytest.skip("Google token is invalid. Run `python setup_sheets.py` to re-authenticate.")


    sheets_service = build("sheets", "v4", credentials=creds)

    # Try drive service for cleanup; don't fail if scope is missing
    drive_service = None
    try:
        drive_creds = Credentials.from_authorized_user_file(
            "token.json", ["https://www.googleapis.com/auth/drive"]
        )
        if drive_creds and drive_creds.valid:
            drive_service = build("drive", "v3", credentials=drive_creds)
    except Exception:
        pass

    print("\n[Pytest] Provisioning temporary Google Sheets for testing...")
    input_body = {
        "properties": {"title": "TEST_SHAVTZ_TRACKER"},
        "sheets": [
            {"properties": {"title": "Soldiers"}, "data": [{"rowData": [{"values": [
                {"userEnteredValue": {"stringValue": "Name"}},
                {"userEnteredValue": {"stringValue": "Division"}},
                {"userEnteredValue": {"stringValue": "Skills"}},
                {"userEnteredValue": {"stringValue": "Excluded Posts"}},
            ]}]}]},
            {"properties": {"title": "Posts"}, "data": [{"rowData": [{"values": [
                {"userEnteredValue": {"stringValue": "Name"}},
                {"userEnteredValue": {"stringValue": "Shift Length (hrs)"}},
                {"userEnteredValue": {"stringValue": "Start Time"}},
                {"userEnteredValue": {"stringValue": "End Time"}},
                {"userEnteredValue": {"stringValue": "Cooldown (hrs)"}},
                {"userEnteredValue": {"stringValue": "Intensity Weight"}},
                {"userEnteredValue": {"stringValue": "Slots"}},
                {"userEnteredValue": {"stringValue": "Is Active"}},
                {"userEnteredValue": {"stringValue": "Active From"}},
                {"userEnteredValue": {"stringValue": "Active Until"}},
            ]}]}]},
            {"properties": {"title": "Unavailabilities"}, "data": [{"rowData": [{"values": [
                {"userEnteredValue": {"stringValue": "Soldier Name"}},
                {"userEnteredValue": {"stringValue": "Start DateTime"}},
                {"userEnteredValue": {"stringValue": "End DateTime"}},
                {"userEnteredValue": {"stringValue": "Reason"}},
            ]}]}]},
            {"properties": {"title": "Skills"}, "data": [{"rowData": [{"values": [
                {"userEnteredValue": {"stringValue": "Name"}},
            ]}]}]},
        ],
    }
    output_body = {"properties": {"title": "TEST_SHAVTZ_SCHEDULES"}}

    res1 = sheets_service.spreadsheets().create(body=input_body).execute()
    res2 = sheets_service.spreadsheets().create(body=output_body).execute()

    in_id = res1["spreadsheetId"]
    out_id = res2["spreadsheetId"]

    yield {"INPUT_SPREADSHEET_ID": in_id, "OUTPUT_SPREADSHEET_ID": out_id}

    print("\n[Pytest] Deleting temporary Google Sheets...")
    if drive_service:
        try:
            drive_service.files().delete(fileId=in_id).execute()
            drive_service.files().delete(fileId=out_id).execute()
        except Exception as e:
            print(f"Failed to delete test sheets: {e}")


# ---------------------------------------------------------------------------
# Backend parametrisation
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session", params=["sqlite", "gsheets"])
def engine_type(request):
    return request.param


# ---------------------------------------------------------------------------
# Primary db fixture — selects backend, clears state before each test
# ---------------------------------------------------------------------------

@pytest.fixture
def db(engine_type, sqlite_test_engine, request):
    """Provide a clean ShavtzachiDB for each test, for the requested backend."""

    if engine_type == "sqlite":
        from database_sqlite import ShavtzachiDB as SQLiteDB
        from database_sqlite import database_sqlite_engine_override
        from models import Base

        database_sqlite_engine_override(sqlite_test_engine)
        SessionLocal = sessionmaker(bind=sqlite_test_engine)
        session = SessionLocal()

        db_instance = SQLiteDB(session)
        db_instance.clear_all_data()

        yield db_instance
        session.close()

    elif engine_type == "gsheets":
        # Only fetch the gsheets fixture when actually needed — if it skips,
        # only gsheets-parameterised tests are affected.
        ids = request.getfixturevalue("gsheets_test_spreadsheets")

        from database_gsheets import ShavtzachiDB as GSheetsDB

        db_instance = GSheetsDB(
            input_sheet_id=ids["INPUT_SPREADSHEET_ID"],
            output_sheet_id=ids["OUTPUT_SPREADSHEET_ID"],
        )
        db_instance.clear_all_data()

        yield db_instance


# ---------------------------------------------------------------------------
# FastAPI dependency override — inject the test db into every request
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def override_get_db(db):
    def _get_db_override():
        yield db

    app.dependency_overrides[get_db] = _get_db_override
    yield
    app.dependency_overrides.clear()
