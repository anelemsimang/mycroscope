import os
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import files  # noqa: E402
from core.api import ApiError  # noqa: E402
from core.engine import Identity, TrackingSettings  # noqa: E402
from core.files import (FILE_ACTION_ADDED, FILE_ACTION_MODIFIED, FILE_ACTION_REMOVED, FILE_ACTION_RENAMED_NEW,  # noqa: E402
                        FILE_ACTION_RENAMED_OLD, CopyTracker, Drive, FileActivityMonitor, FileSettings, Platform,
                        Target, is_noise, unique_folders)
from core.store import LocalStore  # noqa: E402
from core.sync import SyncService  # noqa: E402

T0 = datetime(2026, 10, 14, 8, 0, tzinfo=timezone.utc)
USB = Target("E:\\", "removable", "KINGSTON (E:)")


def at(seconds: float) -> datetime:
    return T0 + timedelta(seconds=seconds)


class TrackerHarness:
    def __init__(self, sizes=None):
        self.sizes = sizes if sizes is not None else {}
        self.events = []
        self.tracker = CopyTracker(self.inspect, self.events.append)

    def inspect(self, path, destination):
        return self.sizes.get(path, 1000)


class NoiseTests(unittest.TestCase):
    def test_noise(self):
        for rel in ("~$report.docx", "report.docx.tmp", "Thumbs.db", "desktop.ini", "a\\.git\\index",
                    "System Volume Information\\x", "$RECYCLE.BIN\\S-1\\a.txt", "file.crdownload", "._x.pdf",
                    ".dropbox.cache\\a.bin", "shortcut.lnk", ""):
            self.assertTrue(is_noise(rel), rel)
        for rel in ("report.docx", "Projects\\Q3\\budget.xlsx", "photo.JPG", "notes"):
            self.assertFalse(is_noise(rel), rel)


class CopyTrackerTests(unittest.TestCase):
    def test_records_a_file_once_the_copy_has_finished(self):
        h = TrackerHarness({"E:\\docs\\budget.xlsx": 52000})
        h.tracker.changed(USB, FILE_ACTION_ADDED, "docs\\budget.xlsx", at(0))
        h.tracker.changed(USB, FILE_ACTION_MODIFIED, "docs\\budget.xlsx", at(3))
        h.tracker.flush(at(6))
        self.assertEqual(h.events, [], "still being written 3 seconds ago")
        h.tracker.flush(at(8.5))
        self.assertEqual(len(h.events), 1)
        e = h.events[0]
        self.assertEqual((e["event_type"], e["destination"], e["label"], e["file_name"], e["size_bytes"], e["file_count"]),
                         ("file_copied", "removable", "KINGSTON (E:)", "budget.xlsx", 52000, 1))
        self.assertEqual(e["occurred_at"], at(0))

    def test_modified_alone_is_not_a_copy(self):
        h = TrackerHarness()
        h.tracker.changed(USB, FILE_ACTION_MODIFIED, "existing.docx", at(0))
        h.tracker.flush(at(60))
        self.assertEqual(h.events, [])

    def test_deleted_or_renamed_away_before_finishing_is_dropped(self):
        h = TrackerHarness()
        h.tracker.changed(USB, FILE_ACTION_ADDED, "a.docx", at(0))
        h.tracker.changed(USB, FILE_ACTION_REMOVED, "a.docx", at(1))
        h.tracker.changed(USB, FILE_ACTION_ADDED, "b.partial", at(0))
        h.tracker.changed(USB, FILE_ACTION_RENAMED_OLD, "b.partial", at(1))
        h.tracker.changed(USB, FILE_ACTION_RENAMED_NEW, "b.zip", at(1))
        h.tracker.flush(at(60))
        self.assertEqual([e["file_name"] for e in h.events], ["b.zip"])

    def test_skips_what_inspect_rejects_and_noise(self):
        h = TrackerHarness({"E:\\folder": None})
        h.tracker.changed(USB, FILE_ACTION_ADDED, "folder", at(0))
        h.tracker.changed(USB, FILE_ACTION_ADDED, "~$temp.docx", at(0))
        h.tracker.flush(at(60))
        self.assertEqual(h.events, [])

    def test_inspect_errors_never_escape(self):
        def boom(path, destination):
            raise OSError("gone")
        events = []
        t = CopyTracker(boom, events.append)
        t.changed(USB, FILE_ACTION_ADDED, "a.txt", at(0))
        t.flush(at(60))
        self.assertEqual(events, [])

    def test_same_file_again_within_twelve_hours_is_not_repeated(self):
        h = TrackerHarness()
        for start in (0, 3600, 13 * 3600):
            h.tracker.changed(USB, FILE_ACTION_ADDED, "a.txt", at(start))
            h.tracker.flush(at(start + 10))
        self.assertEqual(len(h.events), 2)

    def test_many_files_become_a_summary_row(self):
        h = TrackerHarness()
        for i in range(250):
            h.tracker.changed(USB, FILE_ACTION_ADDED, f"photos\\IMG_{i:04}.jpg", at(0))
        h.tracker.flush(at(10))
        self.assertEqual(len(h.events), files.MAX_FILES_PER_WINDOW)
        h.tracker.flush(at(10 + files.RATE_WINDOW_SECONDS))
        summary = h.events[-1]
        self.assertIsNone(summary["file_name"])
        self.assertEqual(summary["file_count"], 150)
        self.assertEqual(summary["size_bytes"], 150 * 1000)
        self.assertEqual(sum(e["file_count"] for e in h.events), 250)

    def test_force_flush_reports_everything_pending(self):
        h = TrackerHarness()
        h.tracker.changed(USB, FILE_ACTION_ADDED, "a.txt", at(0))
        h.tracker.flush(at(1), force=True)
        self.assertEqual(len(h.events), 1)


