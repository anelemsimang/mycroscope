"""File activity, recorded only when the organisation switches it on and the notice says so.

Records that a USB drive, external disk or phone was connected, and the names and sizes of files
copied onto removable drives, into cloud sync folders (OneDrive, Dropbox, Google Drive) and onto
network drives. File contents are never read: sizes come from directory metadata.

Limits, by design of this cheap approach:
  * files copied to a phone cannot be seen (phones do not appear as drives), only that one connected;
  * uploads through a web browser are not seen here (the website alert rules cover the sites);
  * on network drives only files owned by the signed-in Windows user are recorded, so colleagues'
    changes on a shared drive are never attributed to this person.
"""

import json
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable, Optional

from utils.logger import get_logger

log = get_logger("files")

FILE_ACTION_ADDED = 1
FILE_ACTION_REMOVED = 2
FILE_ACTION_MODIFIED = 3
FILE_ACTION_RENAMED_OLD = 4
FILE_ACTION_RENAMED_NEW = 5

POLL_SECONDS = 5
QUIET_SECONDS = 5                  # a file counts once nothing has changed it for this long (copy finished)
REPEAT_HOURS = 12                  # the same file, or the same drive connected again, is not recorded twice
RATE_WINDOW_SECONDS = 600
MAX_FILES_PER_WINDOW = 100         # beyond this, one summary row per destination per window
MAX_PENDING = 20000

NOISE_NAMES = {"desktop.ini", "thumbs.db", ".ds_store", ".dropbox", ".dropbox.attr", "icon\r", "autorun.inf"}
NOISE_SUFFIXES = (".tmp", ".temp", ".partial", ".crdownload", ".part", ".download", ".lock", ".swp", ".lnk",
                  ".~tmp", ".laccdb", ".ldb")
NOISE_DIRS = {"$recycle.bin", "system volume information", ".dropbox.cache", ".tmp.drivedownload",
              ".tmp.driveupload", ".git", "node_modules", "__pycache__", ".spotlight-v100", ".fseventsd",
              ".trashes", "found.000"}


@dataclass(frozen=True)
class FileSettings:
    removable: bool = False
    cloud: bool = False
    network: bool = False

    @property
    def any(self) -> bool:
        return self.removable or self.cloud or self.network


@dataclass(frozen=True)
class Target:
    """A folder being watched: a removable drive root, a cloud sync folder or a network drive."""
    root: str
    destination: str  # removable | cloud | network
    label: str


@dataclass(frozen=True)
class Drive:
    root: str
    kind: str          # removable | network | cloud
    label: str
    identity: str      # stable per volume, for "already reported" checks


def is_noise(rel_path: str) -> bool:
    parts = [p for p in rel_path.replace("/", "\\").split("\\") if p]
    if not parts:
        return True
    name = parts[-1].lower()
    if name in NOISE_NAMES or name.endswith(NOISE_SUFFIXES):
        return True
    if name.startswith("~") or name.startswith(".~") or name.startswith("._"):
        return True
    return any(p.lower() in NOISE_DIRS or p.lower().startswith(".trash-") for p in parts[:-1])


@dataclass
class _Window:
    started: datetime
    count: int = 0
    overflow_files: int = 0
    overflow_bytes: int = 0


