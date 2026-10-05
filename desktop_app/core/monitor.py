"""Windows probes: foreground window, idle time, lock state, browser URL.

Nothing here hooks the keyboard or mouse. Idle time comes from the
system's last-input timestamp (GetLastInputInfo).
"""

import ctypes
import ctypes.wintypes as wt
import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional
from urllib.parse import urlsplit

import psutil

from config import BROWSER_PROCESSES
from utils.logger import get_logger

log = get_logger("monitor")

try:
    import win32api
    import win32gui
    import win32process
except ImportError:  # pragma: no cover - non-Windows dev machines
    win32api = win32gui = win32process = None

try:
    import uiautomation as uia
except Exception:  # pragma: no cover
    uia = None

user32 = ctypes.windll.user32 if os.name == "nt" else None
kernel32 = ctypes.windll.kernel32 if os.name == "nt" else None


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wt.UINT), ("dwTime", wt.DWORD)]


@dataclass
class Sample:
    idle_seconds: float = 0.0
    locked: bool = False
    app_name: Optional[str] = None
    process_name: Optional[str] = None
    window_title: Optional[str] = None
    url: Optional[str] = None
    domain: Optional[str] = None


def idle_seconds() -> float:
    info = LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if not user32.GetLastInputInfo(ctypes.byref(info)):
        return 0.0
    millis = (kernel32.GetTickCount() - info.dwTime) & 0xFFFFFFFF
    return millis / 1000.0


def _input_desktop_is_default() -> bool:
    """False while the lock screen (or another secure desktop) has input."""
    DESKTOP_READOBJECTS = 0x0001
    UOI_NAME = 2
    hdesk = user32.OpenInputDesktop(0, False, DESKTOP_READOBJECTS)
    if not hdesk:
        return False
    try:
        buf = ctypes.create_unicode_buffer(256)
        needed = wt.DWORD()
        if not user32.GetUserObjectInformationW(hdesk, UOI_NAME, buf, ctypes.sizeof(buf), ctypes.byref(needed)):
            return True
        return buf.value.lower() == "default"
    finally:
        user32.CloseDesktop(hdesk)


def screen_locked() -> bool:
    return not _input_desktop_is_default()


@lru_cache(maxsize=256)
def _friendly_app_name(exe_path: str, process_name: str) -> str:
    try:
        lang, codepage = win32api.GetFileVersionInfo(exe_path, "\\VarFileInfo\\Translation")[0]
        desc = win32api.GetFileVersionInfo(
            exe_path, f"\\StringFileInfo\\{lang:04x}{codepage:04x}\\FileDescription"
        )
        if desc and desc.strip():
            return desc.strip()[:200]
    except Exception:
        pass
    name = process_name.rsplit(".", 1)[0]
    return name[:1].upper() + name[1:]


def _resolve_uwp_child(hwnd: int, frame_pid: int) -> Optional[int]:
    """Store apps run inside ApplicationFrameHost; find the real process."""
    found: list[int] = []

    def cb(child, _):
        _, pid = win32process.GetWindowThreadProcessId(child)
        if pid != frame_pid:
            found.append(pid)
            return False
        return True

    try:
        win32gui.EnumChildWindows(hwnd, cb, None)
    except Exception:
        pass
    return found[0] if found else None


def normalise_url(raw: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Return (url, domain) for an address-bar value, or (None, None) if it isn't a URL."""
    if not raw:
        return None, None
    value = raw.strip()
    if not value or " " in value or len(value) > 2048:
        return None, None
    if "://" not in value:
        if "." not in value.split("/")[0]:
            return None, None
        value = "https://" + value
    try:
        parts = urlsplit(value)
    except ValueError:
        return None, None
    if parts.scheme not in ("http", "https"):
        return value, None
    host = (parts.hostname or "").lower()
    if not host:
        return None, None
    if host.startswith("www."):
        host = host[4:]
    return value, host


class BrowserUrlReader:
    """Reads the address bar through UI Automation, cached per window title."""

    def __init__(self) -> None:
        self._cache_key: Optional[tuple[int, str]] = None
        self._cache_value: Optional[str] = None
        self._failures = 0

    def read(self, hwnd: int, process_name: str, title: str) -> Optional[str]:
        if uia is None:
            return None
        key = (hwnd, title)
        if key == self._cache_key:
            return self._cache_value
        value = None
        try:
            window = uia.ControlFromHandle(hwnd)
            if process_name == "firefox.exe":
                edit = window.EditControl(searchDepth=12, AutomationId="urlbar-input")
            else:
                edit = window.EditControl(searchDepth=12)
            if edit.Exists(0, 0):
                value = edit.GetValuePattern().Value
            self._failures = 0
        except Exception as exc:
            self._failures += 1
            if self._failures in (1, 10, 100):
                log.debug("Address bar read failed for %s: %s", process_name, exc)
        self._cache_key, self._cache_value = key, value
        return value


class SystemMonitor:
    """Takes one Sample per call. Must be created on the thread that uses it."""

    LOCK_CONFIRM_SAMPLES = 3  # ignore brief secure-desktop flashes (UAC prompts)

    def __init__(self) -> None:
        self._url_reader = BrowserUrlReader()
        self._lock_streak = 0
        self._uia_init = uia.UIAutomationInitializerInThread() if uia is not None else None

    def sample(self, want_app: bool, want_title: bool, want_url: bool) -> Sample:
        s = Sample(idle_seconds=idle_seconds())

        if not _input_desktop_is_default():
            self._lock_streak += 1
        else:
            self._lock_streak = 0
        s.locked = self._lock_streak >= self.LOCK_CONFIRM_SAMPLES
        if s.locked or not (want_app or want_title or want_url):
            return s

        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return s
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            proc = psutil.Process(pid)
            pname = proc.name().lower()
            if pname == "applicationframehost.exe":
                child = _resolve_uwp_child(hwnd, pid)
                if child:
                    proc = psutil.Process(child)
                    pname = proc.name().lower()
            try:
                exe = proc.exe()
            except (psutil.AccessDenied, psutil.ZombieProcess):
                exe = ""
        except (psutil.NoSuchProcess, psutil.AccessDenied, ValueError):
            return s
        except Exception as exc:
            log.debug("Foreground probe failed: %s", exc)
            return s

        title = (win32gui.GetWindowText(hwnd) or "").strip()

        if want_app:
            s.process_name = pname
            s.app_name = BROWSER_PROCESSES.get(pname) or _friendly_app_name(exe, pname)
        if want_title:
            s.window_title = title[:500] or None
        if want_url and pname in BROWSER_PROCESSES:
            s.url, s.domain = normalise_url(self._url_reader.read(hwnd, pname, title))
        return s

    def close(self) -> None:
        if self._uia_init is not None:
            del self._uia_init
            self._uia_init = None
