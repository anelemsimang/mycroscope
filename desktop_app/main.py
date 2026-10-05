"""Mycroscope desktop agent.

    python main.py            open the window
    python main.py --hidden   start in the tray (used when launched at sign-in)
"""

import sys
import threading

from utils.logger import get_logger, setup_logging

setup_logging()
log = get_logger("main")


def _single_instance() -> object | None:
    """Hold a per-user mutex; returns None if another agent already runs."""
    import win32api
    import win32event
    import winerror
    handle = win32event.CreateMutex(None, False, "Local\\MycroscopeAgentV2")
    if win32api.GetLastError() == winerror.ERROR_ALREADY_EXISTS:
        return None
    return handle


def _log_unhandled(exc_type, exc, tb) -> None:
    log.critical("Unhandled exception", exc_info=(exc_type, exc, tb))


def main() -> int:
    from config import APP_NAME, SUPABASE_KEY, SUPABASE_URL, VERSION

    sys.excepthook = _log_unhandled
    threading.excepthook = lambda args: _log_unhandled(args.exc_type, args.exc_value, args.exc_traceback)

    mutex = _single_instance()
    if mutex is None:
        log.info("Another instance is already running; exiting")
        return 0

    if not SUPABASE_URL or not SUPABASE_KEY:
        import tkinter.messagebox as mb
        mb.showerror(APP_NAME, "Mycroscope is not configured: SUPABASE_URL and SUPABASE_KEY are missing.\n"
                               "Put them in the .env file next to the program.")
        return 2

    log.info("Starting %s agent v%s", APP_NAME, VERSION)
    from ui.app_ui import AgentApp
    AgentApp(start_hidden="--hidden" in sys.argv).run()
    log.info("Agent exited")
    return 0


if __name__ == "__main__":
    sys.exit(main())
