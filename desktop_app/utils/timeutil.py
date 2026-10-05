import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Optional


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _truncate_ms(dt: datetime) -> datetime:
    return dt.replace(microsecond=(dt.microsecond // 1000) * 1000)


class AgentClock:
    """UTC time that never goes backwards.

    Anchored to the (server-corrected) wall clock, then advanced by the monotonic
    clock, which on Windows keeps counting through sleep. Changing the system
    clock therefore cannot produce overlapping segments.
    """

    def __init__(self, offset_seconds: float = 0.0):
        self._lock = threading.Lock()
        self._last: Optional[datetime] = None
        self.offset_seconds = 0.0
        self.reanchor(offset_seconds)

    def reanchor(self, offset_seconds: Optional[float] = None) -> None:
        with self._lock:
            if offset_seconds is not None:
                self.offset_seconds = offset_seconds
            self._anchor_wall = utcnow() + timedelta(seconds=self.offset_seconds)
            self._anchor_mono = time.monotonic()

    FORWARD_JUMP_SECONDS = 5

    def now(self) -> datetime:
        with self._lock:
            mono = time.monotonic()
            t = self._anchor_wall + timedelta(seconds=mono - self._anchor_mono)
            wall = utcnow() + timedelta(seconds=self.offset_seconds)
            if (wall - t).total_seconds() > self.FORWARD_JUMP_SECONDS:
                # The monotonic clock did not count some time (e.g. suspend); follow the wall clock forward.
                self._anchor_wall, self._anchor_mono, t = wall, mono, wall
            t = _truncate_ms(t)
            if self._last is not None and t < self._last:
                t = self._last
            self._last = t
            return t


def iso(dt: datetime) -> str:
    """UTC ISO-8601 with millisecond precision; sortable as text."""
    if dt.tzinfo is None:
        raise ValueError("naive datetime")
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    v = value.strip().replace("Z", "+00:00")
    # Postgres may return fractional seconds with 1-6 digits; normalise to 6.
    if "." in v:
        head, rest = v.split(".", 1)
        frac = ""
        i = 0
        while i < len(rest) and rest[i].isdigit():
            frac += rest[i]
            i += 1
        v = f"{head}.{(frac + '000000')[:6]}{rest[i:]}"
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)
