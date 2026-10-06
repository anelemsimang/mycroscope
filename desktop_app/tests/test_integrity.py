import sys
import tempfile
import unittest
from datetime import datetime, time, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import integrity  # noqa: E402
from core.engine import TrackingSettings  # noqa: E402
from core.schedule import Schedule  # noqa: E402
from core.store import LocalStore  # noqa: E402
from tests.test_engine import Harness, T0  # noqa: E402

UTC = timezone.utc
OFFICE = {"tracking_schedule": "work_hours", "work_days": [1, 2, 3, 4, 5], "work_start": "08:00:00", "work_end": "17:00:00"}


class ScheduleTests(unittest.TestCase):
    def test_day_shift_in_local_time(self):
        s = Schedule.from_settings(OFFICE, "Africa/Johannesburg")
        self.assertTrue(s.is_work_time(datetime(2026, 10, 5, 8, 0, tzinfo=UTC)))      # Mon 10:00 SAST
        self.assertFalse(s.is_work_time(datetime(2026, 10, 5, 5, 59, tzinfo=UTC)))    # Mon 07:59
        self.assertFalse(s.is_work_time(datetime(2026, 10, 5, 15, 0, tzinfo=UTC)))    # Mon 17:00
        self.assertFalse(s.is_work_time(datetime(2026, 10, 4, 8, 0, tzinfo=UTC)))     # Sunday

    def test_night_shift_belongs_to_the_day_it_starts(self):
        s = Schedule.from_settings({**OFFICE, "work_start": "22:00", "work_end": "06:00"}, "Africa/Johannesburg")
        self.assertTrue(s.is_work_time(datetime(2026, 10, 5, 21, 0, tzinfo=UTC)))     # Mon 23:00
        self.assertTrue(s.is_work_time(datetime(2026, 10, 6, 2, 0, tzinfo=UTC)))      # Tue 04:00
        self.assertFalse(s.is_work_time(datetime(2026, 10, 5, 2, 0, tzinfo=UTC)))     # Mon 04:00 (Sunday night)

    def test_always_and_narrowing(self):
        always = Schedule.from_settings({}, "Africa/Johannesburg")
        office = Schedule.from_settings(OFFICE, "Africa/Johannesburg")
        evening = datetime(2026, 10, 5, 18, 0, tzinfo=UTC)
        self.assertTrue(always.is_work_time(evening))
        self.assertFalse(always.narrowed_to(office).is_work_time(evening), "unacknowledged 'always' keeps old hours")
        early = Schedule.from_settings({**OFFICE, "work_start": "06:00"}, "Africa/Johannesburg")
        both = early.narrowed_to(office)
        self.assertFalse(both.is_work_time(datetime(2026, 10, 5, 4, 30, tzinfo=UTC)), "06:30 needs both to allow")
        self.assertTrue(both.is_work_time(datetime(2026, 10, 5, 8, 0, tzinfo=UTC)))

    def test_settings_parse_schedule_and_narrow_flags(self):
        s = TrackingSettings.from_dict({**OFFICE, "detect_tampering": True, "flag_after_hours_use": True})
        self.assertEqual((s.schedule.mode, s.schedule.work_start, s.schedule.work_end), ("work_hours", time(8), time(17)))
        n = s.narrowed_to(TrackingSettings.from_dict({"detect_tampering": False}))
        self.assertFalse(n.detect_tampering)
        self.assertFalse(n.flag_after_hours_use)
        self.assertEqual(n.schedule.mode, "work_hours")

    def test_overlaps(self):
        s = Schedule.from_settings(OFFICE, "Africa/Johannesburg")
        night = datetime(2026, 10, 5, 18, 0, tzinfo=UTC)
        self.assertFalse(s.overlaps(night, night + timedelta(hours=8)))
        self.assertTrue(s.overlaps(night, night + timedelta(hours=12)))


class GapTests(unittest.TestCase):
    boot = datetime(2026, 10, 5, 6, 0, tzinfo=UTC)
    then = datetime(2026, 10, 5, 8, 0, tzinfo=UTC)

    def hb(self, clean=False):
        return integrity.heartbeat(self.then, self.boot, 7200.0, clean)

    def test_killed_agent_while_pc_awake(self):
        gap = integrity.detect_gap(self.hb(), self.then + timedelta(minutes=40), self.boot + timedelta(seconds=3), 7200 + 40 * 60)
        self.assertEqual(gap["minutes"], 40)

    def test_sleep_reboot_sign_out_and_short_gaps_are_not_gaps(self):
        later = self.then + timedelta(hours=2)
        self.assertIsNone(integrity.detect_gap(self.hb(), later, self.boot, 7200 + 120), "asleep most of the time")
        self.assertIsNone(integrity.detect_gap(self.hb(), later, later - timedelta(minutes=5), 300), "rebooted")
        self.assertIsNone(integrity.detect_gap(self.hb(clean=True), later, self.boot, 7200 + 7200), "signed out")
        self.assertIsNone(integrity.detect_gap(self.hb(), later, self.boot, 7200 + 300), "five minutes")
        self.assertIsNone(integrity.detect_gap(None, later, self.boot, 9000))


