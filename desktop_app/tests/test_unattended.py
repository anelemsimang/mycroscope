import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.unattended import UnattendedWatch  # noqa: E402


def watch(now: float = 0.0) -> UnattendedWatch:
    w = UnattendedWatch(remind_every=120, alert_after_minutes=15, report_every=120, idle_limit=300)
    w.reset(now)
    return w


def run(w: UnattendedWatch, start: float, end: float, idle: float = 1.0, locked: bool = False, step: float = 5.0):
    """Observe every `step` seconds; returns the times of reminders and the reported minutes."""
    reminders, reports = [], []
    t = start
    while t <= end:
        d = w.observe(t, idle, locked)
        if d.remind:
            reminders.append(t)
        if d.report_minutes is not None:
            reports.append(d.report_minutes)
        t += step
    return reminders, reports


class UnattendedWatchTests(unittest.TestCase):
    def test_reminds_every_two_minutes_and_reports_after_fifteen(self):
        w = watch()
        reminders, reports = run(w, 5, 20 * 60)
        self.assertEqual(reminders[:3], [120, 240, 360])
        self.assertEqual(reports, [15, 17, 19])

    def test_nobody_at_the_pc_means_no_reminder_and_no_report(self):
        w = watch()
        self.assertEqual(run(w, 5, 30 * 60, idle=400), ([], []))
        self.assertEqual(run(w, 30 * 60, 60 * 60, locked=True), ([], []))

    def test_reading_without_typing_counts_as_use_but_does_not_pop_up(self):
        w = watch()
        reminders, reports = run(w, 5, 15 * 60, idle=90)
        self.assertEqual(reminders, [])
        self.assertEqual(reports, [15])

    def test_locking_or_long_idle_restarts_the_fifteen_minutes(self):
        w = watch()
        run(w, 5, 10 * 60)
        run(w, 10 * 60 + 5, 11 * 60, locked=True)
        _, reports = run(w, 11 * 60 + 5, 25 * 60)
        self.assertEqual(reports, [], "only 14 minutes of use since unlocking")
        _, reports = run(w, 25 * 60 + 5, 27 * 60)
        self.assertEqual(reports, [15])

    def test_sleep_breaks_continuous_use(self):
        w = watch()
        run(w, 5, 10 * 60)
        _, reports = run(w, 3 * 3600, 3 * 3600 + 10 * 60)
        self.assertEqual(reports, [])

    def test_tracking_resets_everything(self):
        w = watch()
        run(w, 5, 14 * 60)
        w.reset(14 * 60 + 1)
        reminders, reports = run(w, 14 * 60 + 5, 17 * 60)
        self.assertEqual(reminders, [16 * 60 + 5], "the first reminder comes two minutes after the reset")
        self.assertEqual(reports, [], "the fifteen minutes start over")


if __name__ == "__main__":
    unittest.main()
