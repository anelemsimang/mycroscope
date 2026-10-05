"""Local SQLite store: the offline buffer between the tracker and the server.

Every row carries a client-generated UUID, so uploads are idempotent. `version`
is bumped on each local change and `uploaded_version` records what the server
has acknowledged, so a row edited after upload is sent again.
"""

import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Optional

from utils.timeutil import iso, parse_iso

SEGMENT_FIELDS = (
    "id", "organization_id", "employee_id", "device_id", "session_id", "project_id",
    "state", "started_at", "ended_at", "app_name", "process_name", "window_title", "url", "domain",
)
SESSION_FIELDS = ("id", "organization_id", "employee_id", "device_id", "started_at", "ended_at", "end_reason")

_SCHEMA = """
create table if not exists segments (
  id text primary key,
  organization_id text not null,
  employee_id text not null,
  device_id text not null,
  session_id text,
  project_id text,
  state text not null,
  started_at text not null,
  ended_at text not null,
  app_name text, process_name text, window_title text, url text, domain text,
  version integer not null default 1,
  uploaded_version integer not null default 0,
  rejected integer not null default 0,
  error text
);
create index if not exists segments_pending on segments (employee_id, started_at)
  where rejected = 0 and version > uploaded_version;

create table if not exists sessions (
  id text primary key,
  organization_id text not null,
  employee_id text not null,
  device_id text not null,
  started_at text not null,
  ended_at text,
  end_reason text,
  version integer not null default 1,
  uploaded_version integer not null default 0
);

create table if not exists events (
  id text primary key,
  organization_id text not null,
  employee_id text not null,
  device_id text,
  occurred_at text not null,
  event_type text not null,
  details text not null default '{}',
  uploaded integer not null default 0
);

create table if not exists kv (
  key text primary key,
  value text
);
"""