class CopyTracker:
    """Turns raw change notifications into one record per new file, once the copy has finished.

    inspect(path, destination) returns the file's size, or None when it should not be recorded
    (gone, a folder, hidden or temporary, a cloud placeholder, or owned by someone else).
    """

    def __init__(self, inspect: Callable[[str, str], Optional[int]], emit: Callable[[dict[str, Any]], None]):
        self.inspect = inspect
        self.emit = emit
        self._lock = threading.Lock()
        self._pending: dict[tuple[Target, str], tuple[datetime, datetime]] = {}  # first seen, last change
        self._recent: dict[str, datetime] = {}
        self._windows: dict[tuple[str, str], _Window] = {}

    def changed(self, target: Target, action: int, rel_path: str, now: datetime) -> None:
        if is_noise(rel_path):
            return
        key = (target, rel_path)
        with self._lock:
            if action in (FILE_ACTION_ADDED, FILE_ACTION_RENAMED_NEW):
                if len(self._pending) < MAX_PENDING:
                    first = self._pending.get(key, (now, now))[0]
                    self._pending[key] = (first, now)
            elif action == FILE_ACTION_MODIFIED:
                if key in self._pending:
                    self._pending[key] = (self._pending[key][0], now)
            elif action in (FILE_ACTION_REMOVED, FILE_ACTION_RENAMED_OLD):
                self._pending.pop(key, None)

    def flush(self, now: datetime, force: bool = False) -> None:
        with self._lock:
            ready = [(k, v) for k, v in self._pending.items()
                     if force or (now - v[1]).total_seconds() >= QUIET_SECONDS]
            for k, _ in ready:
                del self._pending[k]
        for (target, rel), (first, _) in ready:
            path = os.path.join(target.root, rel)
            recent_key = f"{target.destination}|{path.lower()}"
            seen = self._recent.get(recent_key)
            if seen and now - seen < timedelta(hours=REPEAT_HOURS):
                continue
            try:
                size = self.inspect(path, target.destination)
            except Exception as exc:  # never let one odd file stop the monitor
                log.debug("Could not inspect %s: %s", path, exc)
                size = None
            if size is None:
                continue
            self._recent[recent_key] = now
            self._record(target, os.path.basename(rel)[:260], size, first, now)
        self._close_windows(now, force)
        if len(self._recent) > 50000:
            cutoff = now - timedelta(hours=REPEAT_HOURS)
            self._recent = {k: v for k, v in self._recent.items() if v >= cutoff}

    def _record(self, target: Target, name: str, size: int, at: datetime, now: datetime) -> None:
        key = (target.destination, target.label)
        w = self._windows.get(key)
        if w is None or (now - w.started).total_seconds() >= RATE_WINDOW_SECONDS:
            if w is not None:
                self._emit_overflow(key, w)
            w = self._windows[key] = _Window(started=now)
        w.count += 1
        if w.count <= MAX_FILES_PER_WINDOW:
            self.emit({"event_type": "file_copied", "destination": target.destination, "label": target.label,
                       "file_name": name, "file_count": 1, "size_bytes": size, "occurred_at": at})
        else:
            w.overflow_files += 1
            w.overflow_bytes += size

    def _close_windows(self, now: datetime, force: bool) -> None:
        for key, w in list(self._windows.items()):
            if force or (now - w.started).total_seconds() >= RATE_WINDOW_SECONDS:
                self._emit_overflow(key, w)
                del self._windows[key]

    def _emit_overflow(self, key: tuple[str, str], w: _Window) -> None:
        if w.overflow_files:
            self.emit({"event_type": "file_copied", "destination": key[0], "label": key[1], "file_name": None,
                       "file_count": w.overflow_files, "size_bytes": w.overflow_bytes, "occurred_at": w.started})
            w.overflow_files = w.overflow_bytes = 0


