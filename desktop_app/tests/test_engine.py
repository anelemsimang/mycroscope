import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.engine import Identity, SegmentEngine, TrackingSettings  # noqa: E402
from core.monitor import Sample, normalise_url  # noqa: E402
from core.store import LocalStore  # noqa: E402
from utils.timeutil import iso, parse_iso  # noqa: E402

T0 = datetime(2026, 10, 5, 21, 50, 0, tzinfo=timezone.utc)


class Harness:
    def __init__(self, threshold=60, **settings):
        self.dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.store = LocalStore(Path(self.dir.name) / "t.db")
        self.events = []
        self.engine = SegmentEngine(
            self.store,
            Identity("org", "emp", "dev", "sess"),
            TrackingSettings(idle_threshold_seconds=threshold, **settings),
            lambda kind, at, details: self.events.append((kind, at, details)),
        )
        self.t = 0
        self.last_input = 0
        self.engine.start(T0)

    def run(self, seconds, app="Word", title="Doc", url=None, input_=True, locked=False, paused=False,
            project=None, step=1):
        for _ in range(0, seconds, step):
            self.t += step
            if input_ and not locked:
                self.last_input = self.t
            sample = Sample(
                idle_seconds=self.t - self.last_input, locked=locked,
                app_name=app, process_name=(app or "x").lower() + ".exe", window_title=title,
                url=url, domain=normalise_url(url)[1] if url else None,
            )
            self.engine.tick(T0 + timedelta(seconds=self.t), sample, paused, project)

    def stop(self):
        self.engine.stop(T0 + timedelta(seconds=self.t))

    def segments(self):
        rows = self.store._db.execute("select * from segments order by started_at").fetchall()
        return [dict(r) for r in rows]

    def totals(self):
        out = {}
        for s in self.segments():
            d = (parse_iso(s["ended_at"]) - parse_iso(s["started_at"])).total_seconds()
            out[s["state"]] = out.get(s["state"], 0) + d
        return out

    def assert_contiguous(self, tc):
        segs = self.segments()
        for a, b in zip(segs, segs[1:]):
            tc.assertLessEqual(a["ended_at"], b["started_at"], f"overlap {a} {b}")
        for s in segs:
            tc.assertLessEqual(s["started_at"], s["ended_at"])
            dur = (parse_iso(s["ended_at"]) - parse_iso(s["started_at"])).total_seconds()
            tc.assertLessEqual(dur, 300)


