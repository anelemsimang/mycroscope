import unittest
from datetime import datetime, timedelta, timezone

from core.location import OfficeNetwork, PlaceTracker, classify, offices_from_settings, parse_wifi_output


OFFICE = OfficeNetwork("office-1", ("41.13.0.0/24",), ("HQ Wi-Fi",))
OTHER = OfficeNetwork("office-2", ("197.1.2.3/32",), ("Branch",))


class ClassifyTests(unittest.TestCase):
    def test_wifi_match_ignores_case_and_beats_a_different_address(self):
        self.assertEqual(classify("8.8.8.8", "hq wi-fi", [OFFICE, OTHER]), "office-1")

    def test_public_address_in_the_office_range(self):
        self.assertEqual(classify("41.13.0.20", None, [OFFICE]), "office-1")

    def test_a_reading_that_matches_nothing_is_remote(self):
        self.assertEqual(classify("8.8.8.8", "Home", [OFFICE]), "")

    def test_nothing_read_records_nothing(self):
        self.assertIsNone(classify(None, "  ", [OFFICE]))
        self.assertIsNone(classify("", None, [OFFICE]))

    def test_a_bad_range_is_skipped(self):
        broken = OfficeNetwork("x", ("not-a-cidr",), ())
        self.assertEqual(classify("8.8.8.8", None, [broken]), "")

    def test_settings_shape(self):
        offices = offices_from_settings({"office_networks": [
            {"id": "a", "cidrs": ["1.2.3.0/24"], "wifi_names": ["A"]},
            {"cidrs": []},
            "nope",
        ]})
        self.assertEqual(len(offices), 1)
        self.assertEqual(offices[0].id, "a")
        self.assertEqual(offices_from_settings({}), [])
        self.assertEqual(offices_from_settings({"office_networks": "nope"}), [])


class WifiParseTests(unittest.TestCase):
    def test_ssid_line_is_not_confused_with_bssid(self):
        text = "    SSID                   : OfficeWiFi\n    BSSID                  : aa:bb:cc:dd:ee:ff\n"
        self.assertEqual(parse_wifi_output(text), "OfficeWiFi")

    def test_missing_or_blank(self):
        self.assertIsNone(parse_wifi_output("    State : disconnected\n"))
        self.assertIsNone(parse_wifi_output("    SSID                   : \n"))
        self.assertIsNone(parse_wifi_output(""))


class TrackerTests(unittest.TestCase):
    def test_a_changed_result_is_sent_and_a_repeat_is_not(self):
        now = datetime(2026, 10, 14, 8, 0, tzinfo=timezone.utc)
        tracker = PlaceTracker(interval_seconds=900)
        self.assertTrue(tracker.due(now))
        tracker.mark_checked(now)
        self.assertFalse(tracker.due(now + timedelta(minutes=10)))
        self.assertTrue(tracker.due(now + timedelta(minutes=15)))
        day = now.date()
        self.assertTrue(tracker.should_send(day, None))
        tracker.remember(day, None)
        self.assertFalse(tracker.should_send(day, None))
        self.assertTrue(tracker.should_send(day, "office-1"))
        tracker.reset()
        self.assertTrue(tracker.due(now))
        self.assertTrue(tracker.should_send(day, None))


if __name__ == "__main__":
    unittest.main()