class FakePlatform(Platform):
    def __init__(self):
        self.drive_map = {}
        self.phone_map = {}
        self.clouds = []
        self.watching = {}

    def drives(self):
        return dict(self.drive_map)

    def phones(self):
        return dict(self.phone_map)

    def cloud_folders(self):
        return list(self.clouds)

    def watch(self, root, on_change, stop):
        self.watching[root] = (on_change, stop)

    def inspect(self, path, destination):
        return 10

    def active_roots(self):
        return sorted(r for r, (_, stop) in self.watching.items() if not stop.is_set())


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.kv = {}
        self.events = []
        self.now = T0
        self.platform = FakePlatform()
        self.m = FileActivityMonitor(self.events.append, self.kv.get, self.kv.__setitem__, lambda: self.now,
                                     self.platform)
        self.m._settings = FileSettings(removable=True, cloud=True, network=True)
        self.m._active = True

    def kinds(self):
        return [(e["event_type"], e["label"]) for e in self.events]

    def test_connections_watchers_and_copies(self):
        p = self.platform
        p.drive_map = {
            "F:\\": Drive("F:\\", "removable", "BACKUP (F:)", "vol:1"),
            "Z:\\": Drive("Z:\\", "network", "\\\\server\\share", "net:Z:"),
            "G:\\": Drive("G:\\", "cloud", "Google Drive", "vol:2"),
        }
        p.clouds = [("C:\\Users\\a\\OneDrive", "OneDrive (personal)")]
        self.m.poll()
        self.assertEqual(self.kinds(), [("drive_connected", "BACKUP (F:)")])
        self.assertEqual(p.active_roots(), ["C:\\Users\\a\\OneDrive", "F:\\", "G:\\", "Z:\\"])

        # Plugging in a USB stick and a phone
        self.now = at(5)
        p.drive_map["E:\\"] = Drive("E:\\", "removable", "KINGSTON (E:)", "vol:3")
        p.phone_map = {"USB\\VID_1\\abc": "Galaxy S24"}
        self.m.poll()
        self.assertEqual(self.kinds()[1:], [("drive_connected", "KINGSTON (E:)"), ("phone_connected", "Galaxy S24")])
        self.assertEqual(self.events[2]["destination"], "phone")

        # A copy onto it is reported after the quiet period
        on_change, _ = p.watching["E:\\"]
        on_change(FILE_ACTION_ADDED, "clients.xlsx")
        self.now = at(20)
        self.m.poll()
        self.assertEqual(self.events[-1]["file_name"], "clients.xlsx")
        self.assertEqual(self.events[-1]["destination"], "removable")

        # Removing the stick stops its watcher; nothing is reported for staying connected
        del p.drive_map["E:\\"]
        n = len(self.events)
        self.m.poll()
        self.assertNotIn("E:\\", p.active_roots())
        self.assertEqual(len(self.events), n)

    def test_only_switched_on_destinations_are_watched(self):
        p = self.platform
        p.drive_map = {"F:\\": Drive("F:\\", "removable", "X (F:)", "vol:1"),
                       "Z:\\": Drive("Z:\\", "network", "\\\\s\\x", "net:Z:")}
        p.phone_map = {"USB\\p": "Phone"}
        p.clouds = [("C:\\OneDrive", "OneDrive")]
        self.m._settings = FileSettings(cloud=True)
        self.m.poll()
        self.assertEqual(self.events, [])
        self.assertEqual(p.active_roots(), ["C:\\OneDrive"])

    def test_already_connected_device_is_reported_once_per_twelve_hours(self):
        self.platform.drive_map = {"F:\\": Drive("F:\\", "removable", "X (F:)", "vol:1")}
        self.m.poll()
        self.assertEqual(len(self.events), 1)
        # Recording pauses and resumes (or the agent restarts) with the drive still plugged in
        self.m._active = False
        self.m.poll()
        self.m._active = True
        self.now = at(3600)
        self.m.poll()
        self.assertEqual(len(self.events), 1)
        self.m._active = False
        self.m.poll()
        self.m._active = True
        self.now = at(13 * 3600)
        self.m.poll()
        self.assertEqual(len(self.events), 2)

    def test_inactive_stops_watching_and_flushes(self):
        self.platform.drive_map = {"F:\\": Drive("F:\\", "removable", "X (F:)", "vol:1")}
        self.m.poll()
        on_change, _ = self.platform.watching["F:\\"]
        on_change(FILE_ACTION_ADDED, "late.txt")
        self.m._active = False
        self.m.poll()
        self.assertEqual(self.platform.active_roots(), [])
        self.assertEqual(self.events[-1]["file_name"], "late.txt")

    def test_configure_starts_a_thread_only_when_something_is_on(self):
        self.m._settings, self.m._active = FileSettings(), False
        self.m.configure(FileSettings(), True)
        self.assertIsNone(self.m._thread)
        self.m.configure(FileSettings(removable=True), True)
        self.assertIsNotNone(self.m._thread)
        self.m.stop()
        self.assertIsNone(self.m._thread)


