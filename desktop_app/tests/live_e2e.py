"""Live end-to-end check of the desktop agent against the configured Supabase project.

Creates a throwaway organisation (owner + one employee), runs the real agent
controller for about two minutes (including a simulated network outage), and
verifies what the manager sees. Requires "Confirm email" to be off, or pass
--owner-email/--owner-password for an already confirmed owner.

    venv\\Scripts\\python tests\\live_e2e.py
"""

import argparse
import os
import secrets
import sys
import tempfile
import time
from pathlib import Path

os.environ["LOCALAPPDATA"] = tempfile.mkdtemp(prefix="mycroscope-e2e-")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests  # noqa: E402

from config import SUPABASE_KEY, SUPABASE_URL  # noqa: E402
from core.agent import Agent  # noqa: E402
from core.api import AuthError, SupabaseApi  # noqa: E402
from utils.logger import setup_logging  # noqa: E402

PASS = "\u2713"
failures: list[str] = []


def check(cond: bool, label: str) -> None:
    print(f"  {PASS if cond else 'X'} {label}")
    if not cond:
        failures.append(label)


def wait_for(fn, timeout=60, interval=2):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        time.sleep(interval)
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--owner-email")
    ap.add_argument("--owner-password")
    args = ap.parse_args()
    setup_logging()
    tag = secrets.token_hex(3)

    print("1. Owner")
    owner = SupabaseApi(SUPABASE_URL, SUPABASE_KEY)
    if args.owner_email:
        owner.sign_in(args.owner_email, args.owner_password)
    else:
        email = f"e2e-owner-{tag}@example.com"
        resp = requests.post(f"{SUPABASE_URL}/auth/v1/signup", headers={"apikey": SUPABASE_KEY}, json={
            "email": email, "password": "E2e-" + secrets.token_urlsafe(12),
            "data": {"signup_type": "owner", "organization_name": f"E2E Test {tag}", "full_name": "E2E Owner"},
        }, timeout=20)
        body = resp.json()
        if resp.status_code >= 400:
            print("   owner signup failed:", body)
            return 1
        if not body.get("access_token"):
            print("   Email confirmation is on, so the owner can't sign in yet. Turn off 'Confirm email' "
                  "or pass --owner-email/--owner-password.")
            return 1
        owner._set_session(body)
    print("   owner signed in")

    print("2. Manager creates employee")
    emp_email = f"e2e-emp-{tag}@example.com"
    created = owner.rpc("create_employee", {"p_name": "E2E Employee", "p_email": emp_email})[0]
    check(bool(created["activation_code"]), f"activation code issued for {created['employee_code']}")

    print("3. Agent: activation, notice, consent")
    events = []
    agent = Agent(on_change=events.append)
    password = "Emp-" + secrets.token_urlsafe(12)
    try:
        agent.activate(created["employee_code"], "WRONGCODE1", emp_email, password)
        check(False, "wrong activation code rejected")
    except AuthError:
        check(True, "wrong activation code rejected")
    agent.activate(created["employee_code"], created["activation_code"], emp_email, password)
    check(agent.profile.employee_code == created["employee_code"], "activated and profile loaded")
    agent.sign_out()
    agent.sign_in(created["employee_code"], password)
    check(agent.profile is not None, "sign-in with employee code")
    policy = agent.fetch_policy()
    check(policy is not None and agent.needs_acknowledgement, "notice requires acknowledgement")
    check("POPIA" in (policy or {}).get("notice_text", ""), "notice mentions POPIA")
    agent.acknowledge_policy()
    check(not agent.needs_acknowledgement, "notice acknowledged")

    print("4. Tracking (20s)")
    agent.start_tracking()
    time.sleep(20)
    agent.sync.poke()
    check(wait_for(lambda: agent.pending_uploads() <= 1, 30), "segments uploaded")

    print("5. Network outage (30s)")
    real_request = agent.api._http.request

    def offline(*a, **k):
        raise requests.ConnectionError("simulated outage")
    agent.api._http.request = offline
    agent.sync.poke()
    time.sleep(30)
    check(agent.online is False, "agent noticed it is offline")
    queued = agent.pending_uploads()
    check(queued >= 1, f"data queued locally while offline ({queued} rows)")
    agent.api._http.request = real_request
    agent.sync.poke()
    check(wait_for(lambda: agent.online and agent.pending_uploads() <= 1, 90), "queue drained after reconnect")

    print("6. Pause and project switch")
    agent.set_paused(True)
    time.sleep(6)
    agent.set_paused(False)
    pid = agent.create_project(f"E2E Project {tag}")
    agent.set_project(pid)
    time.sleep(6)

    print("7. Re-upload everything (idempotency)")
    agent.sync.poke()
    wait_for(lambda: agent.pending_uploads() <= 1, 30)
    emp_id = agent.profile.employee_id
    server_before = owner.select("activity_segments", {"employee_id": f"eq.{emp_id}", "select": "id"})
    agent.store._db.execute("update segments set uploaded_version = 0 where employee_id = ?", (emp_id,))
    agent.sync.poke()
    wait_for(lambda: agent.pending_uploads() <= 1, 60)
    server_after = owner.select("activity_segments", {"employee_id": f"eq.{emp_id}", "select": "id"})
    local_ids = {r[0] for r in agent.store._db.execute("select id from segments where employee_id = ?", (emp_id,))}
    check(len(server_after) == len({r["id"] for r in server_after}), "no duplicate rows on server")
    check(abs(len(server_after) - len(server_before)) <= 1, "re-upload did not add rows")
    check(local_ids - {r["id"] for r in server_after} <= {agent.engine.open["id"] if agent.engine.open else None},
          "every local segment is on the server")

    print("8. Manager view")
    overview = owner.rpc("get_team_overview", {})
    me = next((r for r in overview if r["employee_id"] == emp_id), None)
    check(me is not None and me["is_online"], "employee shows online in team overview")
    check(me is not None and not me["needs_acknowledgement"], "consent recorded")
    states = {r["state"] for r in owner.select("activity_segments", {"employee_id": f"eq.{emp_id}", "select": "state"})}
    check("paused" in states, "pause visible to manager")
    proj = owner.select("activity_segments", {"employee_id": f"eq.{emp_id}", "project_id": f"eq.{pid}", "select": "id"})
    check(len(proj) >= 1, "project time recorded")
    ev = {r["event_type"] for r in owner.select("agent_events", {"employee_id": f"eq.{emp_id}", "select": "event_type"})}
    check({"login", "pause", "resume", "project_switch"} <= ev, f"events recorded ({', '.join(sorted(ev))})")
    local = agent.today_totals()
    print(f"   local totals today: {local}")

    print("9. Sign out")
    agent.sign_out()
    status = owner.select("agent_status", {"employee_id": f"eq.{emp_id}", "select": "state"})
    check(status and status[0]["state"] == "logged_out", "status shows logged out")
    sess = owner.select("agent_sessions", {"employee_id": f"eq.{emp_id}", "select": "ended_at,end_reason"})
    check(all(s["ended_at"] and s["end_reason"] == "logout" for s in sess), "session closed with reason logout")
    total_server = sum(r["duration_seconds"] for r in owner.select(
        "activity_segments", {"employee_id": f"eq.{emp_id}", "select": "duration_seconds"}))
    print(f"   server total {total_server}s across all states")
    check(total_server >= 80, "server time covers the run")

    print("10. Clean-up")
    owner.rpc("delete_employee", {"p_employee": emp_id, "p_reason": "automated end-to-end test"})
    print(f"   employee deleted. Test organisation 'E2E Test {tag}' remains (owner {owner.session.email}).")
    agent.shutdown()

    print("\nRESULT:", "all checks passed" if not failures else f"{len(failures)} failed: {failures}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
