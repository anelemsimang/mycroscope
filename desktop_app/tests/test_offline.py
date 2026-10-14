"""Time away from the computer: when to ask, and uploading the answer."""

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from core.api import ApiError
from core.engine import Identity
from core.offline import ReturnTracker, clean_note, format_away
from core.store import LocalStore
from core.sync import SyncService

T0 = datetime(2026, 10, 14, 8, 0, tzinfo=timezone.utc)


class FormatTests(unittest.TestCase):
    def test_labels_and_notes(self):
        self.assertEqual(format_away(45), "45 min")
        self.assertEqual(format_away(60), "1 h")
        self.assertEqual(format_away(75), "1 h 15 min")
        self.assertIsNone(clean_note("   "))
        self.assertEqual(clean_note("  board pack  "), "board pack")
        self.assertEqual(len(clean_note("x" * 250)), 200)


class ReturnTrackerTests(unittest.TestCase):
    def setUp(self):
        self.t = ReturnTracker()

    def test_asks_after_a_long_idle_stretch_backdated_to_the_last_input(self):
        self.assertIsNone(self.t.observe(T0, "idle", 300, 600, True))
        prompt = self.t.observe(T0 + timedelta(minutes=12), "active", 0, 600, True)
        self.assertEqual(prompt.started_at, T0 - timedelta(seconds=300))
        self.assertEqual(prompt.minutes, 17)
        self.assertIsNone(self.t.observe(T0 + timedelta(minutes=13), "active", 0, 600, True))

    def test_short_absence_pause_and_off_hours_are_not_asked(self):
        self.t.observe(T0, "away", 0, 600, True)
        self.assertIsNone(self.t.observe(T0 + timedelta(minutes=4), "active", 0, 600, True))
        self.t.observe(T0, "idle", 0, 600, True)
        self.assertIsNone(self.t.observe(T0 + timedelta(minutes=30), "paused", 0, 600, True))
        self.t.observe(T0, "away", 0, 600, True)
        self.assertIsNone(self.t.observe(T0 + timedelta(hours=2), "off_hours", 0, 600, True))

    def test_disabled_and_before_the_session_do_not_ask(self):
        self.t.observe(T0, "away", 0, 600, True)
        self.assertIsNone(self.t.observe(T0 + timedelta(minutes=20), "active", 0, 600, False))
        self.assertIsNone(self.t.observe(T0 + timedelta(minutes=40), "active", 0, 600, True))
        self.t.observe(T0, "idle", 3600, 600, True, earliest=T0)
        prompt = self.t.observe(T0 + timedelta(minutes=20), "active", 0, 600, True, earliest=T0)
        self.assertEqual(prompt.started_at, T0)

    def test_sleep_counts_from_when_the_computer_went_to_sleep(self):
        self.t.note_absence(T0)
        prompt = self.t.observe(T0 + timedelta(minutes=40), "active", 0, 600, True)
        self.assertEqual((prompt.started_at, prompt.ended_at), (T0, T0 + timedelta(minutes=40)))

    def test_idle_then_sleep_keeps_the_earlier_start(self):
        self.t.observe(T0, "idle", 600, 600, True)
        self.t.note_absence(T0 + timedelta(minutes=5))
        prompt = self.t.observe(T0 + timedelta(minutes=30), "active", 0, 600, True)
        self.assertEqual(prompt.started_at, T0 - timedelta(seconds=600))


class FakeApi:
    def __init__(self, reject=None):
        self.rows = []
        self.reject = reject or set()

    def upsert(self, table, rows, on_conflict=None, ignore_duplicates=False):
        assert table == "offline_entries" and ignore_duplicates and on_conflict == "id"
        if any(r["reason"] in self.reject for r in rows):
            raise ApiError(403, "23P01", "conflicting key value violates exclusion constraint")
        self.rows.extend(rows)


class FakeClock:
    def now(self):
        return T0


class StoreAndSyncTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = LocalStore(Path(self.dir.name) / "t.db")

    def tearDown(self):
        self.store.close()
        self.dir.cleanup()

    def test_rejected_and_stale_answers_are_dropped(self):
        api = FakeApi(reject={"other"})
        sync = SyncService(api, self.store, Identity("org", "emp", "dev", "sess"), FakeClock(),
                           status_provider=dict, on_policy=lambda p: None, on_auth_lost=lambda m: None,
                           on_connectivity=lambda o: None)
        sync.record_offline_entry({"started_at": T0 - timedelta(minutes=30), "ended_at": T0 - timedelta(minutes=5),
                                   "reason": "meeting", "note": "client"})
        sync.record_offline_entry({"started_at": T0 - timedelta(minutes=20), "ended_at": T0 - timedelta(minutes=10),
                                   "reason": "other", "note": None})
        sync.record_offline_entry({"started_at": T0 - timedelta(days=20), "ended_at": T0 - timedelta(days=20, minutes=-30),
                                   "reason": "call", "note": None})
        sync._push_offline_entries()
        self.assertEqual([r["reason"] for r in api.rows], ["meeting"])
        self.assertEqual(api.rows[0]["note"], "client")
        self.assertTrue(api.rows[0]["started_at"].endswith("Z"))
        self.assertEqual(self.store.pending_offline_entries("emp", 10), [])
        self.store.prune(T0)
        with self.store._lock:
            left = self.store._db.execute("select count(*) from offline_entries").fetchone()[0]
        self.assertEqual(left, 0)


if __name__ == "__main__":
    unittest.main()
