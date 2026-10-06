"""Integrity checks, disclosed in the monitoring notice when the organisation enables them.

None of these read content: they report that the agent was not running while the PC
was awake, that Windows runs in a virtual machine or a remote session, or that input
arrives in a machine-regular rhythm (for example a "mouse jiggler").
"""

import ctypes
import os
import statistics
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from utils.logger import get_logger

log = get_logger("integrity")

AGENT_GAP_MINUTES = 10
LATE_START_MINUTES = 15
SAME_BOOT_TOLERANCE_SECONDS = 120
VM_MARKERS = ("vmware", "virtualbox", "vbox", "qemu", "kvm", "xen", "parallels", "virtual machine",
              "bochs", "bhyve", "amazon ec2", "google compute engine")
SM_REMOTESESSION = 0x1000

kernel32 = ctypes.windll.kernel32 if os.name == "nt" else None
user32 = ctypes.windll.user32 if os.name == "nt" else None


# ---- clocks --------------------------------------------------------------
def awake_seconds() -> float:
    """Time the PC has been running since boot, excluding sleep and hibernation."""
    value = ctypes.c_ulonglong()
    if kernel32 is None or not kernel32.QueryUnbiasedInterruptTime(ctypes.byref(value)):
        return 0.0
    return value.value / 10_000_000


def uptime_seconds() -> float:
    """Time since boot, including sleep."""
    if kernel32 is None:
        return 0.0
    kernel32.GetTickCount64.restype = ctypes.c_ulonglong
    return kernel32.GetTickCount64() / 1000


def boot_time(now: datetime) -> datetime:
    return now - timedelta(seconds=uptime_seconds())


# ---- agent gaps ----------------------------------------------------------
def heartbeat(now: datetime, boot: datetime, awake: float, clean: bool = False) -> dict[str, Any]:
    return {"wall": now.isoformat(), "boot": boot.isoformat(), "awake": awake, "clean": clean}


def detect_gap(previous: Optional[dict[str, Any]], now: datetime, boot: datetime, awake: float
               ) -> Optional[dict[str, Any]]:
    """Details of an agent_gap when the agent stopped without signing out while the PC stayed on and awake.

    A restart of Windows or time asleep is not a gap.
    """
    if not previous or previous.get("clean"):
        return None
    try:
        prev_boot = datetime.fromisoformat(previous["boot"])
        prev_wall = datetime.fromisoformat(previous["wall"])
        awake_gap = awake - float(previous["awake"])
    except (KeyError, TypeError, ValueError):
        return None
    if abs((prev_boot - boot).total_seconds()) > SAME_BOOT_TOLERANCE_SECONDS:
        return None
    if awake_gap < AGENT_GAP_MINUTES * 60:
        return None
    return {
        "minutes": round(awake_gap / 60),
        "since": prev_wall.astimezone(timezone.utc).isoformat(),
        "until": now.astimezone(timezone.utc).isoformat(),
    }


def detect_late_start(previous: Optional[dict[str, Any]], now: datetime, boot: datetime, awake: float
                      ) -> Optional[dict[str, Any]]:
    """Details of a tracking_late event: the agent started well into a new boot.

    The agent has run on this PC before (there is a heartbeat), the PC has since rebooted, and the agent only
    started after the machine had already been awake for a while. That is the signature of removing the agent,
    restarting, using the PC, then reinstalling. A prompt start right after boot (the normal logon task) is fine.
    """
    if not previous:
        return None
    try:
        prev_boot = datetime.fromisoformat(previous["boot"])
    except (KeyError, TypeError, ValueError):
        return None
    if abs((prev_boot - boot).total_seconds()) <= SAME_BOOT_TOLERANCE_SECONDS:
        return None  # same boot: a mid-session gap is reported by detect_gap instead
    if awake < LATE_START_MINUTES * 60:
        return None
    return {
        "minutes": round(awake / 60),
        "since": (now - timedelta(seconds=awake)).astimezone(timezone.utc).isoformat(),
        "until": now.astimezone(timezone.utc).isoformat(),
    }


# ---- environment ---------------------------------------------------------
def _bios_strings() -> list[str]:
    try:
        import winreg
    except ImportError:
        return []
    values = []
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\BIOS") as key:
            for name in ("SystemManufacturer", "SystemProductName", "BIOSVendor", "BaseBoardManufacturer"):
                try:
                    values.append(str(winreg.QueryValueEx(key, name)[0]))
                except OSError:
                    pass
    except OSError:
        pass
    return values


def virtual_machine_vendor(bios: Optional[list[str]] = None) -> Optional[str]:
    """The hypervisor's name when Windows runs in a virtual machine."""
    for value in (bios if bios is not None else _bios_strings()):
        low = value.lower()
        if any(marker in low for marker in VM_MARKERS):
            return value[:100]
    return None


def is_remote_session() -> bool:
    return bool(user32 and user32.GetSystemMetrics(SM_REMOTESESSION))


# ---- input rhythm --------------------------------------------------------
class InputPatternDetector:
    """Flags input that resets the idle timer in a fixed rhythm while nothing else changes.

    People produce bursts of input at irregular intervals; jiggler tools and scripts produce
    a sawtooth: idle climbs to the same value, resets, climbs again.
    """

    WINDOW_SECONDS = 20 * 60
    MIN_RESETS = 5
    MIN_PEAK_SECONDS = 5.0
    MAX_VARIATION = 0.1          # standard deviation / mean of the peaks
    COOLDOWN_SECONDS = 60 * 60

    def __init__(self) -> None:
        self._prev_idle: Optional[float] = None
        self._resets: deque[tuple[datetime, float, Any]] = deque()
        self._busy: deque[datetime] = deque()
        self._started: Optional[datetime] = None
        self._last_alert: Optional[datetime] = None

    def reset(self) -> None:
        self.__init__()

    def observe(self, now: datetime, idle: float, context: Any) -> Optional[dict[str, Any]]:
        if self._started is None:
            self._started = now
        if self._prev_idle is not None and self._prev_idle >= self.MIN_PEAK_SECONDS and idle + 1 < self._prev_idle:
            self._resets.append((now, self._prev_idle, context))
        if idle < 1.5:
            self._busy.append(now)
        self._prev_idle = idle

        horizon = now - timedelta(seconds=self.WINDOW_SECONDS)
        while self._resets and self._resets[0][0] < horizon:
            self._resets.popleft()
        while self._busy and self._busy[0] < horizon:
            self._busy.popleft()

        if (now - self._started).total_seconds() < self.WINDOW_SECONDS:
            return None
        if self._last_alert and (now - self._last_alert).total_seconds() < self.COOLDOWN_SECONDS:
            return None
        if len(self._resets) < self.MIN_RESETS:
            return None
        if len({c for _, _, c in self._resets} | {context}) > 1:
            return None
        peaks = [p for _, p, _ in self._resets]
        mean = statistics.fmean(peaks)
        if statistics.pstdev(peaks) / mean > self.MAX_VARIATION:
            return None
        # Each reset is followed by a second or two of low idle; typing keeps it low far longer.
        if len(self._busy) > 3 * len(self._resets):
            return None
        self._last_alert = now
        return {"interval_seconds": round(mean), "resets": len(peaks), "minutes": self.WINDOW_SECONDS // 60}
