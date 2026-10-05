"""Background uploader: local store -> Supabase.

Order matters because of foreign keys: device, then sessions, then segments
and events. Everything is idempotent, so a retry after a timeout (where the
server may already have the data) never double counts.
"""

import platform
import socket
import threading
import time
import uuid
from datetime import timedelta
from typing import Any, Callable, Optional

from config import (MAX_BACKOFF_SECONDS, SETTINGS_REFRESH_SECONDS, STATUS_INTERVAL_SECONDS,
                    SYNCED_RETENTION_DAYS, UPLOAD_BATCH_SIZE, UPLOAD_INTERVAL_SECONDS, VERSION)
from core.api import ApiError, AuthError, NetworkError, SupabaseApi, to_server_time
from core.engine import Identity
from core.store import LocalStore
from utils.logger import get_logger
from utils.timeutil import AgentClock

log = get_logger("sync")

# Errors that a retry cannot fix.
PERMANENT_CODES = {"23P01", "23514", "42501", "22007", "22P02", "23502"}


class SyncService:
    def __init__(self, api: SupabaseApi, store: LocalStore, identity: Identity, clock: AgentClock,
                 status_provider: Callable[[], dict[str, Any]],
                 on_policy: Callable[[dict[str, Any]], None],
                 on_auth_lost: Callable[[str], None],
                 on_connectivity: Callable[[bool], None],
                 on_service: Optional[Callable[[Optional[dict[str, Any]]], None]] = None):
        self.api = api
        self.on_service = on_service
        self.store = store
        self.identity = identity
        self.clock = clock
        self.status_provider = status_provider
        self.on_policy = on_policy
        self.on_auth_lost = on_auth_lost
        self.on_connectivity = on_connectivity
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._device_registered = False
        self._last_status = 0.0
        self._last_policy = 0.0
        self._last_prune = 0.0
        self._backoff = 0.0
        self.online: Optional[bool] = None
        self.last_success: Optional[float] = None

    # ---- lifecycle -------------------------------------------------------
    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="sync", daemon=True)
        self._thread.start()

    def poke(self) -> None:
        self._wake.set()

    def stop(self, final_flush: bool = True, timeout: float = 10.0) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout)
        if final_flush:
            try:
                self.sync_once(force_status=True)
            except Exception as exc:
                log.info("Final flush incomplete, data stays queued: %s", exc)

    # ---- loop ------------------------------------------------------------
    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.sync_once()
                self._set_online(True)
                self._backoff = 0.0
                wait = UPLOAD_INTERVAL_SECONDS
            except NetworkError as exc:
                self._set_online(False)
                self._backoff = min(max(self._backoff * 2, 5.0), MAX_BACKOFF_SECONDS)
                wait = self._backoff
                log.info("Offline (%s); retrying in %.0fs", exc, wait)
            except AuthError as exc:
                log.warning("Authentication lost: %s", exc)
                self.on_auth_lost(str(exc))
                return
            except Exception:
                log.exception("Unexpected sync error")
                wait = 60
            self._wake.wait(wait)
            self._wake.clear()

    def _set_online(self, online: bool) -> None:
        if online:
            self.last_success = time.time()
        if online != self.online:
            self.online = online
            self.on_connectivity(online)

    def sync_once(self, force_status: bool = False) -> None:
        now = time.time()
        self._ensure_device()
        self._push_sessions()
        self._push_segments()
        self._push_events()
        if force_status or now - self._last_status >= STATUS_INTERVAL_SECONDS:
            self.push_status()
            self._last_status = now
        if now - self._last_policy >= SETTINGS_REFRESH_SECONDS:
            self.refresh_policy()
        if now - self._last_prune >= 3600:
            self.store.prune(self.clock.now() - timedelta(days=SYNCED_RETENTION_DAYS))
            self._last_prune = now

    def refresh_policy(self) -> None:
        rows = self.api.rpc("get_my_policy_status")
        self._last_policy = time.time()
        if rows:
            self.on_policy(rows[0])
        if self.on_service:
            try:
                status = self.api.rpc("get_my_service_status")
            except ApiError as exc:
                log.info("Service status unavailable: %s", exc)
                return
            self.on_service(status[0] if status else None)

    # ---- steps -----------------------------------------------------------
    def _ensure_device(self) -> None:
        if self._device_registered:
            return
        i = self.identity
        self.api.upsert("devices", [{
            "id": i.device_id,
            "organization_id": i.organization_id,
            "employee_id": i.employee_id,
            "hostname": socket.gethostname()[:200],
            "os_version": f"{platform.system()} {platform.release()} ({platform.version()})"[:200],
            "agent_version": VERSION,
            "last_seen_at": to_server_time(self.clock.now()),
        }], on_conflict="id")
        self._device_registered = True

    def _push_sessions(self) -> None:
        for sess in self.store.pending_sessions(self.identity.employee_id):
            row = {
                "id": sess["id"],
                "organization_id": sess["organization_id"],
                "employee_id": sess["employee_id"],
                "device_id": sess["device_id"],
                "started_at": to_server_time(sess["started_at"]),
                "ended_at": to_server_time(sess["ended_at"]) if sess["ended_at"] else None,
                "end_reason": sess["end_reason"],
            }
            try:
                self.api.upsert("agent_sessions", [row], on_conflict="id")
            except ApiError as exc:
                if exc.code in PERMANENT_CODES or exc.code == "23503":
                    log.warning("Session %s rejected by server: %s", sess["id"], exc)
                else:
                    raise
            self.store.mark_session_uploaded(sess["id"], sess["version"])

    @staticmethod
    def _segment_row(seg: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": seg["id"],
            "organization_id": seg["organization_id"],
            "employee_id": seg["employee_id"],
            "device_id": seg["device_id"],
            "session_id": seg["session_id"],
            "project_id": seg["project_id"],
            "state": seg["state"],
            "started_at": to_server_time(seg["started_at"]),
            "ended_at": to_server_time(seg["ended_at"]),
            "app_name": seg["app_name"],
            "process_name": seg["process_name"],
            "window_title": seg["window_title"],
            "url": seg["url"],
            "domain": seg["domain"],
        }

    def _push_segments(self) -> None:
        for _ in range(50):
            batch = self.store.pending_segments(self.identity.employee_id, UPLOAD_BATCH_SIZE)
            if not batch:
                return
            try:
                self.api.upsert("activity_segments", [self._segment_row(s) for s in batch], on_conflict="id")
                self.store.mark_segments_uploaded((s["id"], s["version"]) for s in batch)
            except ApiError as exc:
                log.info("Batch of %d rejected (%s); retrying row by row", len(batch), exc)
                self._push_segments_individually(batch)
            if len(batch) < UPLOAD_BATCH_SIZE:
                return

    def _push_segments_individually(self, batch: list[dict[str, Any]]) -> None:
        rejected = []
        for seg in batch:
            try:
                self.api.upsert("activity_segments", [self._segment_row(seg)], on_conflict="id")
                self.store.mark_segments_uploaded([(seg["id"], seg["version"])])
            except ApiError as exc:
                if exc.code == "23503" and seg.get("project_id"):
                    # The project was deleted on the server; keep the time, drop the link.
                    seg["project_id"] = None
                    self.store.save_segment(seg)
                elif exc.code == "42501" and seg["uploaded_version"] > 0:
                    # Too old to edit on the server; the earlier upload stands.
                    self.store.mark_segments_uploaded([(seg["id"], seg["version"])])
                elif exc.code in PERMANENT_CODES or exc.code == "23503":
                    self.store.mark_segment_rejected(seg["id"], seg["version"], str(exc))
                    rejected.append({"id": seg["id"], "code": exc.code, "started_at": to_server_time(seg["started_at"])})
                    log.warning("Segment %s rejected: %s", seg["id"], exc)
                else:
                    raise
        if rejected:
            self.record_event("data_rejected", {"count": len(rejected), "samples": rejected[:5]})

    def _push_events(self) -> None:
        events = self.store.pending_events(self.identity.employee_id, 500)
        if not events:
            return
        rows = [{
            "id": e["id"], "organization_id": e["organization_id"], "employee_id": e["employee_id"],
            "device_id": e["device_id"], "occurred_at": to_server_time(e["occurred_at"]),
            "event_type": e["event_type"], "details": e["details"],
        } for e in events]
        try:
            self.api.upsert("agent_events", rows, on_conflict="id", ignore_duplicates=True)
            self.store.mark_events_uploaded(e["id"] for e in events)
        except ApiError as exc:
            log.info("Event batch rejected (%s); retrying one by one", exc)
            for row in rows:
                try:
                    self.api.upsert("agent_events", [row], on_conflict="id", ignore_duplicates=True)
                except ApiError as row_exc:
                    log.warning("Event %s dropped: %s", row["id"], row_exc)
                self.store.mark_events_uploaded([row["id"]])

    def push_status(self, state_override: Optional[str] = None) -> None:
        i = self.identity
        live = self.status_provider()
        row = {
            "employee_id": i.employee_id,
            "organization_id": i.organization_id,
            "device_id": i.device_id,
            "state": state_override or live.get("state", "active"),
            "app_name": live.get("app_name"),
            "window_title": live.get("window_title"),
            "url": live.get("url"),
            "domain": live.get("domain"),
            "project_id": live.get("project_id"),
            "agent_version": VERSION,
            "last_seen_at": to_server_time(self.clock.now()),
        }
        if row["state"] != "active":
            row.update(app_name=None, window_title=None, url=None, domain=None)
        try:
            self.api.upsert("agent_status", [row], on_conflict="employee_id")
        except ApiError as exc:
            if exc.code == "23503" and row["project_id"]:
                row["project_id"] = None
                self.api.upsert("agent_status", [row], on_conflict="employee_id")
            else:
                raise

    # ---- events ----------------------------------------------------------
    def record_event(self, event_type: str, details: Optional[dict[str, Any]] = None, at=None) -> None:
        i = self.identity
        self.store.add_event({
            "id": str(uuid.uuid4()), "organization_id": i.organization_id, "employee_id": i.employee_id,
            "device_id": i.device_id, "occurred_at": at or self.clock.now(), "event_type": event_type,
            "details": details or {},
        })
