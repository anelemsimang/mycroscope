"""Minimal Supabase client (GoTrue auth + PostgREST) built on requests.

Only the anon (public) key is ever used; every data request carries the
signed-in user's access token, so row level security applies.
"""

import statistics
import threading
import time
from collections import deque
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Optional

import requests

from config import HTTP_TIMEOUT_SECONDS, VERSION
from utils.logger import get_logger

log = get_logger("api")


class NetworkError(Exception):
    """The server could not be reached (offline, DNS, timeout, 5xx)."""


class AuthError(Exception):
    """Credentials are wrong or the session can no longer be refreshed."""


class ApiError(Exception):
    def __init__(self, status: int, code: Optional[str], message: str, details: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details

    def __str__(self) -> str:
        return f"{self.status} {self.code or ''} {self.message}".strip()


class Session:
    def __init__(self, access_token: str, refresh_token: str, expires_at: float, user_id: str, email: str):
        self.access_token = access_token
        self.refresh_token = refresh_token
        self.expires_at = expires_at
        self.user_id = user_id
        self.email = email


def _friendly_auth_error(resp: requests.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return f"Sign-in failed ({resp.status_code})"
    msg = body.get("msg") or body.get("error_description") or body.get("message") or body.get("error") or ""
    code = body.get("error_code") or body.get("code")
    if code == "invalid_credentials" or "Invalid login credentials" in msg:
        return "Incorrect email/employee code or password."
    if code == "email_not_confirmed":
        return "This email address has not been confirmed yet. Check your inbox for the confirmation link."
    if "Database error" in msg:
        return "The activation details were not accepted. Check the employee code, activation code and email."
    return msg or f"Request failed ({resp.status_code})"


class SupabaseApi:
    def __init__(self, url: str, anon_key: str, on_session_changed: Optional[Callable[[Optional[Session]], None]] = None):
        if not url or not anon_key:
            raise ValueError("SUPABASE_URL and SUPABASE_KEY must be configured")
        self.url = url.rstrip("/")
        self.anon_key = anon_key
        self.session: Optional[Session] = None
        self._on_session_changed = on_session_changed
        self._http = requests.Session()
        self._http.headers.update({"apikey": anon_key, "X-Client-Info": f"mycroscope-agent/{VERSION}"})
        self._refresh_lock = threading.Lock()
        self._offsets: deque[float] = deque(maxlen=7)

    # ---- clock -----------------------------------------------------------
    @property
    def clock_offset_seconds(self) -> Optional[float]:
        """Server time minus local time (Date header resolution is 1s)."""
        if not self._offsets:
            return None
        return statistics.median(self._offsets)

    def _record_date(self, resp: requests.Response, sent: float, received: float) -> None:
        header = resp.headers.get("Date")
        if not header:
            return
        try:
            server = parsedate_to_datetime(header).timestamp() + 0.5
        except (TypeError, ValueError):
            return
        self._offsets.append(server - (sent + received) / 2)

    # ---- transport -------------------------------------------------------
    def _send(self, method: str, path: str, *, auth: bool, **kwargs) -> requests.Response:
        headers = kwargs.pop("headers", {}) or {}
        if auth:
            if self.session is None:
                raise AuthError("Not signed in")
            headers["Authorization"] = f"Bearer {self.session.access_token}"
        else:
            headers["Authorization"] = f"Bearer {self.anon_key}"
        sent = time.time()
        try:
            resp = self._http.request(method, self.url + path, headers=headers, timeout=HTTP_TIMEOUT_SECONDS, **kwargs)
        except requests.RequestException as exc:
            raise NetworkError(str(exc)) from exc
        self._record_date(resp, sent, time.time())
        if resp.status_code == 500 and path.startswith("/auth/") and \
                ("Database error" in resp.text or '"P0001"' in resp.text):
            # Our sign-up trigger rejected the details; GoTrue reports that as a 500.
            return resp
        if resp.status_code >= 500 or resp.status_code in (408, 429):
            raise NetworkError(f"Server returned {resp.status_code}")
        return resp

    def _raise_for(self, resp: requests.Response) -> None:
        if resp.status_code < 400:
            return
        try:
            body = resp.json()
        except ValueError:
            body = {}
        raise ApiError(resp.status_code, body.get("code"), body.get("message") or resp.text[:300], body.get("details"))

    def _rest(self, method: str, path: str, **kwargs) -> requests.Response:
        self.ensure_fresh_token()
        resp = self._send(method, "/rest/v1" + path, auth=True, **kwargs)
        if resp.status_code == 401:
            self.refresh(force=True)
            resp = self._send(method, "/rest/v1" + path, auth=True, **kwargs)
            if resp.status_code == 401:
                raise AuthError("Session rejected by server")
        self._raise_for(resp)
        return resp

    # ---- auth ------------------------------------------------------------
    def _set_session(self, body: dict[str, Any]) -> Session:
        user = body.get("user") or {}
        expires_at = body.get("expires_at") or (time.time() + float(body.get("expires_in") or 3600))
        self.session = Session(body["access_token"], body["refresh_token"], float(expires_at),
                               user.get("id", ""), user.get("email", ""))
        if self._on_session_changed:
            self._on_session_changed(self.session)
        return self.session

    def resolve_login_email(self, identifier: str) -> Optional[str]:
        resp = self._send("POST", "/rest/v1/rpc/resolve_login_email", auth=False,
                          json={"p_identifier": identifier})
        self._raise_for(resp)
        value = resp.json()
        return value if isinstance(value, str) and value else None

    def sign_in(self, email: str, password: str) -> Session:
        resp = self._send("POST", "/auth/v1/token", auth=False, params={"grant_type": "password"},
                          json={"email": email, "password": password})
        if resp.status_code >= 400:
            raise AuthError(_friendly_auth_error(resp))
        return self._set_session(resp.json())

    def activate(self, email: str, password: str, employee_code: str, activation_code: str) -> Session:
        resp = self._send("POST", "/auth/v1/signup", auth=False, json={
            "email": email,
            "password": password,
            "data": {"signup_type": "employee_activation", "employee_code": employee_code,
                     "activation_code": activation_code},
        })
        if resp.status_code >= 400:
            raise AuthError(_friendly_auth_error(resp))
        body = resp.json()
        if body.get("access_token"):
            return self._set_session(body)
        return self.sign_in(email, password)

    def restore(self, refresh_token: str) -> Session:
        resp = self._send("POST", "/auth/v1/token", auth=False, params={"grant_type": "refresh_token"},
                          json={"refresh_token": refresh_token})
        if resp.status_code >= 400:
            raise AuthError(_friendly_auth_error(resp))
        return self._set_session(resp.json())

    def refresh(self, force: bool = False) -> None:
        with self._refresh_lock:
            if self.session is None:
                raise AuthError("Not signed in")
            if not force and self.session.expires_at - time.time() > 120:
                return
            self.restore(self.session.refresh_token)

    def ensure_fresh_token(self) -> None:
        if self.session is not None and self.session.expires_at - time.time() <= 120:
            self.refresh()

    def sign_out(self) -> None:
        if self.session is None:
            return
        try:
            self._send("POST", "/auth/v1/logout", auth=True, params={"scope": "local"})
        except (NetworkError, AuthError) as exc:
            log.info("Server sign-out skipped: %s", exc)
        self.session = None
        if self._on_session_changed:
            self._on_session_changed(None)

    def request_password_reset(self, email: str) -> None:
        resp = self._send("POST", "/auth/v1/recover", auth=False, json={"email": email})
        if resp.status_code >= 400:
            raise AuthError(_friendly_auth_error(resp))

    # ---- data ------------------------------------------------------------
    def rpc(self, fn: str, args: Optional[dict[str, Any]] = None) -> Any:
        resp = self._rest("POST", f"/rpc/{fn}", json=args or {})
        return resp.json() if resp.content else None

    def select(self, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
        return self._rest("GET", f"/{table}", params=params).json()

    def insert(self, table: str, rows: list[dict[str, Any]] | dict[str, Any], returning: bool = False) -> Any:
        prefer = "return=representation" if returning else "return=minimal"
        resp = self._rest("POST", f"/{table}", json=rows, headers={"Prefer": prefer})
        return resp.json() if returning else None

    def upsert(self, table: str, rows: list[dict[str, Any]], on_conflict: str, ignore_duplicates: bool = False) -> None:
        resolution = "ignore-duplicates" if ignore_duplicates else "merge-duplicates"
        self._rest("POST", f"/{table}", params={"on_conflict": on_conflict}, json=rows,
                   headers={"Prefer": f"resolution={resolution},return=minimal"})


def to_server_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