class FileActivityMonitor:
    """Watches drives and folders on a background thread while recording is allowed."""

    def __init__(self, emit: Callable[[dict[str, Any]], None], kv_get: Callable[[str], Optional[str]],
                 kv_set: Callable[[str, Optional[str]], None], clock: Callable[[], datetime],
                 platform: Optional["Platform"] = None):
        self.emit = emit
        self.kv_get = kv_get
        self.kv_set = kv_set
        self.clock = clock
        self.platform = platform or WindowsPlatform()
        self.tracker = CopyTracker(self.platform.inspect, emit)
        self._settings = FileSettings()
        self._active = False
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._watchers: dict[Target, threading.Event] = {}
        self._drives: Optional[dict[str, Drive]] = None
        self._phones: Optional[dict[str, str]] = None

    # ---- control (cheap; called every second by the tracker) --------------
    def configure(self, settings: FileSettings, active: bool) -> None:
        active = active and settings.any
        if settings != self._settings or active != self._active:
            self._settings, self._active = settings, active
            self._wake.set()
            if active and self._thread is None:
                self._stop.clear()
                self._thread = threading.Thread(target=self._run, name="files", daemon=True)
                self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(5)
        self._thread = None
        self._stop_watchers(set())
        self.tracker.flush(self.clock(), force=True)

    # ---- loop ------------------------------------------------------------
    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.poll()
            except Exception:
                log.exception("File activity check failed")
            self._wake.wait(POLL_SECONDS)
            self._wake.clear()

    def poll(self) -> None:
        now = self.clock()
        s = self._settings
        if not self._active:
            self._stop_watchers(set())
            self.tracker.flush(now, force=True)
            self._drives = self._phones = None
            return

        targets: set[Target] = set()
        drives = self.platform.drives() if (s.removable or s.network or s.cloud) else {}
        if s.removable:
            removable = {k: d for k, d in drives.items() if d.kind == "removable"}
            for key, d in removable.items():
                if self._drives is None or key not in self._drives:
                    self._report_connection("drive_connected", "removable", d.label, d.identity, now,
                                            first_poll=self._drives is None)
                targets.add(Target(d.root, "removable", d.label))
            self._drives = removable
            phones = self.platform.phones()
            for identity, name in phones.items():
                if self._phones is None or identity not in self._phones:
                    self._report_connection("phone_connected", "phone", name, identity, now,
                                            first_poll=self._phones is None)
            self._phones = phones
        else:
            self._drives = self._phones = None
        if s.network:
            targets |= {Target(d.root, "network", d.label) for d in drives.values() if d.kind == "network"}
        if s.cloud:
            targets |= {Target(d.root, "cloud", d.label) for d in drives.values() if d.kind == "cloud"}
            targets |= {Target(path, "cloud", label) for path, label in self.platform.cloud_folders()}

        self._stop_watchers(targets)
        for t in targets - set(self._watchers):
            stop = threading.Event()
            self._watchers[t] = stop
            self.platform.watch(t.root, lambda action, rel, t=t: self.tracker.changed(t, action, rel, self.clock()), stop)
        self.tracker.flush(now)

    def _report_connection(self, event_type: str, destination: str, label: str, identity: str, now: datetime,
                           first_poll: bool) -> None:
        """A device already plugged in when monitoring starts is reported once per REPEAT_HOURS, not on every sign-in."""
        key = f"files:connected:{identity}"
        if first_poll:
            last = self.kv_get(key)
            try:
                if last and now - datetime.fromisoformat(last) < timedelta(hours=REPEAT_HOURS):
                    return
            except ValueError:
                pass
        self.kv_set(key, now.isoformat())
        self.emit({"event_type": event_type, "destination": destination, "label": label[:200],
                   "file_name": None, "file_count": 1, "size_bytes": None, "occurred_at": now})

    def _stop_watchers(self, keep: set[Target]) -> None:
        for t in list(self._watchers):
            if t not in keep:
                self._watchers.pop(t).set()


class Platform:
    """What the monitor needs from the operating system (replaced by a fake in tests)."""

    def drives(self) -> dict[str, Drive]:
        return {}

    def phones(self) -> dict[str, str]:
        return {}

    def cloud_folders(self) -> list[tuple[str, str]]:
        return []

    def watch(self, root: str, on_change: Callable[[int, str], None], stop: threading.Event) -> None:
        pass

    def inspect(self, path: str, destination: str) -> Optional[int]:
        return None


# ---- Windows -----------------------------------------------------------------
FILE_ATTRIBUTE_HIDDEN = 0x2
FILE_ATTRIBUTE_SYSTEM = 0x4
FILE_ATTRIBUTE_DIRECTORY = 0x10
FILE_ATTRIBUTE_TEMPORARY = 0x100
FILE_ATTRIBUTE_OFFLINE = 0x1000
FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x40000
FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x400000
CLOUD_PLACEHOLDER = FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS

