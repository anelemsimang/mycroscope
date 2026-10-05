import os
import sys
from pathlib import Path

from dotenv import load_dotenv

APP_NAME = "Mycroscope"
VERSION = "2.0.0"

if getattr(sys, "frozen", False):
    BASE_DIR = Path(sys.executable).parent
else:
    BASE_DIR = Path(__file__).parent

DATA_DIR = Path(os.getenv("LOCALAPPDATA") or Path.home()) / APP_NAME
LOGS_DIR = DATA_DIR / "logs"
DATA_DIR.mkdir(parents=True, exist_ok=True)
LOGS_DIR.mkdir(parents=True, exist_ok=True)

# Packaged installs keep config in the data dir; dev runs use desktop_app/.env.
# The agent's own files win over machine-wide environment variables.
load_dotenv(BASE_DIR / ".env", override=True)
load_dotenv(DATA_DIR / "agent.env", override=True)

SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
SUPABASE_KEY = (os.getenv("SUPABASE_KEY") or "").strip()

LOCAL_DB_FILE = DATA_DIR / "agent.db"
CREDENTIALS_FILE = DATA_DIR / "session.bin"
LOG_FILE = LOGS_DIR / "agent.log"
LOG_LEVEL = os.getenv("MYCROSCOPE_LOG_LEVEL", "INFO").upper()

# Sampling and segmenting
SAMPLE_INTERVAL_SECONDS = 1.0
MAX_SEGMENT_SECONDS = 300          # long segments are split so a crash loses little
TITLE_DEBOUNCE_SECONDS = 10        # title-only changes merge into short segments
SLEEP_GAP_SECONDS = 30             # wall-clock gap between samples treated as sleep
PERSIST_OPEN_SEGMENT_SECONDS = 5

# Server communication
UPLOAD_INTERVAL_SECONDS = 15
STATUS_INTERVAL_SECONDS = 20
SETTINGS_REFRESH_SECONDS = 300
UPLOAD_BATCH_SIZE = 200
MAX_BACKOFF_SECONDS = 300
HTTP_TIMEOUT_SECONDS = 15
MAX_CLOCK_SKEW_SECONDS = 120
SYNCED_RETENTION_DAYS = 3          # how long uploaded rows stay in the local db

# Defaults until the organisation's settings are fetched
DEFAULT_SETTINGS = {
    "track_apps": True,
    "track_window_titles": True,
    "track_web_domains": True,
    "track_full_urls": True,
    "idle_threshold_seconds": 300,
    "allow_pause": True,
}

BROWSER_PROCESSES = {
    "chrome.exe": "Google Chrome",
    "msedge.exe": "Microsoft Edge",
    "firefox.exe": "Firefox",
    "brave.exe": "Brave",
    "opera.exe": "Opera",
    "vivaldi.exe": "Vivaldi",
}

THEME_COLORS = {
    "primary": "#1e3a8a",
    "background": "#ffffff",
    "alert": "#dc2626",
    "success": "#059669",
    "warning": "#d97706",
    "text": "#1f2937",
    "text_secondary": "#6b7280",
}