class EngineTests(unittest.TestCase):
    def test_app_switch_splits_and_totals_match_wall_time(self):
        h = Harness()
        h.run(30, app="Word")
        h.run(20, app="Excel")
        h.stop()
        segs = h.segments()
        self.assertEqual([s["app_name"] for s in segs], ["Word", "Excel"])
        self.assertEqual(h.totals(), {"active": 50})
        h.assert_contiguous(self)

    def test_idle_is_relabelled_back_to_last_input(self):
        h = Harness(threshold=60)
        h.run(100)
        h.run(90, input_=False)
        h.run(10)
        h.stop()
        t = h.totals()
        # input resumes somewhere in (190, 191]; the agent sees it at 191
        self.assertEqual(t["active"], 109)
        self.assertEqual(t["idle"], 91)
        idle = [s for s in h.segments() if s["state"] == "idle"]
        self.assertIsNone(idle[0]["app_name"])
        h.assert_contiguous(self)

    def test_idle_threshold_longer_than_segment_relabels_closed_segments(self):
        h = Harness(threshold=600)
        h.run(10)
        h.run(700, input_=False)
        h.stop()
        t = h.totals()
        self.assertEqual(t["active"], 10)
        self.assertEqual(t["idle"], 700)
        h.assert_contiguous(self)

    def test_lock_counts_as_away_from_last_input(self):
        h = Harness(threshold=300)
        h.run(50)
        h.run(20, input_=False)
        h.run(100, locked=True)
        h.run(10)
        h.stop()
        t = h.totals()
        self.assertEqual(t["active"], 59)
        self.assertEqual(t["away"], 121)
        self.assertIn("lock", [e[0] for e in h.events])
        self.assertIn("unlock", [e[0] for e in h.events])
        h.assert_contiguous(self)

    def test_sleep_gap_becomes_chunked_away_segments(self):
        h = Harness()
        h.run(10)
        h.t += 3600  # laptop asleep for an hour
        h.last_input = h.t
        h.run(10)
        h.stop()
        t = h.totals()
        self.assertEqual(t["active"], 19)
        self.assertEqual(t["away"], 3601)
        kinds = [e[0] for e in h.events]
        self.assertEqual(kinds, ["sleep", "wake"])
        h.assert_contiguous(self)

    def test_long_activity_is_split_at_max_length(self):
        h = Harness()
        h.run(1000)
        h.stop()
        segs = h.segments()
        self.assertEqual(len(segs), 4)
        self.assertEqual(h.totals(), {"active": 1000})
        h.assert_contiguous(self)

    def test_rapid_title_changes_merge(self):
        h = Harness()
        for i in range(5):
            h.run(1, title=f"Counter {i}")
        h.run(30, title="Stable")
        h.run(5, title="Next")
        h.stop()
        segs = h.segments()
        self.assertEqual(len(segs), 2)
        self.assertEqual(segs[0]["window_title"], "Stable")

    def test_tracking_toggles_strip_fields(self):
        h = Harness(track_window_titles=False, track_full_urls=False)
        h.run(10, app="Google Chrome", title="Secret", url="https://www.example.com/path?q=1")
        h.stop()
        s = h.segments()[0]
        self.assertEqual(s["app_name"], "Google Chrome")
        self.assertIsNone(s["window_title"])
        self.assertIsNone(s["url"])
        self.assertEqual(s["domain"], "example.com")

    def test_pause_and_project_switch(self):
        h = Harness()
        h.run(10, project="p1")
        h.run(20, paused=True, project="p1")
        h.run(10, project="p2")
        h.stop()
        segs = h.segments()
        self.assertEqual([(s["state"], s["project_id"]) for s in segs],
                         [("active", "p1"), ("paused", "p1"), ("active", "p2")])
        self.assertIsNone(segs[1]["app_name"])
        h.assert_contiguous(self)

    def test_a_deleted_period_drops_project_time_and_starts_again(self):
        h = Harness()
        h.run(30, project="p1")
        self.assertIsNotNone(h.engine.open)
        h.store.save_segment({
            "id": "kept", "organization_id": "org", "employee_id": "emp", "device_id": "dev",
            "session_id": "sess", "project_id": "older", "state": "active",
            "started_at": T0 - timedelta(days=2), "ended_at": T0 - timedelta(days=2) + timedelta(seconds=10),
            "app_name": "Word", "process_name": "word.exe", "window_title": None, "url": None, "domain": None,
        })
        h.store.drop_recorded("emp", T0, T0 + timedelta(hours=1))
        h.engine.discard_started_in(T0, T0 + timedelta(hours=1))
        self.assertIsNone(h.engine.open)
        self.assertEqual([s["id"] for s in h.segments()], ["kept"])
        h.run(10, project=None)
        fresh = [s for s in h.segments() if s["id"] != "kept"]
        self.assertEqual(len(fresh), 1)
        self.assertIsNone(fresh[0]["project_id"])
        self.assertLess(
            (parse_iso(fresh[0]["ended_at"]) - parse_iso(fresh[0]["started_at"])).total_seconds(), 20)

    def test_time_never_goes_backwards(self):
        h = Harness()
        h.run(10)
        h.engine.tick(T0 + timedelta(seconds=5), Sample(), False, None)
        h.run(5)
        h.stop()
        self.assertEqual(h.totals(), {"active": 15})
        h.assert_contiguous(self)


class StoreTests(unittest.TestCase):
    def test_versioning_marks_edits_for_reupload(self):
        h = Harness()
        h.run(10)
        h.stop()
        pending = h.store.pending_segments("emp", 100)
        self.assertEqual(len(pending), 1)
        seg = pending[0]
        h.store.mark_segments_uploaded([(seg["id"], seg["version"])])
        self.assertEqual(h.store.pending_segments("emp", 100), [])
        seg["state"] = "idle"
        h.store.save_segment(seg)
        self.assertEqual(len(h.store.pending_segments("emp", 100)), 1)
        h.store.mark_segments_uploaded([(seg["id"], seg["version"])])  # stale version
        self.assertEqual(len(h.store.pending_segments("emp", 100)), 1)

    def test_rejected_rows_leave_queue(self):
        h = Harness()
        h.run(10)
        h.stop()
        seg = h.store.pending_segments("emp", 100)[0]
        h.store.mark_segment_rejected(seg["id"], seg["version"], "23P01 overlap")
        self.assertEqual(h.store.count_pending("emp"), 0)

    def test_iso_roundtrip(self):
        dt = datetime(2026, 1, 2, 3, 4, 5, 678000, tzinfo=timezone.utc)
        self.assertEqual(parse_iso(iso(dt)), dt)
        self.assertEqual(parse_iso("2026-01-02T03:04:05.6789+02:00"),
                         datetime(2026, 1, 2, 1, 4, 5, 678900, tzinfo=timezone.utc))


