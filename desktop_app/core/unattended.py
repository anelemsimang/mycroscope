"""Decides when to remind someone to sign in, and when to tell the managers, while nothing is tracked.

Pure logic on monotonic seconds so it can be tested without a PC or a clock.
"""

from dataclasses import dataclass
from typing import Optional

# Longer than this between observations (sleep, hibernate) breaks continuous use.
MAX_OBSERVATION_GAP_SECONDS = 60
# Only pop the window up when someone is actually at the keyboard.
PRESENT_IDLE_SECONDS = 60


@dataclass
class Decision:
    remind: bool = False
    report_minutes: Optional[int] = None


class UnattendedWatch:
    def __init__(self, remind_every: float, alert_after_minutes: int, report_every: float, idle_limit: float):
        self.remind_every = remind_every
        self.alert_after = alert_after_minutes * 60
        self.report_every = report_every
        self.idle_limit = idle_limit
        self.in_use_since: Optional[float] = None
        self.last_remind: Optional[float] = None
        self.last_report: Optional[float] = None
        self.last_seen: Optional[float] = None

    def reset(self, now: float) -> None:
        """Tracking is running (or just stopped and the window was just shown): start over."""
        self.in_use_since = None
        self.last_report = None
        self.last_seen = None
        self.last_remind = now

    def observe(self, now: float, idle: float, locked: bool) -> Decision:
        if self.last_seen is not None and now - self.last_seen > MAX_OBSERVATION_GAP_SECONDS:
            self.in_use_since = None
            self.last_report = None
        self.last_seen = now
        if locked or idle >= self.idle_limit:
            self.in_use_since = None
            self.last_report = None
            return Decision()
        if self.in_use_since is None:
            self.in_use_since = now - idle

        decision = Decision()
        if idle < PRESENT_IDLE_SECONDS and (self.last_remind is None or now - self.last_remind >= self.remind_every):
            self.last_remind = now
            decision.remind = True
        used = now - self.in_use_since
        if used >= self.alert_after and (self.last_report is None or now - self.last_report >= self.report_every):
            self.last_report = now
            decision.report_minutes = int(used // 60)
        return decision
