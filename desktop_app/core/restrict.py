"""Minimises a restricted program that comes to the front. No administrator rights.

A restricted website is named in the employee notice and raises an alert. It is not blocked:
per-user Chrome and Edge policy was not confirmed on a PC that is not on a company domain.
"""

import ctypes
import os
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable, Optional

try:
    import win32gui
    import win32process
except ImportError:  # pragma: no cover - non-Windows dev machines
    win32gui = win32process = None

try:
    import psutil
except ImportError:  # pragma: no cover
    psutil = None

user32 = ctypes.windll.user32 if os.name == "nt" else None
SW_MINIMIZE = 6
NOTICE_AGAIN = timedelta(minutes=10)
# Never minimise the desktop shell or Mycroscope itself.
LEAVE_RUNNING = {"explorer.exe", "mycroscope.exe", "searchhost.exe", "shellexperiencehost.exe", "textinputhost.exe"}


@dataclass(frozen=True)
class Restriction:
    kind: str
    pattern: str
    work_hours_only: bool = False


def parse_restrictions(value: Any) -> tuple[Restriction, ...]:
    if not isinstance(value, list):
        return ()
    found: list[Restriction] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        kind = item.get("kind")
        pattern = str(item.get("pattern") or "").strip().lower()
        if kind not in ("app", "domain") or not pattern:
            continue
        found.append(Restriction(kind, pattern, bool(item.get("work_hours_only"))))
    return tuple(found)


def narrow_restrictions(current: tuple[Restriction, ...], acknowledged: Optional[tuple[Restriction, ...]]) -> tuple[Restriction, ...]:
    """A restriction applies only after the employee has acknowledged a notice that names it.

    Removing one stops it at once. Limiting it to working hours can start at once; extending it
    to the whole day waits for the new notice.
    """
    if not acknowledged:
        return ()
    previous = {(rule.kind, rule.pattern): rule for rule in acknowledged}
    kept: list[Restriction] = []
    for rule in current:
        old = previous.get((rule.kind, rule.pattern))
        if old is None:
            continue
        kept.append(Restriction(rule.kind, rule.pattern, rule.work_hours_only or old.work_hours_only))
    return tuple(kept)


def _like(pattern: str, value: str) -> bool:
    """Same wildcard as the server: * matches anything, and _ is a literal character."""
    body = re.escape(pattern).replace(r"\*", ".*")
    return re.fullmatch(body, value) is not None


def matches_domain(pattern: str, domain: Optional[str]) -> bool:
    if not domain:
        return False
    host = domain.lower()
    if "*" in pattern:
        return _like(pattern, host)
    return host == pattern or host.endswith("." + pattern)


def matches_app(pattern: str, app_name: Optional[str], process_name: Optional[str]) -> bool:
    names: list[str] = []
    for raw in (app_name, process_name):
        if raw:
            names.append(raw.lower())
    if process_name and process_name.lower().endswith(".exe"):
        names.append(process_name.lower()[:-4])
    return any(_like(pattern, name) for name in names)


def applicable(rules: tuple[Restriction, ...], *, monitoring: bool, paused: bool, in_work_hours: bool) -> tuple[Restriction, ...]:
    if not monitoring or paused:
        return ()
    return tuple(rule for rule in rules if rule.kind == "app" and (not rule.work_hours_only or in_work_hours))


def app_to_minimise(rules: tuple[Restriction, ...], app_name: Optional[str], process_name: Optional[str]) -> Optional[Restriction]:
    for rule in rules:
        if matches_app(rule.pattern, app_name, process_name):
            return rule
    return None


def minimise_foreground() -> bool:
    """Minimises the window in front. Returns false when there is nothing safe to minimise."""
    if win32gui is None or win32process is None or psutil is None:
        return False
    hwnd = win32gui.GetForegroundWindow()
    if not hwnd:
        return False
    try:
        _thread, pid = win32process.GetWindowThreadProcessId(hwnd)
        name = psutil.Process(pid).name().lower()
    except (psutil.Error, OSError):
        return False
    if name in LEAVE_RUNNING:
        return False
    win32gui.ShowWindow(hwnd, SW_MINIMIZE)
    return True


def show_restriction_notice(pattern: str) -> None:
    if user32 is None:
        return
    text = (f"{pattern} is not allowed while Mycroscope is monitoring.\n\n"
            "It has been minimised, and your managers are told.")
    threading.Thread(
        target=lambda: user32.MessageBoxW(None, text, "Mycroscope", 0x00000040 | 0x00010000 | 0x00040000),
        daemon=True,
    ).start()


class Restrictor:
    def __init__(self) -> None:
        self._noticed: dict[str, datetime] = {}

    def enforce(
        self, rules: tuple[Restriction, ...], app_name: Optional[str], process_name: Optional[str], now: datetime, *,
        monitoring: bool, paused: bool, in_work_hours: bool,
        minimise: Callable[[], bool] = minimise_foreground,
        notify: Callable[[str], None] = show_restriction_notice,
    ) -> Optional[Restriction]:
        hit = app_to_minimise(applicable(rules, monitoring=monitoring, paused=paused, in_work_hours=in_work_hours),
                              app_name, process_name)
        if hit is None:
            return None
        minimise()
        last = self._noticed.get(hit.pattern)
        if last is None or now - last >= NOTICE_AGAIN:
            self._noticed[hit.pattern] = now
            notify(hit.pattern)
        return hit