class LocalStore:
    def __init__(self, path: Path | str):
        self._lock = threading.RLock()
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute("pragma journal_mode=wal")
            self._db.execute("pragma synchronous=normal")
            self._db.executescript(_SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ---- key/value -------------------------------------------------------
    def get(self, key: str) -> Optional[str]:
        with self._lock:
            row = self._db.execute("select value from kv where key = ?", (key,)).fetchone()
            return row["value"] if row else None

    def set(self, key: str, value: Optional[str]) -> None:
        with self._lock:
            if value is None:
                self._db.execute("delete from kv where key = ?", (key,))
            else:
                self._db.execute(
                    "insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
                    (key, value),
                )

    # ---- segments --------------------------------------------------------
    def save_segment(self, seg: dict[str, Any]) -> None:
        row = {f: seg.get(f) for f in SEGMENT_FIELDS}
        row["started_at"] = iso(row["started_at"])
        row["ended_at"] = iso(row["ended_at"])
        cols = ", ".join(SEGMENT_FIELDS)
        params = ", ".join(f":{f}" for f in SEGMENT_FIELDS)
        updates = ", ".join(f"{f} = excluded.{f}" for f in SEGMENT_FIELDS if f != "id")
        with self._lock:
            self._db.execute(
                f"insert into segments ({cols}) values ({params}) "
                f"on conflict(id) do update set {updates}, version = segments.version + 1, "
                f"rejected = 0, error = null",
                row,
            )

    def segments_ending_after(self, session_id: str, at: datetime) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "select * from segments where session_id = ? and ended_at > ? order by started_at",
                (session_id, iso(at)),
            ).fetchall()
        return [self._segment_from_row(r) for r in rows]

    def pending_segments(self, employee_id: str, limit: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "select * from segments where employee_id = ? and rejected = 0 and version > uploaded_version "
                "order by started_at limit ?",
                (employee_id, limit),
            ).fetchall()
        return [self._segment_from_row(r) for r in rows]

    def mark_segments_uploaded(self, acked: Iterable[tuple[str, int]]) -> None:
        with self._lock:
            self._db.executemany(
                "update segments set uploaded_version = max(uploaded_version, ?) where id = ?",
                [(version, sid) for sid, version in acked],
            )

    def mark_segment_rejected(self, segment_id: str, version: int, error: str) -> None:
        with self._lock:
            self._db.execute(
                "update segments set rejected = 1, error = ? where id = ? and version = ?",
                (error[:500], segment_id, version),
            )

    def count_pending(self, employee_id: str) -> int:
        with self._lock:
            row = self._db.execute(
                "select count(*) from segments where employee_id = ? and rejected = 0 and version > uploaded_version",
                (employee_id,),
            ).fetchone()
        return int(row[0])

    def local_totals(self, employee_id: str, start: datetime, end: datetime) -> dict[str, int]:
        """Seconds per state between start and end, clipped, from local data."""
        totals = {"active": 0, "idle": 0, "away": 0, "paused": 0}
        with self._lock:
            rows = self._db.execute(
                "select state, started_at, ended_at from segments "
                "where employee_id = ? and ended_at > ? and started_at < ?",
                (employee_id, iso(start), iso(end)),
            ).fetchall()
        for r in rows:
            s = max(parse_iso(r["started_at"]), start)
            e = min(parse_iso(r["ended_at"]), end)
            if e > s and r["state"] in totals:
                totals[r["state"]] += int((e - s).total_seconds())
        return totals

    def prune(self, before: datetime) -> int:
        with self._lock:
            cur = self._db.execute(
                "delete from segments where ended_at < ? and (version <= uploaded_version or rejected = 1)",
                (iso(before),),
            )
            self._db.execute("delete from events where uploaded = 1 and occurred_at < ?", (iso(before),))
            self._db.execute(
                "delete from sessions where ended_at is not null and ended_at < ? and version <= uploaded_version",
                (iso(before),),
            )
            return cur.rowcount

    @staticmethod
    def _segment_from_row(r: sqlite3.Row) -> dict[str, Any]:
        d = {f: r[f] for f in SEGMENT_FIELDS}
        d["started_at"] = parse_iso(d["started_at"])
        d["ended_at"] = parse_iso(d["ended_at"])
        d["version"] = r["version"]
        d["uploaded_version"] = r["uploaded_version"]
        return d

    # ---- sessions --------------------------------------------------------
    def save_session(self, sess: dict[str, Any]) -> None:
        row = {f: sess.get(f) for f in SESSION_FIELDS}
        row["started_at"] = iso(row["started_at"])
        row["ended_at"] = iso(row["ended_at"]) if row["ended_at"] else None
        cols = ", ".join(SESSION_FIELDS)
        params = ", ".join(f":{f}" for f in SESSION_FIELDS)
        updates = ", ".join(f"{f} = excluded.{f}" for f in SESSION_FIELDS if f != "id")
        with self._lock:
            self._db.execute(
                f"insert into sessions ({cols}) values ({params}) "
                f"on conflict(id) do update set {updates}, version = sessions.version + 1",
                row,
            )

    def open_sessions(self, employee_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "select * from sessions where employee_id = ? and ended_at is null", (employee_id,)
            ).fetchall()
        return [self._session_from_row(r) for r in rows]

    def pending_sessions(self, employee_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "select * from sessions where employee_id = ? and version > uploaded_version order by started_at",
                (employee_id,),
            ).fetchall()
        return [self._session_from_row(r) for r in rows]

    def mark_session_uploaded(self, session_id: str, version: int) -> None:
        with self._lock:
            self._db.execute(
                "update sessions set uploaded_version = max(uploaded_version, ?) where id = ?", (version, session_id)
            )

    def last_segment_end(self, session_id: str) -> Optional[datetime]:
        with self._lock:
            row = self._db.execute(
                "select max(ended_at) from segments where session_id = ?", (session_id,)
            ).fetchone()
        return parse_iso(row[0]) if row and row[0] else None

    @staticmethod
    def _session_from_row(r: sqlite3.Row) -> dict[str, Any]:
        d = {f: r[f] for f in SESSION_FIELDS}
        d["started_at"] = parse_iso(d["started_at"])
        d["ended_at"] = parse_iso(d["ended_at"]) if d["ended_at"] else None
        d["version"] = r["version"]
        return d

    # ---- events ----------------------------------------------------------
    def add_event(self, event: dict[str, Any]) -> None:
        with self._lock:
            self._db.execute(
                "insert or ignore into events (id, organization_id, employee_id, device_id, occurred_at, event_type, details) "
                "values (?, ?, ?, ?, ?, ?, ?)",
                (
                    event["id"], event["organization_id"], event["employee_id"], event.get("device_id"),
                    iso(event["occurred_at"]), event["event_type"], json.dumps(event.get("details") or {}),
                ),
            )

    def pending_events(self, employee_id: str, limit: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "select * from events where employee_id = ? and uploaded = 0 order by occurred_at limit ?",
                (employee_id, limit),
            ).fetchall()
        return [
            {
                "id": r["id"], "organization_id": r["organization_id"], "employee_id": r["employee_id"],
                "device_id": r["device_id"], "occurred_at": parse_iso(r["occurred_at"]),
                "event_type": r["event_type"], "details": json.loads(r["details"] or "{}"),
            }
            for r in rows
        ]

    def mark_events_uploaded(self, ids: Iterable[str]) -> None:
        with self._lock:
            self._db.executemany("update events set uploaded = 1 where id = ?", [(i,) for i in ids])
