"""Working-hours schedule; mirrors public.is_work_time on the server."""

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from typing import Any, Optional
from zoneinfo import ZoneInfo


def _parse_time(value: Any, default: time) -> time:
    if isinstance(value, time):
        return value
    try:
        parts = [int(p) for p in str(value).split(":")[:2]]
        return time(parts[0], parts[1])
    except (ValueError, IndexError, TypeError):
        return default


@dataclass(frozen=True)
class Schedule:
    mode: str = "always"                      # always | work_hours
    work_days: tuple[int, ...] = (1, 2, 3, 4, 5)  # ISO weekdays, Monday = 1
    work_start: time = time(8, 0)
    work_end: time = time(17, 0)
    timezone: str = "Africa/Johannesburg"
    also: Optional["Schedule"] = None         # while a new notice is unacknowledged: both must allow

    @classmethod
    def from_settings(cls, d: Optional[dict[str, Any]], timezone: str) -> "Schedule":
        d = d or {}
        days = d.get("work_days")
        return cls(
            mode=d.get("tracking_schedule") or "always",
            work_days=tuple(int(x) for x in days) if isinstance(days, list) else (1, 2, 3, 4, 5),
            work_start=_parse_time(d.get("work_start"), time(8, 0)),
            work_end=_parse_time(d.get("work_end"), time(17, 0)),
            timezone=timezone or "Africa/Johannesburg",
        )

    def narrowed_to(self, acknowledged: Optional["Schedule"]) -> "Schedule":
        if acknowledged is None or acknowledged.mode == "always":
            return self
        if self.mode == "always":
            return acknowledged
        return Schedule(self.mode, self.work_days, self.work_start, self.work_end, self.timezone, also=acknowledged)

    def is_work_time(self, at: datetime) -> bool:
        if self.also is not None and not self.also.is_work_time(at):
            return False
        if self.mode != "work_hours":
            return True
        try:
            local = at.astimezone(ZoneInfo(self.timezone))
        except Exception:
            local = at.astimezone(ZoneInfo("Africa/Johannesburg"))
        t = local.time().replace(tzinfo=None)
        today = local.isoweekday() in self.work_days
        if self.work_start < self.work_end:
            return today and self.work_start <= t < self.work_end
        yesterday = (local - timedelta(days=1)).isoweekday() in self.work_days
        return (today and t >= self.work_start) or (yesterday and t < self.work_end)

    def overlaps(self, start: datetime, end: datetime, step_minutes: int = 15) -> bool:
        """Whether any part of [start, end] falls in working time (sampled every step_minutes)."""
        cursor = start
        while cursor < end:
            if self.is_work_time(cursor):
                return True
            cursor += timedelta(minutes=step_minutes)
        return self.is_work_time(end)
