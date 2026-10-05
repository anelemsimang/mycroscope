import os
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Base paths
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
LOGS_DIR = BASE_DIR / "logs"
CACHE_DIR = BASE_DIR / "cache"

# Create directories if they don't exist
DATA_DIR.mkdir(exist_ok=True)
LOGS_DIR.mkdir(exist_ok=True)
CACHE_DIR.mkdir(exist_ok=True)

# Supabase configuration (set in .env — see .env.example)
SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").strip()
SUPABASE_KEY = (os.getenv("SUPABASE_KEY") or "").strip()

# Application settings
APP_NAME = "Mycroscope"
VERSION = "1.0.0"
COMPANY_NAME = "Mycroscope Corp"

# Tracking settings
IDLE_THRESHOLD = 300  # 5 minutes in seconds
ACTIVITY_CHECK_INTERVAL = 1  # 1 second
SYNC_INTERVAL = 30  # 30 seconds
OFFLINE_SYNC_INTERVAL = 300  # 5 minutes when offline

# Security settings
ENCRYPTION_KEY = os.getenv("ENCRYPTION_KEY", "mycroscope-secret-key-2024-32chars")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")

# UI settings
WINDOW_WIDTH = 400
WINDOW_HEIGHT = 600
THEME_COLORS = {
    "primary": "#1e3a8a",  # Navy
    "background": "#ffffff",  # White
    "alert": "#dc2626",  # Red
    "success": "#059669",  # Green
    "warning": "#d97706",  # Orange
    "text": "#1f2937",  # Dark gray
    "text_secondary": "#6b7280",  # Light gray
}

# Logging settings
LOG_LEVEL = "INFO"
LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
LOG_FILE = LOGS_DIR / "mycroscope.log"

# Database settings
LOCAL_DB_FILE = DATA_DIR / "local_data.db"
OFFLINE_QUEUE_FILE = DATA_DIR / "offline_queue.json"

# Auto-launch settings
STARTUP_REGISTRY_KEY = "Mycroscope"
STARTUP_REGISTRY_VALUE = str(BASE_DIR / "main.py")

# Activity tracking settings
TRACK_MOUSE_MOVEMENTS = True
TRACK_KEYBOARD_ACTIVITY = True
TRACK_APPLICATIONS = True
TRACK_WEB_ACTIVITY = True
TRACK_SCROLLING = True
TRACK_PROJECT_SWITCHING = True

# Privacy settings
BLACKLISTED_APPS = [
    "taskmgr.exe",
    "regedit.exe",
    "cmd.exe",
    "powershell.exe"
]

BLACKLISTED_URLS = [
    "chrome://",
    "about:",
    "file://",
    "data:"
]

# Report settings
REPORT_RETENTION_DAYS = 90
MAX_LOG_SIZE_MB = 100 