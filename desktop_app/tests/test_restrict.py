"""Restricted programs are minimised only after the notice is acknowledged, and only while monitoring."""

import os
import socket
import sys
import threading
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.engine import TrackingSettings  # noqa: E402
from core.restrict import Restrictor, matches_app, matches_domain, parse_restrictions  # noqa: E402
from core.siteblock import SiteBlock, active_domains, proxy_is_free  # noqa: E402
from core.schedule import Schedule  # noqa: E402


RULES = [
    {"kind": "app", "pattern": "steam", "work_hours_only": False},
    {"kind": "app", "pattern": "*torrent*", "work_hours_only": True},
    {"kind": "domain", "pattern": "facebook.com", "work_hours_only": False},
]
NOW = datetime(2026, 10, 14, 10, 0, tzinfo=timezone.utc)  # Wednesday 12:00 in Johannesburg


class RestrictTests(unittest.TestCase):
    def test_matching_follows_the_server_rules(self):
        self.assertTrue(matches_app("steam", "Steam", "steam.exe"))
        self.assertTrue(matches_app("*torrent*", "uTorrent", "uTorrent.exe"))
        self.assertFalse(matches_app("steam", "Steam Workshop", "chrome.exe"))
        self.assertTrue(matches_domain("facebook.com", "m.facebook.com"))
        self.assertFalse(matches_domain("facebook.com", "notfacebook.com"))

    def test_a_new_restriction_waits_for_acknowledgement(self):
        published = TrackingSettings.from_dict({"restrictions": RULES, "tracking_schedule": "always"})
        self.assertEqual(published.narrowed_to(None).restrictions, ())
        acknowledged = TrackingSettings.from_dict({"restrictions": [RULES[0]]})
        kept = published.narrowed_to(acknowledged).restrictions
        self.assertEqual([rule.pattern for rule in kept], ["steam"])

    def test_limiting_to_working_hours_can_start_before_the_new_notice(self):
        published = TrackingSettings.from_dict({"restrictions": [
            {"kind": "app", "pattern": "steam", "work_hours_only": True}]})
        acknowledged = TrackingSettings.from_dict({"restrictions": [
            {"kind": "app", "pattern": "steam", "work_hours_only": False}]})
        self.assertTrue(published.narrowed_to(acknowledged).restrictions[0].work_hours_only)

    def test_minimise_only_while_monitoring_and_in_hours_when_the_rule_says_so(self):
        rules = parse_restrictions(RULES)
        minimised = []
        notices = []
        gate = Restrictor()
        hit = gate.enforce(rules, "Steam", "steam.exe", NOW, monitoring=True, paused=False, in_work_hours=True,
                           minimise=lambda: minimised.append("steam") or True, notify=notices.append)
        self.assertEqual(hit.pattern, "steam")
        self.assertEqual(minimised, ["steam"])
        self.assertEqual(notices, ["steam"])
        gate.enforce(rules, "Steam", "steam.exe", NOW, monitoring=True, paused=False, in_work_hours=True,
                     minimise=lambda: minimised.append("again") or True, notify=notices.append)
        self.assertEqual(notices, ["steam"], "the notice is not repeated immediately")
        self.assertIsNone(gate.enforce(rules, "Steam", "steam.exe", NOW, monitoring=True, paused=True,
                                       in_work_hours=True, minimise=lambda: None, notify=notices.append))
        self.assertIsNone(gate.enforce(rules, "uTorrent", "uTorrent.exe", NOW, monitoring=False, paused=False,
                                       in_work_hours=True, minimise=lambda: None, notify=notices.append))
        self.assertIsNone(gate.enforce(rules, "uTorrent", "uTorrent.exe", NOW, monitoring=True, paused=False,
                                       in_work_hours=False, minimise=lambda: None, notify=notices.append))

    def test_working_hours_still_apply_when_monitoring_runs_all_day(self):
        schedule = Schedule(mode="always", work_start=__import__("datetime").time(8, 0),
                            work_end=__import__("datetime").time(17, 0), timezone="Africa/Johannesburg")
        self.assertTrue(schedule.is_work_time(NOW))
        evening = datetime(2026, 10, 14, 18, 0, tzinfo=timezone.utc)  # 20:00 in Johannesburg
        self.assertTrue(schedule.is_work_time(evening))
        self.assertFalse(schedule.during_work_hours(evening))

    def test_a_website_stays_blocked_when_paused_or_outside_working_hours(self):
        rules = parse_restrictions(RULES)
        self.assertEqual(active_domains(rules), ("facebook.com",))
        self.assertFalse(proxy_is_free({"ProxyEnable": 1, "AutoConfigURL": ""}))
        self.assertFalse(proxy_is_free({"ProxyEnable": 0, "AutoConfigURL": "http://proxy.example/pac"}))
        self.assertTrue(proxy_is_free({"ProxyEnable": 0, "AutoConfigURL": ""}))
        hours = parse_restrictions([{"kind": "domain", "pattern": "facebook.com", "work_hours_only": True}])
        self.assertEqual(active_domains(hours), ("facebook.com",))

    def test_the_proxy_refuses_the_named_site_and_lets_another_through(self):
        gate = SiteBlock.__new__(SiteBlock)
        gate._patterns = ("mycroscope-policy-probe.invalid",)
        gate._server = None
        gate._thread = None
        gate._port = 0
        gate._lock = threading.Lock()
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        allowed_port = listener.getsockname()[1]
        seen = []

        def accept_one():
            conn, _addr = listener.accept()
            seen.append(conn.recv(64))
            conn.sendall(b"ok")
            conn.close()

        threading.Thread(target=accept_one, daemon=True).start()
        gate._start_locked()
        try:
            blocked = socket.create_connection(("127.0.0.1", gate._port), 2)
            blocked.sendall(b"CONNECT mycroscope-policy-probe.invalid:443 HTTP/1.1\r\nHost: x\r\n\r\n")
            self.assertTrue(blocked.recv(80).startswith(b"HTTP/1.1 403"))
            blocked.close()
            allowed = socket.create_connection(("127.0.0.1", gate._port), 2)
            allowed.sendall(f"CONNECT 127.0.0.1:{allowed_port} HTTP/1.1\r\nHost: x\r\n\r\n".encode())
            self.assertTrue(allowed.recv(80).startswith(b"HTTP/1.1 200"))
            allowed.sendall(b"ping")
            self.assertEqual(allowed.recv(8), b"ok")
            allowed.close()
        finally:
            gate._server.close()
            gate._server = None
            listener.close()
        self.assertEqual(seen, [b"ping"])


if __name__ == "__main__":
    unittest.main()