class LateStartTests(unittest.TestCase):
    boot = datetime(2026, 10, 5, 6, 0, tzinfo=UTC)
    then = datetime(2026, 10, 5, 8, 0, tzinfo=UTC)

    def hb(self):
        return integrity.heartbeat(self.then, self.boot, 7200.0, False)

    def test_removed_rebooted_used_then_reinstalled(self):
        # New boot an hour later; the agent only starts after the PC has been awake 90 minutes.
        new_boot = self.boot + timedelta(hours=5)
        start = new_boot + timedelta(minutes=90)
        late = integrity.detect_late_start(self.hb(), start, new_boot, 90 * 60)
        self.assertEqual(late["minutes"], 90)

    def test_normal_starts_are_not_late(self):
        new_boot = self.boot + timedelta(hours=5)
        prompt = new_boot + timedelta(seconds=20)
        self.assertIsNone(integrity.detect_late_start(self.hb(), prompt, new_boot, 20), "started right after a reboot")
        same = self.then + timedelta(minutes=90)
        self.assertIsNone(integrity.detect_late_start(self.hb(), same, self.boot + timedelta(seconds=3), 7200 + 90 * 60),
                          "same boot is a gap, not a late start")
        self.assertIsNone(integrity.detect_late_start(None, same, self.boot, 9000), "first ever run")


class EnvironmentTests(unittest.TestCase):
    def test_vm_vendor(self):
        self.assertEqual(integrity.virtual_machine_vendor(["innotek GmbH", "VirtualBox"]), "VirtualBox")
        self.assertEqual(integrity.virtual_machine_vendor(["Microsoft Corporation", "Virtual Machine"]), "Virtual Machine")
        self.assertIsNone(integrity.virtual_machine_vendor(["Dell Inc.", "Latitude 5440"]))

    def test_probes_run_on_this_machine(self):
        self.assertIsInstance(integrity.is_remote_session(), bool)
        self.assertGreater(integrity.awake_seconds(), 0)
        self.assertGreaterEqual(integrity.uptime_seconds(), integrity.awake_seconds() - 1)


class InputRhythmTests(unittest.TestCase):
    def feed(self, idles, context=("excel.exe", "Budget")):
        d = integrity.InputPatternDetector()
        hits = []
        for i, idle in enumerate(idles):
            hit = d.observe(T0 + timedelta(seconds=i), idle, context)
            if hit:
                hits.append(hit)
        return hits

    def test_jiggler_sawtooth_is_flagged_once(self):
        hits = self.feed([i % 30 for i in range(40 * 60)])
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["interval_seconds"], 29)

    def test_people_are_not_flagged(self):
        import random
        rnd = random.Random(7)
        idles, idle = [], 0
        for _ in range(40 * 60):
            idle = 0 if rnd.random() < 0.08 else idle + 1
            idles.append(idle)
        self.assertEqual(self.feed(idles), [])
        self.assertEqual(self.feed([0] * 2400), [], "continuous typing")
        self.assertEqual(self.feed(list(range(2400))), [], "watching a video")

    def test_window_changes_break_the_pattern(self):
        d = integrity.InputPatternDetector()
        hits = [d.observe(T0 + timedelta(seconds=i), i % 30, ("app", str(i // 120))) for i in range(2400)]
        self.assertFalse(any(hits))


class SuspendTests(unittest.TestCase):
    def test_suspended_time_is_not_recorded(self):
        h = Harness()
        h.run(30)
        h.engine.suspend(T0 + timedelta(seconds=31), "off_hours")
        self.assertEqual(h.engine.live.state, "off_hours")
        h.t += 3600
        h.last_input = h.t
        h.run(20)
        h.stop()
        self.assertEqual(h.totals(), {"active": 49})
        self.assertNotIn("sleep", [e[0] for e in h.events], "resuming must not count the pause as sleep")
        h.assert_contiguous(self)


class AgentBlockTests(unittest.TestCase):
    def setUp(self):
        from core.agent import Agent, Profile
        self.tmp = tempfile.TemporaryDirectory()
        a = self.agent = Agent.__new__(Agent)
        a.store = LocalStore(Path(self.tmp.name) / "t.db")
        a.profile = Profile("emp", "org", "N", "C1", "employee", "O", "Africa/Johannesburg")
        a.settings = TrackingSettings.from_dict(OFFICE)
        a.service = None
        a.sync = None
        self.changes = []
        a.on_change = self.changes.append

    def tearDown(self):
        self.agent.store.close()
        self.tmp.cleanup()

    def test_blocks(self):
        a = self.agent
        work = datetime(2026, 10, 5, 8, 0, tzinfo=UTC)
        self.assertIsNone(a.recording_block(work))
        self.assertEqual(a.recording_block(work + timedelta(hours=10)), "off_hours")
        a._apply_service({"level": "read_only", "status": "past_due"})
        self.assertEqual(a.recording_block(work), "inactive")
        self.assertEqual(self.changes, ["state"])
        a._apply_service({"level": "full", "status": "active"})
        self.assertIsNone(a.recording_block(work))

    def test_heartbeat_roundtrip(self):
        a = self.agent
        now = datetime.now(UTC)
        a._write_heartbeat(now, clean=True)
        hb = a._cached_heartbeat()
        self.assertTrue(hb["clean"])
        self.assertEqual(datetime.fromisoformat(hb["wall"]), now)


if __name__ == "__main__":
    unittest.main()
