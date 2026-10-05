"""Turns per-second samples into contiguous activity segments.

Invariants (the server enforces the same ones):
  * segments of one device never overlap: each starts where the previous ended
  * a segment is at most MAX_SEGMENT_SECONDS long
  * time only moves forward (the clock is monotonic, see utils.timeutil.AgentClock)

Idle is decided retroactively: once the idle threshold is crossed, the time since
the last input is relabelled, including segments already closed.
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Callable, Optional

from config import MAX_SEGMENT_SECONDS, PERSIST_OPEN_SEGMENT_SECONDS, SLEEP_GAP_SECONDS, TITLE_DEBOUNCE_SECONDS
from core.monitor import Sample
from core.store import LocalStore
from utils.logger import get_logger

log = get_logger("engine")

CONTEXT_FIELDS = ("app_name", "process_name", "window_title", "url", "domain")


@dataclass
class Identity:
    organization_id: str
    employee_id: str
    device_id: str
    session_id: str


@dataclass
class TrackingSettings:
    track_apps: bool = True
    track_window_titles: bool = True
    track_web_domains: bool = True
    track_full_urls: bool = True
    idle_threshold_seconds: int = 300
    allow_pause: bool = True

    @classmethod
    def from_dict(cls, d: Optional[dict[str, Any]]) -> "TrackingSettings":
        d = d or {}
        known = {k: d[k] for k in cls.__dataclass_fields__ if k in d and d[k] is not None}
        return cls(**known)

    def narrowed_to(self, acknowledged: Optional["TrackingSettings"]) -> "TrackingSettings":
        """Records nothing the employee has not acknowledged; used while a new notice awaits acknowledgement.

        With no known acknowledged settings, nothing optional is recorded.
        """
        a = acknowledged or TrackingSettings(False, False, False, False, self.idle_threshold_seconds, True)
        return TrackingSettings(
            track_apps=self.track_apps and a.track_apps,
            track_window_titles=self.track_window_titles and a.track_window_titles,
            track_web_domains=self.track_web_domains and a.track_web_domains,
            track_full_urls=self.track_full_urls and a.track_full_urls,
            idle_threshold_seconds=self.idle_threshold_seconds,
            allow_pause=self.allow_pause or a.allow_pause,
        )


@dataclass
class LiveState:
    state: str = "active"
    context: dict[str, Optional[str]] = field(default_factory=dict)
    project_id: Optional[str] = None


EventSink = Callable[[str, datetime, dict[str, Any]], None]


class SegmentEngine:
    def __init__(self, store: LocalStore, identity: Identity, settings: TrackingSettings, emit_event: EventSink):
        self.store = store
        self.identity = identity
        self.settings = settings
        self.emit_event = emit_event
        self.session_started_at: Optional[datetime] = None
        self.open: Optional[dict[str, Any]] = None
        self.last_tick: Optional[datetime] = None
        self._last_persist: Optional[datetime] = None
        self._locked = False
        self.live = LiveState()

    # ---- public ----------------------------------------------------------
    def start(self, now: datetime) -> None:
        self.session_started_at = now
        self.last_tick = now

    def tick(self, now: datetime, sample: Sample, paused: bool, project_id: Optional[str]) -> None:
        if self.last_tick is not None and now <= self.last_tick:
            return
        if self.last_tick is not None and (now - self.last_tick).total_seconds() > SLEEP_GAP_SECONDS:
            self._handle_gap(self.last_tick, now)

        if sample.locked != self._locked:
            self.emit_event("lock" if sample.locked else "unlock", now, {})
            self._locked = sample.locked

        state = self._classify(sample, paused)
        context = self._context(sample) if state == "active" else {f: None for f in CONTEXT_FIELDS}
        self.live = LiveState(state=state, context=context, project_id=project_id)

        if self.open is None:
            self._open_new(self.last_tick or now, state, context, project_id)
            self.open["ended_at"] = now
        elif state != self.open["state"]:
            self._change_state(now, state, context, project_id, sample)
        elif self._context_differs(context, project_id):
            if self._title_only_change(context, project_id) and \
                    (now - self.open["started_at"]).total_seconds() < TITLE_DEBOUNCE_SECONDS:
                self.open["window_title"] = context["window_title"]
                self.open["ended_at"] = now
            else:
                self._close_open(now)
                self._open_new(now, state, context, project_id)
        else:
            self.open["ended_at"] = now

        if self.open and (self.open["ended_at"] - self.open["started_at"]).total_seconds() >= MAX_SEGMENT_SECONDS:
            cut = self.open["started_at"] + timedelta(seconds=MAX_SEGMENT_SECONDS)
            carry = {f: self.open[f] for f in CONTEXT_FIELDS}
            st, proj = self.open["state"], self.open["project_id"]
            self._close_open(cut)
            self._open_new(cut, st, carry, proj)
            self.open["ended_at"] = now

        self.last_tick = now
        if self._last_persist is None or \
                (now - self._last_persist).total_seconds() >= PERSIST_OPEN_SEGMENT_SECONDS:
            self._persist_open(now)

    def stop(self, now: datetime) -> None:
        """Close the open segment (logout, pause of the agent, shutdown)."""
        if self.open is not None:
            end = max(min(now, self.last_tick or now), self.open["started_at"])
            self._close_open(end)
        self.last_tick = now

    def update_settings(self, settings: TrackingSettings) -> None:
        self.settings = settings

    # ---- internals -------------------------------------------------------
    def _classify(self, sample: Sample, paused: bool) -> str:
        if paused:
            return "paused"
        if sample.locked:
            return "away"
        if sample.idle_seconds >= self.settings.idle_threshold_seconds:
            return "idle"
        return "active"

    def _context(self, sample: Sample) -> dict[str, Optional[str]]:
        s = self.settings
        return {
            "app_name": sample.app_name if s.track_apps else None,
            "process_name": sample.process_name if s.track_apps else None,
            "window_title": sample.window_title if s.track_window_titles else None,
            "url": sample.url if (s.track_full_urls and s.track_web_domains) else None,
            "domain": sample.domain if s.track_web_domains else None,
        }

    def _context_differs(self, context: dict, project_id: Optional[str]) -> bool:
        return project_id != self.open["project_id"] or any(context[f] != self.open[f] for f in CONTEXT_FIELDS)

    def _title_only_change(self, context: dict, project_id: Optional[str]) -> bool:
        return project_id == self.open["project_id"] and all(
            context[f] == self.open[f] for f in CONTEXT_FIELDS if f != "window_title"
        )

    def _change_state(self, now: datetime, state: str, context: dict, project_id: Optional[str],
                      sample: Sample) -> None:
        prev = self.open["state"]
        if prev == "active" and state in ("idle", "away"):
            boundary = now - timedelta(seconds=sample.idle_seconds)
            floor = self.session_started_at or self.open["started_at"]
            boundary = max(boundary, floor)
            if boundary < self.open["started_at"]:
                self._relabel_closed(boundary, state)
                self.open.update({f: None for f in CONTEXT_FIELDS})
                self.open["state"] = state
                self.open["ended_at"] = now
                self._persist_open(now, force=True)
                return
            if boundary < now:
                self._close_open(boundary)
                self._open_new(boundary, state, context, project_id)
                self.open["ended_at"] = now
                return
        self._close_open(now)
        self._open_new(now, state, context, project_id)

    def _relabel_closed(self, since: datetime, state: str) -> None:
        open_id = self.open["id"] if self.open else None
        for seg in self.store.segments_ending_after(self.identity.session_id, since):
            if seg["id"] == open_id or seg["state"] != "active":
                continue
            if seg["started_at"] >= since:
                seg.update({f: None for f in CONTEXT_FIELDS})
                seg["state"] = state
                self.store.save_segment(seg)
            else:
                tail = dict(seg)
                tail.update({f: None for f in CONTEXT_FIELDS})
                tail.update(id=str(uuid.uuid4()), state=state, started_at=since)
                seg["ended_at"] = since
                self.store.save_segment(seg)
                self.store.save_segment(tail)

    def _handle_gap(self, last: datetime, now: datetime) -> None:
        gap = (now - last).total_seconds()
        log.info("Detected %.0fs gap in sampling (sleep/hibernate)", gap)
        if self.open is not None:
            self._close_open(last)
        self.emit_event("sleep", last, {"gap_seconds": int(gap)})
        cursor = last
        while cursor < now:
            end = min(cursor + timedelta(seconds=MAX_SEGMENT_SECONDS), now)
            self.store.save_segment(self._new_segment(cursor, end, "away", {}, None))
            cursor = end
        self.last_tick = now
        self.emit_event("wake", now, {"gap_seconds": int(gap)})

    def _new_segment(self, start: datetime, end: datetime, state: str, context: dict,
                     project_id: Optional[str]) -> dict[str, Any]:
        i = self.identity
        seg = {
            "id": str(uuid.uuid4()),
            "organization_id": i.organization_id,
            "employee_id": i.employee_id,
            "device_id": i.device_id,
            "session_id": i.session_id,
            "project_id": project_id,
            "state": state,
            "started_at": start,
            "ended_at": end,
        }
        for f in CONTEXT_FIELDS:
            seg[f] = context.get(f)
        return seg

    def _open_new(self, at: datetime, state: str, context: dict, project_id: Optional[str]) -> None:
        self.open = self._new_segment(at, at, state, context, project_id)

    def _close_open(self, at: datetime) -> None:
        seg, self.open = self.open, None
        if seg is None:
            return
        seg["ended_at"] = max(at, seg["started_at"])
        if seg["ended_at"] > seg["started_at"]:
            self.store.save_segment(seg)
        elif seg.get("_persisted"):
            # Already stored with a provisional end; keep the row consistent.
            self.store.save_segment(seg)

    def _persist_open(self, now: datetime, force: bool = False) -> None:
        self._last_persist = now
        if self.open is None:
            return
        if self.open["ended_at"] > self.open["started_at"] or force:
            self.store.save_segment(self.open)
            self.open["_persisted"] = True
