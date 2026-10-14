"""Asks what a stretch of idle or away time was, once the person comes back.

The question is optional for the employee: dismissing it records nothing. The
stretch itself stays an ordinary idle or away segment; the answer is a separate
row that overlaps it. Asking is off until the company turns it on and the
employee has acknowledged the notice that says so.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

REASONS = ("meeting", "call", "break", "other")
NOTE_LIMIT = 200


@dataclass(frozen=True)
class OfflinePrompt:
    started_at: datetime
    ended_at: datetime

    @property
    def minutes(self) -> int:
        seconds = max(0, (self.ended_at - self.started_at).total_seconds())
        return max(1, int(round(seconds / 60)))


def clean_note(note: Optional[str]) -> Optional[str]:
    text = (note or "").strip()
    if len(text) > NOTE_LIMIT:
        text = text[:NOTE_LIMIT].rstrip()
    return text or None


def format_away(minutes: int) -> str:
    minutes = max(0, int(minutes))
    if minutes < 60:
        return f"{minutes} min"
    hours, mins = divmod(minutes, 60)
    if mins == 0:
        return f"{hours} h"
    return f"{hours} h {mins} min"


class ReturnTracker:
    """One continuous absence. Idle and away count; pause, off hours and an inactive subscription do not."""

    def __init__(self) -> None:
        self._left_at: Optional[datetime] = None

    def reset(self) -> None:
        self._left_at = None

    def note_absence(self, at: datetime) -> None:
        """A sleep or hibernation gap began at `at`. Kept only if it started earlier than we already know."""
        if self._left_at is None or at < self._left_at:
            self._left_at = at

    def observe(self, now: datetime, state: str, idle_seconds: float, threshold_seconds: int,
                enabled: bool, earliest: Optional[datetime] = None) -> Optional[OfflinePrompt]:
        """Call once per sample. Returns a prompt when the person becomes active again after long enough."""
        if not enabled:
            self._left_at = None
            return None
        if state in ("idle", "away"):
            if self._left_at is None:
                back = now - timedelta(seconds=max(0, int(idle_seconds)))
                if earliest is not None and back < earliest:
                    back = earliest
                if back > now:
                    back = now
                self._left_at = back
            return None
        left = self._left_at
        self._left_at = None
        if state != "active" or left is None or now <= left:
            return None
        if earliest is not None and left < earliest:
            left = earliest
        if (now - left).total_seconds() < max(1, threshold_seconds):
            return None
        return OfflinePrompt(left, now)