class SettingsTests(unittest.TestCase):
    def test_flags_and_narrowing(self):
        s = TrackingSettings.from_dict({"detect_removable_media": True, "detect_cloud_sync": True,
                                        "detect_network_drives": False})
        self.assertTrue(s.detect_removable_media and s.detect_cloud_sync)
        self.assertFalse(s.detect_network_drives)
        self.assertFalse(s.narrowed_to(None).detect_removable_media)
        acknowledged = TrackingSettings.from_dict({"detect_removable_media": True})
        n = s.narrowed_to(acknowledged)
        self.assertTrue(n.detect_removable_media)
        self.assertFalse(n.detect_cloud_sync, "not in the acknowledged notice yet")


class FakeApi:
    def __init__(self, reject=None):
        self.rows = []
        self.reject = reject or set()

    def upsert(self, table, rows, on_conflict=None, ignore_duplicates=False):
        assert table == "file_events" and ignore_duplicates
        if any(r["file_name"] in self.reject for r in rows):
            raise ApiError(403, "42501", "new row violates row-level security policy")
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

    def sync(self, api):
        return SyncService(api, self.store, Identity("org", "emp", "dev", "sess"), FakeClock(),
                           status_provider=dict, on_policy=lambda p: None, on_auth_lost=lambda m: None,
                           on_connectivity=lambda o: None)

    def test_upload_drops_rejected_rows_and_clears_local_copies(self):
        api = FakeApi(reject={"blocked.txt"})
        s = self.sync(api)
        for name in ("a.txt", "blocked.txt", "b.txt"):
            s.record_file_event({"event_type": "file_copied", "destination": "removable", "label": "X",
                                 "file_name": name, "file_count": 1, "size_bytes": 5, "occurred_at": T0})
        s.record_file_event({"event_type": "file_copied", "destination": "removable", "label": "X",
                             "file_name": "old.txt", "file_count": 1, "size_bytes": 5,
                             "occurred_at": T0 - timedelta(days=20)})
        s._push_file_events()
        self.assertEqual(sorted(r["file_name"] for r in api.rows), ["a.txt", "b.txt"])
        row = api.rows[0]
        self.assertEqual((row["organization_id"], row["employee_id"], row["device_id"]), ("org", "emp", "dev"))
        self.assertIsInstance(row["occurred_at"], str)
        self.assertEqual(self.store.pending_file_events("emp", 100), [])
        self.store.prune(T0)
        with self.store._lock:
            left = self.store._db.execute("select count(*) from file_events").fetchone()[0]
        self.assertEqual(left, 0, "names of copied files are not kept on the PC once uploaded")


