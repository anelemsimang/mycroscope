"""Mycroscope desktop agent.

    main.py                        open the window
    main.py --hidden               start in the tray (logon task)
    main.py --watchdog             start only if the agent crashed (watchdog task)
    main.py --install-autostart    register the logon + watchdog tasks
    main.py --uninstall-autostart  remove them
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


def _selftest() -> int:
    """Log one probe sample and dependency checks (support diagnostics)."""
    from zoneinfo import ZoneInfo
    from config import SUPABASE_URL
    from core.monitor import SystemMonitor, uia
    try:
        ZoneInfo("Africa/Johannesburg")
        sample = SystemMonitor().sample(True, True, True)
        log.info("Selftest ok: configured=%s uia=%s idle=%.0fs locked=%s app=%s",
                 bool(SUPABASE_URL), uia is not None, sample.idle_seconds, sample.locked, sample.app_name)
        return 0
    except Exception:
        log.exception("Selftest failed")
        return 1


def main(argv: list[str]) -> int:
    from config import APP_NAME, MACHINE_INSTALL, SUPABASE_KEY, SUPABASE_URL, VERSION
    from utils import autostart

    if "--selftest" in argv:
        return _selftest()
    if "--install-autostart" in argv:
        if not MACHINE_INSTALL:
            autostart.install()
        return 0
    if "--uninstall-autostart" in argv:
        autostart.uninstall()
        return 0

    sys.excepthook = _log_unhandled
    threading.excepthook = lambda args: _log_unhandled(args.exc_type, args.exc_value, args.exc_traceback)

    watchdog = "--watchdog" in argv
    # On administrator-installed PCs the agent always runs; signing out of it is still possible and visible.
    if watchdog and autostart.STOP_MARKER.exists() and not MACHINE_INSTALL:
        return 0

    mutex = _single_instance()
    if mutex is None:
        if not watchdog:
            log.info("Another instance is already running; exiting")
        return 0

    if watchdog:
        log.warning("Watchdog restarted the agent after an unexpected exit")
    autostart.clear_stopped_marker()

    if not SUPABASE_URL or not SUPABASE_KEY:
        import tkinter.messagebox as mb
        where = "%ProgramData%\\Mycroscope\\agent.env" if MACHINE_INSTALL else "%LOCALAPPDATA%\\Mycroscope\\agent.env"
        mb.showerror(APP_NAME, "Mycroscope is not configured: SUPABASE_URL and SUPABASE_KEY are missing.\n"
                               f"Put them in {where}.")
        return 2

    if getattr(sys, "frozen", False) and not MACHINE_INSTALL:
        threading.Thread(target=autostart.ensure_installed, daemon=True).start()

    log.info("Starting %s agent v%s", APP_NAME, VERSION)
    from ui.app_ui import AgentApp
    AgentApp(start_hidden=watchdog or "--hidden" in argv).run()
    log.info("Agent exited")
    return 0


if __name__ == "__main__":
    code = main(sys.argv[1:])
    # A leftover library thread (e.g. the tray) must never keep a windowless agent alive.
    import logging
    import os
    logging.shutdown()
    os._exit(code)