class WipeTests(unittest.TestCase):
    def test_sync_applies_a_wipe_before_remembering_it(self):
        from core.sync import SyncService

        h = Harness()
        h.run(10, project="p1")
        h.stop()
        self.assertEqual(h.store.count_pending("emp"), 1)
        seen = []

        class Api:
            def rpc(self, fn, args=None):
                after = int((args or {}).get("p_after") or 0)
                if fn != "get_my_activity_wipes":
                    return []
                if after >= 4:
                    return []
                return [{"id": 4, "wiped_from": iso(T0 - timedelta(minutes=1)),
                         "wiped_to": iso(T0 + timedelta(hours=1))}]

        sync = SyncService(
            Api(), h.store, Identity("org", "emp", "dev", "sess"), type("C", (), {"now": staticmethod(lambda: T0)})(),
            status_provider=dict, on_policy=lambda p: None, on_auth_lost=lambda m: None,
            on_connectivity=lambda o: None, on_wipes=lambda rows: seen.append(rows),
        )
        sync._pull_wipes()
        self.assertEqual(seen[0][0]["id"], 4)
        self.assertEqual(h.store.get("wipe_cursor:emp"), "4")
        sync._pull_wipes()
        self.assertEqual(len(seen), 1)

    def test_wipe_covering_now_clears_the_desktop_project(self):
        from types import SimpleNamespace
        from core.agent import Agent

        h = Harness()
        h.run(30, project="p1")
        agent = Agent.__new__(Agent)
        agent.store = h.store
        agent.profile = SimpleNamespace(employee_id="emp")
        agent.project_id = "p1"
        agent.engine = h.engine
        agent._engine_lock = __import__("threading").Lock()
        agent.clock = SimpleNamespace(now=lambda: T0 + timedelta(seconds=40))
        agent.projects = [{"id": "p1", "name": "Website"}]
        refreshed = []
        agent.refresh_projects = lambda: refreshed.append("projects")
        agent.on_change = lambda kind: refreshed.append(kind)
        agent.apply_wipes([{
            "id": 1,
            "wiped_from": iso(T0),
            "wiped_to": iso(T0 + timedelta(hours=1)),
        }])
        self.assertIsNone(agent.project_id)
        self.assertIsNone(h.engine.open)
        self.assertEqual(h.segments(), [])
        self.assertIn("projects", refreshed)

        agent.project_id = "p2"
        agent.apply_wipes([{
            "id": 2,
            "wiped_from": iso(T0 - timedelta(days=3)),
            "wiped_to": iso(T0 - timedelta(days=2)),
        }])
        self.assertEqual(agent.project_id, "p2")


class SettingsTests(unittest.TestCase):
    def test_narrowed_keeps_only_what_both_allow(self):
        new = TrackingSettings(True, True, True, True, 600, False)
        old = TrackingSettings(True, False, True, False, 300, True)
        self.assertEqual(new.narrowed_to(old), TrackingSettings(True, False, True, False, 600, True))

    def test_narrowed_without_acknowledged_records_nothing_optional(self):
        n = TrackingSettings(True, True, True, True, 300, False).narrowed_to(None)
        self.assertEqual((n.track_apps, n.track_window_titles, n.track_web_domains, n.track_full_urls, n.allow_pause),
                         (False, False, False, False, True))