class FolderTests(unittest.TestCase):
    def test_unique_folders(self):
        with tempfile.TemporaryDirectory() as d:
            a = os.path.join(d, "OneDrive")
            b = os.path.join(a, "Inner")
            os.makedirs(b)
            got = unique_folders([(a, "OneDrive"), (a.upper(), "dup"), (b, "nested"),
                                  (os.path.join(d, "missing"), "x"), ("", "y")])
            self.assertEqual(got, [(a, "OneDrive")])


@unittest.skipUnless(os.name == "nt", "Windows only")
class WindowsTests(unittest.TestCase):
    def test_watcher_and_inspect_on_a_real_folder(self):
        platform = files.WindowsPlatform()
        with tempfile.TemporaryDirectory() as d:
            seen = []
            stop = threading.Event()
            platform.watch(d, lambda action, rel: seen.append((action, rel)), stop)
            time.sleep(0.5)
            path = os.path.join(d, "report.pdf")
            with open(path, "wb") as fh:
                fh.write(b"x" * 1234)
            deadline = time.time() + 5
            while not any(rel == "report.pdf" and a == FILE_ACTION_ADDED for a, rel in seen) and time.time() < deadline:
                time.sleep(0.1)
            stop.set()
            self.assertIn((FILE_ACTION_ADDED, "report.pdf"), seen)
            self.assertEqual(platform.inspect(path, "removable"), 1234)
            self.assertIsNone(platform.inspect(d, "removable"), "folders are not files")
            self.assertIsNone(platform.inspect(os.path.join(d, "missing"), "removable"))
            self.assertEqual(platform.inspect(path, "network"), 1234, "created by this user")
            time.sleep(1.5)  # let the watcher close its handle before the folder is removed

    def test_enumeration_does_not_fail(self):
        platform = files.WindowsPlatform()
        self.assertIsInstance(platform.drives(), dict)
        self.assertIsInstance(platform.phones(), dict)
        self.assertIsInstance(platform.cloud_folders(), list)


if __name__ == "__main__":
    unittest.main()