DRIVE_REMOVABLE, DRIVE_FIXED, DRIVE_REMOTE = 2, 3, 4
IOCTL_STORAGE_QUERY_PROPERTY = 0x2D1400
EXTERNAL_BUS_TYPES = {7, 12, 13}  # USB, SD, MMC
WPD_CLASS_GUID = "{EEC5AD98-8080-425F-922A-DABF3DE3F69A}"


class WindowsPlatform(Platform):
    def __init__(self) -> None:
        self._bus_cache: dict[str, Optional[int]] = {}
        self._my_sid = None

    # ---- drives ------------------------------------------------------------
    def drives(self) -> dict[str, Drive]:
        import win32api
        import win32file
        system = (os.environ.get("SystemDrive") or "C:").upper().rstrip("\\") + "\\"
        out: dict[str, Drive] = {}
        for root in [r for r in win32api.GetLogicalDriveStrings().split("\x00") if r]:
            root = root.upper()
            if root == system:
                continue
            kind = win32file.GetDriveType(root)
            letter = root[:2]
            if kind == DRIVE_REMOTE:
                out[root] = Drive(root, "network", self._unc(letter) or letter, f"net:{letter}")
                continue
            if kind not in (DRIVE_REMOVABLE, DRIVE_FIXED):
                continue
            try:
                label, serial = win32api.GetVolumeInformation(root)[:2]
            except Exception:
                continue  # card reader without a card, locked BitLocker drive
            identity = f"vol:{serial & 0xFFFFFFFF:08X}"
            if kind == DRIVE_FIXED and (label or "").strip().lower() == "google drive":
                out[root] = Drive(root, "cloud", "Google Drive", identity)
            elif kind == DRIVE_REMOVABLE or self._bus_type(letter, identity) in EXTERNAL_BUS_TYPES:
                name = (label or "").strip() or "USB drive"
                out[root] = Drive(root, "removable", f"{name} ({letter})", identity)
        return out

    @staticmethod
    def _unc(letter: str) -> Optional[str]:
        try:
            import win32wnet
            return win32wnet.WNetGetConnection(letter)
        except Exception:
            return None

    def _bus_type(self, letter: str, identity: str) -> Optional[int]:
        if identity in self._bus_cache:
            return self._bus_cache[identity]
        bus = None
        try:
            import struct
            import win32file
            handle = win32file.CreateFile(f"\\\\.\\{letter}", 0, win32file.FILE_SHARE_READ | win32file.FILE_SHARE_WRITE,
                                          None, win32file.OPEN_EXISTING, 0, None)
            try:
                query = struct.pack("<IIB3x", 0, 0, 0)  # StorageDeviceProperty, PropertyStandardQuery
                out = win32file.DeviceIoControl(handle, IOCTL_STORAGE_QUERY_PROPERTY, query, 1024)
                if len(out) >= 32:
                    bus = struct.unpack_from("<I", out, 28)[0]
            finally:
                handle.Close()
        except Exception as exc:
            log.debug("Bus type of %s unknown: %s", letter, exc)
        self._bus_cache[identity] = bus
        return bus

    # ---- phones (Android file transfer, iPhone photos) ----------------------
    def phones(self) -> dict[str, str]:
        import ctypes
        from ctypes import wintypes

        class GUID(ctypes.Structure):
            _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD), ("Data3", wintypes.WORD),
                        ("Data4", ctypes.c_ubyte * 8)]

        class SP_DEVINFO_DATA(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.DWORD), ("ClassGuid", GUID), ("DevInst", wintypes.DWORD),
                        ("Reserved", ctypes.c_void_p)]

        setupapi = ctypes.WinDLL("setupapi", use_last_error=True)
        ole32 = ctypes.WinDLL("ole32")
        setupapi.SetupDiGetClassDevsW.restype = ctypes.c_void_p
        setupapi.SetupDiGetClassDevsW.argtypes = [ctypes.POINTER(GUID), wintypes.LPCWSTR, wintypes.HWND, wintypes.DWORD]
        setupapi.SetupDiEnumDeviceInfo.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(SP_DEVINFO_DATA)]
        setupapi.SetupDiGetDeviceInstanceIdW.argtypes = [ctypes.c_void_p, ctypes.POINTER(SP_DEVINFO_DATA),
                                                         wintypes.LPWSTR, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        setupapi.SetupDiGetDeviceRegistryPropertyW.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(SP_DEVINFO_DATA), wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
            ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        setupapi.SetupDiDestroyDeviceInfoList.argtypes = [ctypes.c_void_p]

        guid = GUID()
        ole32.CLSIDFromString(WPD_CLASS_GUID, ctypes.byref(guid))
        handle = setupapi.SetupDiGetClassDevsW(ctypes.byref(guid), None, None, 0x2)  # DIGCF_PRESENT
        if not handle or handle == ctypes.c_void_p(-1).value:
            return {}
        found: dict[str, str] = {}
        try:
            i = 0
            while True:
                data = SP_DEVINFO_DATA()
                data.cbSize = ctypes.sizeof(SP_DEVINFO_DATA)
                if not setupapi.SetupDiEnumDeviceInfo(handle, i, ctypes.byref(data)):
                    break
                i += 1
                buf = ctypes.create_unicode_buffer(512)
                if not setupapi.SetupDiGetDeviceInstanceIdW(handle, ctypes.byref(data), buf, 512, None):
                    continue
                instance = buf.value
                # Drives also appear in this class (SWD\WPDBUSENUM...); phones and cameras are USB devices.
                if not instance.upper().startswith("USB\\"):
                    continue
                name = ""
                for prop in (0x0C, 0x00):  # SPDRP_FRIENDLYNAME, SPDRP_DEVICEDESC
                    nb = ctypes.create_unicode_buffer(256)
                    if setupapi.SetupDiGetDeviceRegistryPropertyW(handle, ctypes.byref(data), prop, None,
                                                                  nb, ctypes.sizeof(nb), None):
                        name = nb.value.strip()
                        if name:
                            break
                found[instance] = name or "Phone or camera"
        finally:
            setupapi.SetupDiDestroyDeviceInfoList(handle)
        return found

    # ---- cloud sync folders --------------------------------------------------
    def cloud_folders(self) -> list[tuple[str, str]]:
        found: list[tuple[str, str]] = []
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\OneDrive\Accounts") as accounts:
                i = 0
                while True:
                    try:
                        name = winreg.EnumKey(accounts, i)
                    except OSError:
                        break
                    i += 1
                    try:
                        with winreg.OpenKey(accounts, name) as k:
                            folder = winreg.QueryValueEx(k, "UserFolder")[0]
                        found.append((folder, "OneDrive (personal)" if name.lower() == "personal" else "OneDrive (work)"))
                    except OSError:
                        pass
        except OSError:
            pass
        for var, label in (("OneDriveCommercial", "OneDrive (work)"), ("OneDriveConsumer", "OneDrive (personal)"),
                           ("OneDrive", "OneDrive")):
            if os.environ.get(var):
                found.append((os.environ[var], label))
        for base in (os.environ.get("APPDATA"), os.environ.get("LOCALAPPDATA")):
            if not base:
                continue
            try:
                with open(os.path.join(base, "Dropbox", "info.json"), encoding="utf-8") as fh:
                    info = json.load(fh)
                for key, label in (("personal", "Dropbox (personal)"), ("business", "Dropbox (work)")):
                    if isinstance(info.get(key), dict) and info[key].get("path"):
                        found.append((info[key]["path"], label))
            except (OSError, ValueError):
                pass
        profile = os.environ.get("USERPROFILE")
        if profile:
            found.append((os.path.join(profile, "My Drive"), "Google Drive"))
        return unique_folders(found)

    # ---- watching ------------------------------------------------------------
    def watch(self, root: str, on_change: Callable[[int, str], None], stop: threading.Event) -> None:
        threading.Thread(target=self._watch, args=(root, on_change, stop), name=f"watch {root}", daemon=True).start()

    @staticmethod
    def _watch(root: str, on_change: Callable[[int, str], None], stop: threading.Event) -> None:
        import pywintypes
        import win32con
        import win32event
        import win32file
        try:
            handle = win32file.CreateFile(
                root, 0x0001,  # FILE_LIST_DIRECTORY
                win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE | win32con.FILE_SHARE_DELETE, None,
                win32con.OPEN_EXISTING, win32con.FILE_FLAG_BACKUP_SEMANTICS | win32con.FILE_FLAG_OVERLAPPED, None)
        except pywintypes.error as exc:
            log.info("Cannot watch %s: %s", root, exc.strerror)
            return
        overlapped = pywintypes.OVERLAPPED()
        overlapped.hEvent = win32event.CreateEvent(None, True, False, None)
        buf = win32file.AllocateReadBuffer(65536)  # the limit for network shares
        flags = (win32con.FILE_NOTIFY_CHANGE_FILE_NAME | win32con.FILE_NOTIFY_CHANGE_SIZE
                 | win32con.FILE_NOTIFY_CHANGE_LAST_WRITE)
        log.info("Watching %s", root)
        try:
            while not stop.is_set():
                win32event.ResetEvent(overlapped.hEvent)
                win32file.ReadDirectoryChangesW(handle, buf, True, flags, overlapped)
                while win32event.WaitForSingleObject(overlapped.hEvent, 1000) != win32event.WAIT_OBJECT_0:
                    if stop.is_set():
                        win32file.CancelIo(handle)
                        try:
                            win32file.GetOverlappedResult(handle, overlapped, True)
                        except pywintypes.error:
                            pass
                        return
                size = win32file.GetOverlappedResult(handle, overlapped, True)
                if not size:
                    continue  # too many changes at once for the buffer; they are lost
                for action, rel in win32file.FILE_NOTIFY_INFORMATION(buf, size):
                    on_change(action, rel)
        except pywintypes.error as exc:
            log.info("Stopped watching %s: %s", root, exc.strerror)  # e.g. the drive was removed
        except Exception:
            log.exception("Watcher for %s failed", root)
        finally:
            handle.Close()
            log.info("No longer watching %s", root)

    # ---- file details (metadata only) --------------------------------------------
    def inspect(self, path: str, destination: str) -> Optional[int]:
        import win32file
        try:
            attrs, _, _, _, size = win32file.GetFileAttributesEx(path)
        except Exception:
            return None
        if attrs & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_TEMPORARY):
            return None
        if destination == "cloud" and attrs & CLOUD_PLACEHOLDER:
            return None  # only a placeholder for a file that lives in the cloud (synced down, not added here)
        if destination == "network" and not self._owned_by_me(path):
            return None
        return int(size)

    def _owned_by_me(self, path: str) -> bool:
        try:
            import win32api
            import win32security
            if self._my_sid is None:
                token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32security.TOKEN_QUERY)
                self._my_sid = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
            sd = win32security.GetFileSecurity(path, win32security.OWNER_SECURITY_INFORMATION)
            return sd.GetSecurityDescriptorOwner() == self._my_sid
        except Exception:
            return False


def unique_folders(folders: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Existing folders, without duplicates or folders inside another one in the list."""
    norm: dict[str, tuple[str, str]] = {}
    for path, label in folders:
        if not path or not os.path.isdir(path):
            continue
        key = os.path.normcase(os.path.abspath(path)).rstrip("\\/")
        norm.setdefault(key, (path, label))
    keys = sorted(norm, key=len)
    kept: list[str] = []
    for k in keys:
        if not any(k == p or k.startswith(p + os.sep) for p in kept):
            kept.append(k)
    return [norm[k] for k in kept]
