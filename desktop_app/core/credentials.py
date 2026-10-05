"""Stores the refresh token encrypted with Windows DPAPI (current user scope)."""

import json
from pathlib import Path
from typing import Optional

from utils.logger import get_logger

log = get_logger("credentials")

try:
    import win32crypt
except ImportError:  # pragma: no cover
    win32crypt = None

_ENTROPY = b"mycroscope-agent-v2"


class CredentialStore:
    def __init__(self, path: Path):
        self.path = path

    def save(self, refresh_token: str, email: str) -> None:
        if win32crypt is None:
            return
        payload = json.dumps({"refresh_token": refresh_token, "email": email}).encode()
        blob = win32crypt.CryptProtectData(payload, "Mycroscope", _ENTROPY, None, None, 0)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_bytes(blob)
        tmp.replace(self.path)

    def load(self) -> Optional[dict]:
        if win32crypt is None or not self.path.exists():
            return None
        try:
            _, data = win32crypt.CryptUnprotectData(self.path.read_bytes(), _ENTROPY, None, None, 0)
            return json.loads(data.decode())
        except Exception as exc:
            log.warning("Stored session unreadable, ignoring: %s", exc)
            self.clear()
            return None

    def clear(self) -> None:
        try:
            self.path.unlink(missing_ok=True)
        except OSError:
            pass
