"""Decides whether the PC is on a registered office network.

The desktop app compares the public IP address and the Wi-Fi name with the
offices the company registered. It uploads only the result for the day
(office, remote or mixed, and which office). A home address and a home
network name are never stored. If neither the address nor the Wi-Fi name
can be read, nothing is recorded for that check.
"""

import subprocess
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Optional

import ipaddress


@dataclass(frozen=True)
class OfficeNetwork:
    id: str
    cidrs: tuple[str, ...]
    wifi_names: tuple[str, ...]


def offices_from_settings(settings: Optional[dict[str, Any]]) -> list[OfficeNetwork]:
    raw = (settings or {}).get("office_networks") or []
    offices: list[OfficeNetwork] = []
    if not isinstance(raw, list):
        return offices
    for item in raw:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        cidrs = tuple(str(c) for c in (item.get("cidrs") or []) if c)
        wifi = tuple(str(w) for w in (item.get("wifi_names") or []) if w)
        offices.append(OfficeNetwork(str(item["id"]), cidrs, wifi))
    return offices


def _in_cidr(ip: str, cidr: str) -> bool:
    try:
        return ipaddress.ip_address(ip) in ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return False


def classify(ip: Optional[str], wifi: Optional[str], offices: list[OfficeNetwork]) -> Optional[str]:
    """An office id, '' when the reading is not an office, or None when nothing could be read."""
    wifi_key = (wifi or "").strip().casefold()
    ip_text = (ip or "").strip()
    if not wifi_key and not ip_text:
        return None
    for office in offices:
        if wifi_key and any(wifi_key == name.strip().casefold() for name in office.wifi_names):
            return office.id
    for office in offices:
        if ip_text and any(_in_cidr(ip_text, cidr) for cidr in office.cidrs):
            return office.id
    return ""


def parse_wifi_output(text: str) -> Optional[str]:
    """The SSID line from `netsh wlan show interfaces`. Ignores the BSSID line."""
    for line in (text or "").splitlines():
        key, sep, value = line.partition(":")
        if sep and key.strip().casefold() == "ssid":
            name = value.strip()
            if name and name.casefold() not in ("", "none"):
                return name
    return None


def read_wifi_ssid() -> Optional[str]:
    """The connected Wi-Fi name, or None when it cannot be read (no Wi-Fi, or permission denied)."""
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(
            ["netsh", "wlan", "show", "interfaces"],
            capture_output=True, text=True, timeout=3, creationflags=flags, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    return parse_wifi_output(completed.stdout or "")


class PlaceTracker:
    """Sends a reading only when the day's result changes, and at most every few minutes."""

    def __init__(self, interval_seconds: int = 15 * 60) -> None:
        self.interval_seconds = interval_seconds
        self._last_check: Optional[datetime] = None
        self._sent: dict[date, str] = {}

    def reset(self) -> None:
        self._last_check = None
        self._sent.clear()

    def due(self, now: datetime) -> bool:
        return self._last_check is None or (now - self._last_check).total_seconds() >= self.interval_seconds

    def mark_checked(self, now: datetime) -> None:
        self._last_check = now

    def should_send(self, day: date, office_id: Optional[str]) -> bool:
        """office_id None is a remote reading. Unknown readings are not passed here."""
        key = office_id or ""
        return self._sent.get(day) != key

    def remember(self, day: date, office_id: Optional[str]) -> None:
        self._sent[day] = office_id or ""
        stale = [d for d in self._sent if (day - d).days > 2]
        for d in stale:
            del self._sent[d]