class AgentPolicyTests(unittest.TestCase):
    """Widened settings must not take effect until the new notice is acknowledged."""

    def setUp(self):
        from core.agent import Agent, Profile
        self.tmp = tempfile.TemporaryDirectory()
        self.agent = Agent.__new__(Agent)
        self.agent.store = LocalStore(Path(self.tmp.name) / "t.db")
        self.agent.profile = Profile("emp", "org", "N", "C1", "employee", "O", "Africa/Johannesburg")
        self.calls = []

        agent = self

        class FakeApi:
            def select(self, table, params):
                agent.calls.append(table)
                return agent.server_rows

        self.agent.api = FakeApi()
        self.server_rows = []

    def tearDown(self):
        self.agent.store.close()
        self.tmp.cleanup()

    @staticmethod
    def policy(acknowledged, **settings):
        base = {"track_apps": True, "track_window_titles": False, "track_web_domains": True,
                "track_full_urls": False, "idle_threshold_seconds": 300, "allow_pause": True}
        return {"policy_id": "p", "acknowledged": acknowledged, "settings": {**base, **settings}}

    def test_widening_waits_for_acknowledgement(self):
        a = self.agent
        self.assertFalse(a._effective_settings(self.policy(True)).track_window_titles)
        wider = self.policy(False, track_window_titles=True, track_full_urls=True, allow_pause=False)
        pending = a._effective_settings(wider)
        self.assertFalse(pending.track_window_titles)
        self.assertFalse(pending.track_full_urls)
        self.assertTrue(pending.allow_pause)
        self.assertEqual(self.calls, [], "cached acknowledged settings should avoid a server call")
        accepted = a._effective_settings({**wider, "acknowledged": True})
        self.assertTrue(accepted.track_window_titles)
        self.assertFalse(accepted.allow_pause)

    def test_offline_question_waits_until_the_notice_is_acknowledged(self):
        a = self.agent
        a._effective_settings(self.policy(True, ask_offline_reason=True, offline_prompt_minutes=10))
        pending = a._effective_settings(self.policy(False, ask_offline_reason=True, offline_prompt_minutes=5))
        self.assertTrue(pending.ask_offline_reason)
        self.assertEqual(pending.offline_prompt_minutes, 10, "a shorter wait asks more often, so it waits")
        self.assertEqual(
            a._effective_settings(self.policy(False, ask_offline_reason=True, offline_prompt_minutes=30)).offline_prompt_minutes,
            30, "asking less often applies immediately")
        self.assertFalse(a._effective_settings(self.policy(False, ask_offline_reason=False)).ask_offline_reason)

    def test_turning_the_question_on_waits_for_acknowledgement(self):
        a = self.agent
        a._effective_settings(self.policy(True))
        self.assertFalse(a._effective_settings(self.policy(False, ask_offline_reason=True)).ask_offline_reason)
        self.assertTrue(a._effective_settings(self.policy(True, ask_offline_reason=True)).ask_offline_reason)

    def test_office_check_waits_until_the_notice_is_acknowledged(self):
        a = self.agent
        a._effective_settings(self.policy(True))
        self.assertFalse(a._effective_settings(self.policy(False, track_work_location=True)).track_work_location)
        self.assertTrue(a._effective_settings(self.policy(True, track_work_location=True)).track_work_location)
        self.assertFalse(a._effective_settings(self.policy(False, track_work_location=False)).track_work_location)

    def test_narrowing_applies_immediately(self):
        a = self.agent
        a._effective_settings(self.policy(True))
        self.assertFalse(a._effective_settings(self.policy(False, track_web_domains=False)).track_web_domains)

    def test_uses_server_record_when_nothing_cached(self):
        self.server_rows = [{"monitoring_policies": {"settings_snapshot": {"track_apps": True, "track_window_titles": True,
                                                                          "track_web_domains": False, "track_full_urls": False}}}]
        s = self.agent._effective_settings(self.policy(False, track_window_titles=True))
        self.assertEqual(self.calls, ["consents"])
        self.assertTrue(s.track_window_titles)
        self.assertFalse(s.track_web_domains)

    def test_never_acknowledged_records_nothing_optional(self):
        s = self.agent._effective_settings(self.policy(False))
        self.assertFalse(s.track_apps or s.track_window_titles or s.track_web_domains or s.track_full_urls)


class UrlTests(unittest.TestCase):
    def test_normalise(self):
        self.assertEqual(normalise_url("github.com/a/b"), ("https://github.com/a/b", "github.com"))
        self.assertEqual(normalise_url("https://www.News24.com/x")[1], "news24.com")
        self.assertEqual(normalise_url("how to cook rice"), (None, None))
        self.assertEqual(normalise_url("edge://settings"), ("edge://settings", None))
        self.assertEqual(normalise_url(""), (None, None))


if __name__ == "__main__":
    unittest.main()
