"""Agent controller: sign-in, consent, sessions, tracking thread and sync.

UI code talks only to this class. Callbacks fire on background threads; the
UI is responsible for marshalling them onto its own thread.
"""

import json
import platform
import secrets
import socket
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, time as dtime, timedelta
from typing import Any, Callable, Optional
from zoneinfo import ZoneInfo

from config import (CREDENTIALS_FILE, DEFAULT_SETTINGS, LOCAL_DB_FILE, MAX_CLOCK_SKEW_SECONDS,
                    SAMPLE_INTERVAL_SECONDS, SUPABASE_KEY, SUPABASE_URL, VERSION, WEB_APP_URL)
from core.api import ApiError, AuthError, NetworkError, Session, SupabaseApi, to_server_time
from core.credentials import CredentialStore
from core import integrity
from core.engine import Identity, SegmentEngine, TrackingSettings
from core.store import LocalStore
from core.sync import SyncService
from utils.logger import get_logger
from utils.timeutil import AgentClock

log = get_logger("agent")


@dataclass
class Profile:
    employee_id: str
    organization_id: str
    name: str
    employee_code: str
    role: str
    organization_name: str
    timezone: str


class Agent:
    def __init__(self, on_change: Callable[[str], None]):
        """on_change(kind) with kind in: state, policy, auth_lost, connectivity, projects."""
        self.on_change = on_change
        self.creds = CredentialStore(CREDENTIALS_FILE)
        self.store = LocalStore(LOCAL_DB_FILE)
        self.api = SupabaseApi(SUPABASE_URL, SUPABASE_KEY, on_session_changed=self._persist_session)
        self.clock = AgentClock()
        self.profile: Optional[Profile] = None
        self.identity: Optional[Identity] = None
        self.settings = TrackingSettings.from_dict(DEFAULT_SETTINGS)
        self.policy: Optional[dict[str, Any]] = None
        self.projects: list[dict[str, Any]] = []
        self.project_id: Optional[str] = None
        self.paused = False
        self.engine: Optional[SegmentEngine] = None
        self.sync: Optional[SyncService] = None
        self._engine_lock = threading.Lock()
        self._tracker: Optional[threading.Thread] = None
        self._stop_tracking = threading.Event()
        self.tracking = False
        self.auth_lost_message = ""
        self.service: Optional[dict[str, Any]] = None
        self.windows_session_ending = False

    # ---- authentication --------------------------------------------------
    def _persist_session(self, session: Optional[Session]) -> None:
        if session is not None:
            self.creds.save(session.refresh_token, session.email)

    def try_restore(self) -> bool:
        """Resume the saved session. Works offline if a previous run cached the profile."""
        saved = self.creds.load()
        if not saved:
            return False
        try:
            self.api.restore(saved["refresh_token"])
            self._load_profile()
            return True
        except AuthError as exc:
            log.info("Saved session expired: %s", exc)
            self.creds.clear()
            return False
        except NetworkError:
            cached = self._cached("profile")
            if not cached:
                raise
            log.info("Server unreachable; starting from cached profile")
            self.api.session = Session("", saved["refresh_token"], 0, "", saved.get("email", ""))
            self.profile = Profile(**cached)
            self.policy = self._cached("policy")
            self.service = self._cached("service")
            if self.policy:
                self.settings = self._effective_settings(self.policy)
            return True

    def _cached(self, key: str) -> Optional[dict]:
        raw = self.store.get(f"cache:{key}")
        return json.loads(raw) if raw else None

    def _cache(self, key: str, value: Optional[dict]) -> None:
        self.store.set(f"cache:{key}", json.dumps(value) if value is not None else None)

    def sign_in(self, identifier: str, password: str) -> None:
        identifier = identifier.strip()
        email = self.api.resolve_login_email(identifier)
        if not email:
            raise AuthError("Unknown employee code. Check it, or sign in with your email address.")
        self.api.sign_in(email, password)
        self._load_profile()

    def activate(self, employee_code: str, activation_code: str, email: str, password: str) -> None:
        self.api.activate(email.strip().lower(), password, employee_code.strip(), activation_code.strip().upper())
        self._load_profile()

    def request_password_reset(self, identifier: str) -> None:
        email = self.api.resolve_login_email(identifier.strip())
        if email:
            self.api.request_password_reset(email, f"{WEB_APP_URL}/auth/reset-password" if WEB_APP_URL else None)

    def _load_profile(self) -> None:
        uid = self.api.session.user_id
        rows = self.api.select("employees", {
            "auth_user_id": f"eq.{uid}",
            "select": "id,organization_id,name,employee_code,role,is_active",
        })
        if not rows:
            self._discard_session()
            raise AuthError("This account is not linked to an employee record.")
        emp = rows[0]
        if not emp["is_active"]:
            self._discard_session()
            raise AuthError("Your employee account has been deactivated. Contact your manager.")
        org = self.api.select("organizations", {"id": f"eq.{emp['organization_id']}", "select": "name,timezone"})
        org = org[0] if org else {"name": "", "timezone": "Africa/Johannesburg"}
        self.profile = Profile(emp["id"], emp["organization_id"], emp["name"], emp["employee_code"],
                               emp["role"], org["name"], org["timezone"])
        self._cache("profile", self.profile.__dict__)
        self._check_clock()

    def _discard_session(self) -> None:
        self.api.sign_out()
        self.creds.clear()
        if self.profile:
            self._cache(f"ack_settings:{self.profile.employee_id}", None)
        self._cache("profile", None)
        self._cache("policy", None)
        self._cache("service", None)
        self.service = None

    def _check_clock(self) -> None:
        offset = self.api.clock_offset_seconds or 0.0
        if abs(offset) > MAX_CLOCK_SKEW_SECONDS:
            log.warning("PC clock differs from server by %.0fs; using server time", offset)
        self.clock.reanchor(offset if abs(offset) > 2 else 0.0)

    # ---- consent ---------------------------------------------------------
    def fetch_policy(self) -> Optional[dict[str, Any]]:
        """Latest notice + acknowledgement; falls back to the cached copy when offline."""
        try:
            rows = self.api.rpc("get_my_policy_status")
        except NetworkError:
            if self.policy is not None:
                return self.policy
            raise
        self._apply_policy(rows[0] if rows else None)
        self.refresh_service()
        return self.policy

    # ---- subscription ----------------------------------------------------
    def refresh_service(self) -> None:
        try:
            rows = self.api.rpc("get_my_service_status")
        except NetworkError:
            return
        except ApiError as exc:
            log.info("Service status unavailable: %s", exc)
            return
        self._apply_service(rows[0] if rows else None)

    def _apply_service(self, status: Optional[dict[str, Any]]) -> None:
        was_active = self.service_active
        self.service = status
        self._cache("service", status)
        if was_active and not self.service_active and self.sync:
            self.sync.record_event("service_inactive", {"status": (status or {}).get("status")})
        if was_active != self.service_active:
            self.on_change("state")

    @property
    def service_active(self) -> bool:
        """Recording is allowed unless the server says the subscription is not in full service."""
        return (self.service or {}).get("level", "full") == "full"

    def _apply_policy(self, policy: Optional[dict[str, Any]]) -> None:
        previous = self.policy
        self.policy = policy
        self._cache("policy", policy)
        if policy:
            self.settings = self._effective_settings(policy)
            with self._engine_lock:
                if self.engine:
                    self.engine.update_settings(self.settings)
                if self.paused and not self.settings.allow_pause:
                    self.paused = False
        changed = (previous or {}).get("policy_id") != (policy or {}).get("policy_id") or \
            (previous or {}).get("acknowledged") != (policy or {}).get("acknowledged")
        if changed and previous is not None:
            self.on_change("policy")

    def _effective_settings(self, policy: dict[str, Any]) -> TrackingSettings:
        """The policy's settings, narrowed to what was last acknowledged until this version is acknowledged."""
        tz = self.profile.timezone if self.profile else "Africa/Johannesburg"
        published = TrackingSettings.from_dict({**DEFAULT_SETTINGS, **(policy.get("settings") or {})}, tz)
        if not self.profile:
            return published
        key = f"ack_settings:{self.profile.employee_id}"
        if policy.get("acknowledged"):
            self._cache(key, policy.get("settings") or {})
            return published
        acknowledged = self._cached(key)
        if acknowledged is None:
            acknowledged = self._fetch_acknowledged_settings()
            if acknowledged is not None:
                self._cache(key, acknowledged)
        if acknowledged is None:
            return published.narrowed_to(None)
        return published.narrowed_to(TrackingSettings.from_dict({**DEFAULT_SETTINGS, **acknowledged}, tz))

    def _fetch_acknowledged_settings(self) -> Optional[dict[str, Any]]:
        """Settings of the notice this employee most recently acknowledged (on any device)."""
        try:
            rows = self.api.select("consents", {
                "employee_id": f"eq.{self.profile.employee_id}",
                "select": "acknowledged_at,monitoring_policies(settings_snapshot)",
                "order": "acknowledged_at.desc",
                "limit": "1",
            })
        except (NetworkError, ApiError, AuthError) as exc:
            log.info("Could not load previously acknowledged settings: %s", exc)
            return None
        if not rows or not rows[0].get("monitoring_policies"):
            return None
        return rows[0]["monitoring_policies"].get("settings_snapshot") or {}

    @property
    def needs_acknowledgement(self) -> bool:
        return bool(self.policy) and not self.policy.get("acknowledged")

    def acknowledge_policy(self) -> None:
        if not self.policy:
            raise RuntimeError("No monitoring notice has been published for your organisation.")
        device_id = self._device_id()
        if not self.tracking:
            self._ensure_device_row(device_id)
        try:
            self.api.insert("consents", {
                "organization_id": self.profile.organization_id,
                "employee_id": self.profile.employee_id,
                "policy_id": self.policy["policy_id"],
                "device_id": device_id,
                "agent_version": VERSION,
            })
        except ApiError as exc:
            if exc.code != "23505":  # already acknowledged (e.g. on another device)
                raise
        self.fetch_policy()

    # ---- devices / sessions ----------------------------------------------
    def _device_id(self) -> str:
        key = f"device:{self.profile.employee_id}"
        device_id = self.store.get(key)
        if not device_id:
            device_id = str(uuid.uuid4())
            self.store.set(key, device_id)
        return device_id

    def _ensure_device_row(self, device_id: str) -> None:
        self.api.upsert("devices", [{
            "id": device_id,
            "organization_id": self.profile.organization_id,
            "employee_id": self.profile.employee_id,
            "hostname": socket.gethostname()[:200],
            "os_version": f"{platform.system()} {platform.release()}",
            "agent_version": VERSION,
            "last_seen_at": to_server_time(self.clock.now()),
        }], on_conflict="id")

    def _register_report_key(self, device_id: str) -> None:
        """Give this PC a fresh key for reporting use while nobody is signed in (see report_unattended_use)."""
        key = secrets.token_urlsafe(32)
        try:
            self.api.rpc("set_device_report_key", {"p_device": device_id, "p_key": key})
        except (NetworkError, ApiError, AuthError) as exc:
            log.info("Could not register the PC report key: %s", exc)
            return
        self.store.set("unattended:device", device_id)
        self.store.set("unattended:key", key)

    def report_unattended_use(self, minutes: int) -> None:
        device_id, key = self.store.get("unattended:device"), self.store.get("unattended:key")
        if not device_id or not key:
            return
        try:
            accepted = self.api.rpc_anon("report_unattended_use",
                                         {"p_device": device_id, "p_key": key, "p_minutes": minutes})
        except (NetworkError, ApiError) as exc:
            log.info("Could not report unattended use: %s", exc)
            return
        log.info("Reported %d minutes of use with nobody signed in (accepted=%s)", minutes, accepted)

    def report_uninstall(self) -> None:
        """Best-effort note to the server, with the PC's report key, that the agent is being removed."""
        device_id, key = self.store.get("unattended:device"), self.store.get("unattended:key")
        if not device_id or not key:
            return
        try:
            self.api.rpc_anon("report_uninstalled", {"p_device": device_id, "p_key": key})
            log.info("Reported agent uninstall")
        except (NetworkError, ApiError) as exc:
            log.info("Could not report uninstall: %s", exc)

    def _close_stale_sessions(self) -> None:
        for sess in self.store.open_sessions(self.profile.employee_id):
            end = self.store.last_segment_end(sess["id"]) or sess["started_at"]
            sess.update(ended_at=end, end_reason="crash")
            self.store.save_session(sess)
            log.info("Closed session %s left open by a previous run", sess["id"])

    # ---- tracking --------------------------------------------------------
    def start_tracking(self) -> None:
        if self.tracking:
            return
        p = self.profile
        self._close_stale_sessions()
        now = self.clock.now()
        session_id = str(uuid.uuid4())
        self.identity = Identity(p.organization_id, p.employee_id, self._device_id(), session_id)
        self.store.save_session({
            "id": session_id, "organization_id": p.organization_id, "employee_id": p.employee_id,
            "device_id": self.identity.device_id, "started_at": now, "ended_at": None, "end_reason": None,
        })
        self.sync = SyncService(
            self.api, self.store, self.identity, self.clock,
            status_provider=self.live_status,
            on_policy=self._apply_policy,
            on_auth_lost=self._auth_lost,
            on_connectivity=lambda online: self.on_change("connectivity"),
            on_service=self._apply_service,
            on_device_registered=self._register_report_key,
        )
        self.engine = SegmentEngine(self.store, self.identity, self.settings, self._engine_event)
        self.engine.start(now)
        self.sync.record_event("login", {"agent_version": VERSION}, at=now)
        offset = self.api.clock_offset_seconds
        if offset is not None and abs(offset) > MAX_CLOCK_SKEW_SECONDS:
            self.sync.record_event("clock_skew", {"offset_seconds": round(offset)}, at=now)
        self._integrity_on_start(now)
        self.paused = False
        self._stop_tracking.clear()
        self._tracker = threading.Thread(target=self._track_loop, name="tracker", daemon=True)
        self.tracking = True
        self._tracker.start()
        self.sync.start()
        self.refresh_projects()
        log.info("Tracking started (session %s)", session_id)
        self.on_change("state")

    def _engine_event(self, kind: str, at: datetime, details: dict[str, Any]) -> None:
        if self.sync:
            self.sync.record_event(kind, details, at=at)
        if kind == "wake" and self.sync:
            self.sync.poke()

    # ---- integrity -------------------------------------------------------
    def _heartbeat_key(self) -> str:
        return f"heartbeat:{self.profile.employee_id}"

    def _write_heartbeat(self, now: datetime, clean: bool = False) -> None:
        self.store.set(self._heartbeat_key(), json.dumps(
            integrity.heartbeat(now, integrity.boot_time(now), integrity.awake_seconds(), clean)))

    def _integrity_on_start(self, now: datetime) -> None:
        previous = self._cached_heartbeat()
        self._write_heartbeat(now)
        if not self.settings.detect_tampering:
            return
        boot, awake = integrity.boot_time(now), integrity.awake_seconds()
        gap = integrity.detect_gap(previous, now, boot, awake)
        if gap and self.settings.schedule.overlaps(datetime.fromisoformat(gap["since"]), now):
            self.sync.record_event("agent_gap", gap, at=now)
        late = integrity.detect_late_start(previous, now, boot, awake)
        if late and self.settings.schedule.overlaps(datetime.fromisoformat(late["since"]), now):
            self.sync.record_event("tracking_late", late, at=now)
        vendor = integrity.virtual_machine_vendor()
        if vendor:
            self.sync.record_event("vm_detected", {"vendor": vendor}, at=now)

    def _cached_heartbeat(self) -> Optional[dict[str, Any]]:
        raw = self.store.get(self._heartbeat_key())
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return None

    def recording_block(self, now: datetime) -> Optional[str]:
        """Why nothing is recorded right now: 'inactive' (subscription), 'off_hours', or None."""
        if not self.service_active:
            return "inactive"
        if not self.settings.schedule.is_work_time(now):
            return "off_hours"
        return None

    def _track_loop(self) -> None:
        from core.monitor import SystemMonitor
        monitor = SystemMonitor()
        rhythm = integrity.InputPatternDetector()
        last_state = None
        working: Optional[bool] = None
        last_after_hours: Optional[datetime] = None
        last_heartbeat = last_remote_check = None
        remote = False
        try:
            while not self._stop_tracking.is_set():
                s = self.settings
                now = self.clock.now()
                block = self.recording_block(now)
                if block:
                    sample = monitor.sample(False, False, False)
                    with self._engine_lock:
                        if self.engine is None:
                            break
                        self.engine.suspend(now, block)
                        state = block
                    rhythm.reset()
                    in_use = not sample.locked and sample.idle_seconds < s.idle_threshold_seconds
                    if block == "off_hours" and s.flag_after_hours_use and in_use and \
                            (last_after_hours is None or now - last_after_hours >= timedelta(hours=1)):
                        last_after_hours = now
                        self.sync.record_event("after_hours_use", {}, at=now)
                else:
                    want_url = s.track_web_domains
                    sample = monitor.sample(s.track_apps or want_url, s.track_window_titles, want_url)
                    with self._engine_lock:
                        if self.engine is None:
                            break
                        self.engine.tick(now, sample, self.paused, self.project_id)
                        state = self.engine.live.state
                    if s.detect_tampering and not (self.paused or sample.locked):
                        anomaly = rhythm.observe(now, sample.idle_seconds, (sample.process_name, sample.window_title))
                        if anomaly:
                            self.sync.record_event("input_anomaly", anomaly, at=now)
                    elif sample.locked:
                        rhythm.reset()

                if s.schedule.mode == "work_hours" and block != "inactive":
                    is_working = block is None
                    if working is not None and is_working != working:
                        self.sync.record_event("work_hours_start" if is_working else "work_hours_end", {}, at=now)
                    working = is_working

                if last_heartbeat is None or (now - last_heartbeat).total_seconds() >= 60:
                    last_heartbeat = now
                    self._write_heartbeat(now)
                if s.detect_tampering and (last_remote_check is None or (now - last_remote_check).total_seconds() >= 60):
                    last_remote_check = now
                    now_remote = integrity.is_remote_session()
                    if now_remote and not remote:
                        self.sync.record_event("remote_session", {}, at=now)
                    remote = now_remote

                if state != last_state:
                    last_state = state
                    self.on_change("state")
                    if self.sync:
                        self.sync.poke()
                self._stop_tracking.wait(SAMPLE_INTERVAL_SECONDS)
        except Exception:
            log.exception("Tracker thread crashed")
            self.on_change("state")
        finally:
            monitor.close()

    def _stop_tracker_thread(self) -> None:
        self._stop_tracking.set()
        if self._tracker and self._tracker is not threading.current_thread():
            self._tracker.join(5)
        self._tracker = None

    def stop_tracking(self, reason: str) -> None:
        """reason: logout | shutdown | auth_lost"""
        if not self.tracking:
            return
        self._stop_tracker_thread()
        now = self.clock.now()
        with self._engine_lock:
            if self.engine:
                self.engine.stop(now)
            self.engine = None
        # Signing out, being signed out, or Windows ending the session is not a gap; being killed is.
        self._write_heartbeat(now, clean=reason in ("logout", "auth_lost") or self.windows_session_ending)
        end_reason = "logout" if reason == "logout" else "shutdown"
        for sess in self.store.open_sessions(self.profile.employee_id):
            if sess["id"] == self.identity.session_id:
                sess.update(ended_at=now, end_reason=end_reason)
                self.store.save_session(sess)
        self.tracking = False
        if self.sync:
            if reason != "auth_lost":
                self.sync.record_event("logout" if reason == "logout" else "agent_stop", {}, at=now)
                self.sync.stop(final_flush=False)
                try:
                    self.sync.sync_once()
                    self.sync.push_status(state_override="logged_out")
                except (NetworkError, AuthError, ApiError) as exc:
                    log.info("Could not upload on stop; data stays queued: %s", exc)
            else:
                self.sync.stop(final_flush=False)
        self.sync = None
        log.info("Tracking stopped (%s)", reason)
        self.on_change("state")

    def sign_out(self) -> None:
        self.stop_tracking("logout")
        self._discard_session()
        self.profile = None
        self.policy = None

    def _auth_lost(self, message: str) -> None:
        threading.Thread(target=self._handle_auth_lost, args=(message,), daemon=True).start()

    def _handle_auth_lost(self, message: str) -> None:
        self.stop_tracking("auth_lost")
        self.creds.clear()
        self.api.session = None
        self.profile = None
        self.auth_lost_message = message
        self.on_change("auth_lost")

    # ---- user controls ---------------------------------------------------
    def set_paused(self, paused: bool) -> None:
        if paused and not self.settings.allow_pause:
            raise RuntimeError("Your organisation does not allow pausing tracking.")
        if paused == self.paused or not self.tracking:
            return
        self.paused = paused
        self.sync.record_event("pause" if paused else "resume", {})
        self.sync.poke()
        self.on_change("state")

    def refresh_projects(self) -> None:
        try:
            self.projects = self.api.select("projects", {"is_active": "eq.true", "select": "id,name", "order": "name"})
        except (NetworkError, ApiError) as exc:
            log.info("Could not load projects: %s", exc)
            return
        if self.project_id and self.project_id not in {p["id"] for p in self.projects}:
            self.project_id = None
        self.on_change("projects")

    def create_project(self, name: str) -> str:
        rows = self.api.insert("projects", {
            "organization_id": self.profile.organization_id, "name": name.strip(),
            "created_by": self.profile.employee_id,
        }, returning=True)
        self.refresh_projects()
        return rows[0]["id"]

    def set_project(self, project_id: Optional[str]) -> None:
        if project_id == self.project_id:
            return
        old = self.project_id
        self.project_id = project_id
        if self.sync:
            self.sync.record_event("project_switch", {"from": old, "to": project_id})
        self.on_change("state")

    # ---- read models for the UI ------------------------------------------
    def live_status(self) -> dict[str, Any]:
        with self._engine_lock:
            if self.engine is None:
                return {"state": "logged_out"}
            live = self.engine.live
            return {"state": live.state, "project_id": live.project_id, **live.context}

    def today_totals(self) -> dict[str, int]:
        if not self.profile:
            return {}
        tz = ZoneInfo(self.profile.timezone or "Africa/Johannesburg")
        now = self.clock.now()
        local_day = now.astimezone(tz).date()
        start = datetime.combine(local_day, dtime.min, tz)
        totals = self.store.local_totals(self.profile.employee_id, start, start + timedelta(days=1))
        with self._engine_lock:
            seg = self.engine.open if self.engine else None
            if seg and seg.get("_persisted") is None and seg["ended_at"] > seg["started_at"]:
                s, e = max(seg["started_at"], start), seg["ended_at"]
                if e > s:
                    totals[seg["state"]] += int((e - s).total_seconds())
        return totals

    def pending_uploads(self) -> int:
        return self.store.count_pending(self.profile.employee_id) if self.profile else 0

    @property
    def online(self) -> Optional[bool]:
        return self.sync.online if self.sync else None

    def shutdown(self) -> None:
        self.stop_tracking("shutdown")
        self.store.close()
