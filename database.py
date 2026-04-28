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

import sys

def get_base_path():
    """Get the directory where the executable or main script is located."""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.abspath(".")

def get_resource_path(relative_path):
    """Get absolute path to resource, works for dev and for PyInstaller."""
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, relative_path)
    return os.path.join(os.path.abspath("."), relative_path)

CONFIG_FILE = os.path.join(get_base_path(), 'config.json')
TOKEN_FILE = os.path.join(get_base_path(), 'token.json')
DB_FILE = os.path.join(get_base_path(), 'data.db')
CREDENTIALS_FILE = get_resource_path('credentials.json')
# If an external credentials.json exists next to the exe, it can override the bundled one
EXTERNAL_CREDENTIALS_FILE = os.path.join(get_base_path(), 'credentials.json')


def load_config():
    """Load config.json from external file or bundled resource."""
    # Try external first (next to the executable)
    logger.info(f"Checking for external config at: {CONFIG_FILE}")
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r') as f:
                config = json.load(f)
                logger.info(f"Loaded config from external file: {CONFIG_FILE}")
                return config
        except Exception as e:
            logger.warning(f"Failed to load external config: {e}")
    
    # Try bundled second (inside the executable)
    bundled_config = get_resource_path('config.json')
    logger.info(f"Checking for bundled config at: {bundled_config}")
    if os.path.exists(bundled_config):
        try:
            with open(bundled_config, 'r') as f:
                config = json.load(f)
                logger.info(f"Loaded config from bundled resource: {bundled_config}")
                return config
        except Exception as e:
            logger.warning(f"Failed to load bundled config: {e}")
            
    logger.info("No valid config.json found (external or bundled). Using defaults.")
    return {}


def _is_gsheets_configured(config: dict) -> bool:
    is_cfg = bool(config.get("INPUT_SPREADSHEET_ID"))
    if not is_cfg and config:
        logger.debug(f"Config found but INPUT_SPREADSHEET_ID is missing. Keys: {list(config.keys())}")
    return is_cfg


def _create_db_instance():
    config = load_config()
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
    return create_engine(f'sqlite:///{DB_FILE}', connect_args={"check_same_thread": False})


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
    config = load_config()
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
    config = load_config()
    if not _is_gsheets_configured(config):
        from database_sqlite import init_db as sqlite_init_db
        if eng is None:
            eng = _get_sqlite_engine()
        sqlite_init_db(eng)
