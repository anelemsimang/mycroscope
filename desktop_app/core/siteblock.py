"""Blocks restricted websites in browsers that use the Windows proxy setting.

Chrome and Edge do that. Mycroscope runs a proxy on this computer only, refuses the
named sites, and lets every other site straight through. It does not read page contents.
If this computer already uses a proxy, Mycroscope leaves that alone and does not block.
"""

import json
import os
import select
import socket
import threading
from typing import Optional

from config import DATA_DIR
from core.restrict import Restriction, matches_domain

MARKER = DATA_DIR / "proxy-before.json"
SETTINGS_KEY = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
BLOCKED = b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
_CHUNK = 65536


def active_domains(rules: tuple[Restriction, ...], *, monitoring: bool, paused: bool, in_work_hours: bool) -> tuple[str, ...]:
    if not monitoring or paused:
        return ()
    found: list[str] = []
    for rule in rules:
        if rule.kind != "domain" or (rule.work_hours_only and not in_work_hours):
            continue
        pattern = rule.pattern.strip().lower()
        if "." not in pattern:
            continue
        found.append(pattern)
    return tuple(dict.fromkeys(found))


def proxy_is_free(current: dict) -> bool:
    """True when Mycroscope may set the proxy. An existing proxy or automatic script is left alone."""
    if str(current.get("AutoConfigURL") or "").strip():
        return False
    try:
        enabled = int(current.get("ProxyEnable") or 0)
    except (TypeError, ValueError):
        enabled = 0
    return enabled != 1


def _blocked(host: str, patterns: tuple[str, ...]) -> bool:
    name = host.lower().split(":")[0].strip("[]")
    return any(matches_domain(pattern, name) for pattern in patterns)


class SiteBlock:
    def __init__(self) -> None:
        self._patterns: tuple[str, ...] = ()
        self._server: Optional[socket.socket] = None
        self._thread: Optional[threading.Thread] = None
        self._port = 0
        self._lock = threading.Lock()
        self.restore()

    def apply(self, rules: tuple[Restriction, ...], *, monitoring: bool, paused: bool, in_work_hours: bool) -> None:
        patterns = active_domains(rules, monitoring=monitoring, paused=paused, in_work_hours=in_work_hours)
        with self._lock:
            if patterns == self._patterns and (not patterns or self._server is not None):
                return
            self._stop_locked()
            self._patterns = patterns
            if not patterns or os.name != "nt":
                return
            current = _read_proxy()
            if not proxy_is_free(current):
                self._patterns = ()
                return
            self._start_locked()
            try:
                _install_proxy(self._port, current)
            except OSError:
                self._stop_locked()
                self._patterns = ()
                raise

    def restore(self) -> None:
        with self._lock:
            self._stop_locked()
            self._patterns = ()
            _restore_proxy()

    def _start_locked(self) -> None:
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("127.0.0.1", 0))
        server.listen(40)
        server.settimeout(1)
        self._server = server
        self._port = server.getsockname()[1]
        self._thread = threading.Thread(target=self._serve, name="mycroscope-site-block", daemon=True)
        self._thread.start()

    def _stop_locked(self) -> None:
        server = self._server
        self._server = None
        if server is not None:
            try:
                server.close()
            except OSError:
                pass
        _restore_proxy()

    def _serve(self) -> None:
        server = self._server
        while server is self._server:
            try:
                conn, _addr = server.accept()
            except OSError:
                continue
            threading.Thread(target=self._client, args=(conn,), daemon=True).start()

    def _client(self, conn: socket.socket) -> None:
        try:
            conn.settimeout(15)
            data = b""
            while b"\r\n\r\n" not in data and len(data) < _CHUNK:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                data += chunk
            line = data.split(b"\r\n", 1)[0].decode("latin1", "replace")
            parts = line.split(" ")
            if len(parts) < 2:
                return
            method, target = parts[0].upper(), parts[1]
            if method == "CONNECT":
                host, _, port_text = target.partition(":")
                port = int(port_text or "443")
                if _blocked(host, self._patterns):
                    conn.sendall(BLOCKED)
                    return
                remote = socket.create_connection((host, port), 15)
                try:
                    conn.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    _splice(conn, remote)
                finally:
                    remote.close()
                return
            host = _http_host(target, data)
            if host and _blocked(host[0], self._patterns):
                conn.sendall(BLOCKED)
                return
            if host:
                remote = socket.create_connection((host[0], host[1]), 15)
                try:
                    remote.sendall(data)
                    _splice(conn, remote)
                finally:
                    remote.close()
        except (OSError, ValueError):
            return
        finally:
            try:
                conn.close()
            except OSError:
                pass


