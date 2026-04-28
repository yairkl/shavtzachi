"""
database.py — Single entry point for database access.

This module is the ONLY place that decides which database backend to use.
All other modules (main.py, schedule.py, tests) should import ShavtzachiDB
exclusively from here.

Backend selection logic:
  - If config.json contains valid INPUT_SPREADSHEET_ID → use Google Sheets backend
  - Otherwise → use SQLite backend
"""

import os
import json
import logging

logger = logging.getLogger(__name__)

CONFIG_FILE = 'config.json'


def _load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r') as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _is_gsheets_configured(config: dict) -> bool:
    return bool(config.get("INPUT_SPREADSHEET_ID"))


def _create_db_instance():
    config = _load_config()
    if _is_gsheets_configured(config):
        logger.info("Database backend: Google Sheets")
        from database_gsheets import ShavtzachiDB as GSheetDB
        return GSheetDB(
            input_sheet_id=config["INPUT_SPREADSHEET_ID"],
            output_sheet_id=config.get("OUTPUT_SPREADSHEET_ID")
        )
    else:
        logger.info("Database backend: SQLite")
        from database_sqlite import ShavtzachiDB as SQLiteDB, init_db, Session
        init_db_engine = _get_sqlite_engine()
        init_db(init_db_engine)
        session = Session()
        return SQLiteDB(session)


def _get_sqlite_engine():
    from sqlalchemy import create_engine
    return create_engine('sqlite:///data.db', connect_args={"check_same_thread": False})


# Re-export models and Base for backward compatibility
# (test files and other modules that do `from database import Soldier` etc.)
from models import Base, Soldier, Skill, Post, PostTemplateSlot, Shift, Assignment
from models import soldier_skill_table, Unavailability, Division


# Lazy singleton — resolved on first call to get_db()
_db_instance = None


def get_db_instance():
    """Return the application-wide ShavtzachiDB singleton."""
    global _db_instance
    if _db_instance is None:
        _db_instance = _create_db_instance()
    return _db_instance


def reset_db_instance():
    """Force recreation of the DB singleton (used in tests)."""
    global _db_instance
    _db_instance = None


# Expose ShavtzachiDB as the public type for type hints.
# We resolve it lazily to avoid importing gsheets libs unless actually needed.
def _get_shavtzachi_db_class():
    config = _load_config()
    if _is_gsheets_configured(config):
        from database_gsheets import ShavtzachiDB
    else:
        from database_sqlite import ShavtzachiDB
    return ShavtzachiDB


# Make `ShavtzachiDB` importable from this module for isinstance checks / Depends()
class ShavtzachiDB:
    """
    Proxy type used for type annotations and isinstance checks.
    The actual implementation is either database_sqlite.ShavtzachiDB
    or database_gsheets.ShavtzachiDB.
    """
    pass


def init_db(eng=None):
    """Initialise the database schema (SQLite only; no-op for GSheets)."""
    config = _load_config()
    if not _is_gsheets_configured(config):
        from database_sqlite import init_db as sqlite_init_db
        if eng is None:
            eng = _get_sqlite_engine()
        sqlite_init_db(eng)