def _http_host(target: str, data: bytes) -> Optional[tuple[str, int]]:
    if target.startswith("http://"):
        rest = target[7:]
        host_port, _, _path = rest.partition("/")
        host, _, port_text = host_port.partition(":")
        return host, int(port_text or "80")
    for header in data.split(b"\r\n"):
        if header.lower().startswith(b"host:"):
            value = header.split(b":", 1)[1].strip().decode("latin1", "replace")
            host, _, port_text = value.partition(":")
            return host, int(port_text or "80")
    return None


def _splice(conn: socket.socket, remote: socket.socket) -> None:
    sockets = [conn, remote]
    while True:
        ready, _, _ = select.select(sockets, [], [], 30)
        if not ready:
            return
        for sock in ready:
            chunk = sock.recv(_CHUNK)
            if not chunk:
                return
            (remote if sock is conn else conn).sendall(chunk)


def _open_key(write: bool):
    import winreg
    access = winreg.KEY_SET_VALUE | winreg.KEY_QUERY_VALUE if write else winreg.KEY_QUERY_VALUE
    return winreg.OpenKey(winreg.HKEY_CURRENT_USER, SETTINGS_KEY, 0, access)


def _read_value(key, name: str):
    import winreg
    try:
        value, _kind = winreg.QueryValueEx(key, name)
        return value
    except FileNotFoundError:
        return None


def _read_proxy() -> dict:
    if os.name != "nt":
        return {}
    key = _open_key(False)
    try:
        return {
            "ProxyEnable": _read_value(key, "ProxyEnable"),
            "ProxyServer": _read_value(key, "ProxyServer"),
            "ProxyOverride": _read_value(key, "ProxyOverride"),
            "AutoConfigURL": _read_value(key, "AutoConfigURL"),
        }
    finally:
        key.Close()


def _notify_windows() -> None:
    try:
        wininet = __import__("ctypes").windll.Wininet
        wininet.InternetSetOptionW(None, 39, None, 0)
        wininet.InternetSetOptionW(None, 37, None, 0)
    except (AttributeError, OSError):
        pass


def _install_proxy(port: int, previous: dict) -> None:
    import winreg
    if not MARKER.exists():
        MARKER.write_text(json.dumps({
            "ProxyEnable": previous.get("ProxyEnable"),
            "ProxyServer": previous.get("ProxyServer"),
            "ProxyOverride": previous.get("ProxyOverride"),
        }), encoding="utf-8")
    override = "localhost;127.0.0.1;<local>"
    key = _open_key(True)
    try:
        winreg.SetValueEx(key, "ProxyEnable", 0, winreg.REG_DWORD, 1)
        winreg.SetValueEx(key, "ProxyServer", 0, winreg.REG_SZ, f"127.0.0.1:{port}")
        winreg.SetValueEx(key, "ProxyOverride", 0, winreg.REG_SZ, override)
    finally:
        key.Close()
    _notify_windows()


def _restore_proxy() -> None:
    if os.name != "nt" or not MARKER.exists():
        return
    import winreg
    try:
        saved = json.loads(MARKER.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        saved = {}
    key = _open_key(True)
    try:
        enable = saved.get("ProxyEnable")
        winreg.SetValueEx(key, "ProxyEnable", 0, winreg.REG_DWORD, int(enable or 0))
        if saved.get("ProxyServer"):
            winreg.SetValueEx(key, "ProxyServer", 0, winreg.REG_SZ, str(saved["ProxyServer"]))
        else:
            _delete(key, "ProxyServer")
        if saved.get("ProxyOverride"):
            winreg.SetValueEx(key, "ProxyOverride", 0, winreg.REG_SZ, str(saved["ProxyOverride"]))
        else:
            _delete(key, "ProxyOverride")
    finally:
        key.Close()
    MARKER.unlink(missing_ok=True)
    _notify_windows()


def _delete(key, name: str) -> None:
    import winreg
    try:
        winreg.DeleteValue(key, name)
    except FileNotFoundError:
        pass
