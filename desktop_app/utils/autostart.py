"""Per-user scheduled tasks: start at Windows sign-in, and restart after a crash.

* "Mycroscope Agent"          - at logon, runs the agent in the tray.
* "Mycroscope Agent Watchdog" - every 5 minutes; starts the agent only if it is
  not running and did not exit deliberately (see STOP_MARKER).

Both run as the signed-in user with least privilege; no admin rights needed.
"""

import getpass
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape

from config import BASE_DIR, DATA_DIR
from utils.logger import get_logger

log = get_logger("autostart")

LOGON_TASK = "Mycroscope Agent"
WATCHDOG_TASK = "Mycroscope Agent Watchdog"
STOP_MARKER = DATA_DIR / "stopped_by_user"
_NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW


def launch_command() -> tuple[str, str, str]:
    """(program, base arguments, working directory) for the current install."""
    if getattr(sys, "frozen", False):
        return sys.executable, "", str(BASE_DIR)
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    program = str(pythonw if pythonw.exists() else sys.executable)
    return program, f'"{BASE_DIR / "main.py"}"', str(BASE_DIR)


def _user_id() -> str:
    domain = os.environ.get("USERDOMAIN")
    user = getpass.getuser()
    return f"{domain}\\{user}" if domain else user


def _task_xml(trigger_xml: str, arguments: str, description: str) -> str:
    program, base_args, workdir = launch_command()
    args = f"{base_args} {arguments}".strip()
    user = escape(_user_id())
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Mycroscope</Author>
    <Description>{escape(description)}</Description>
  </RegistrationInfo>
  <Triggers>
    {trigger_xml}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{escape(program)}</Command>
      <Arguments>{escape(args)}</Arguments>
      <WorkingDirectory>{escape(workdir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"""


def _schtasks(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["schtasks", *args], capture_output=True, text=True, creationflags=_NO_WINDOW)


def _register(name: str, xml: str) -> None:
    fd, path = tempfile.mkstemp(suffix=".xml")
    os.close(fd)
    try:
        Path(path).write_text(xml, encoding="utf-16")
        result = _schtasks("/Create", "/TN", name, "/XML", path, "/F")
        if result.returncode != 0:
            raise RuntimeError(f"schtasks failed for {name}: {result.stderr.strip() or result.stdout.strip()}")
    finally:
        os.unlink(path)


def install() -> None:
    user = escape(_user_id())
    logon = f"""<LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
      <Delay>PT10S</Delay>
    </LogonTrigger>"""
    start = datetime.now().replace(microsecond=0).isoformat()
    watchdog = f"""<TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>{start}</StartBoundary>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>"""
    _register(LOGON_TASK, _task_xml(logon, "--hidden", "Starts the Mycroscope activity agent when you sign in."))
    _register(WATCHDOG_TASK, _task_xml(watchdog, "--watchdog",
                                       "Restarts the Mycroscope agent if it stopped unexpectedly."))
    log.info("Autostart tasks registered for %s", launch_command()[0])


def uninstall() -> None:
    for name in (LOGON_TASK, WATCHDOG_TASK):
        _schtasks("/Delete", "/TN", name, "/F")
    log.info("Autostart tasks removed")


def is_installed_for_current_program() -> bool:
    result = _schtasks("/Query", "/TN", LOGON_TASK, "/XML")
    if result.returncode != 0:
        return False
    return escape(launch_command()[0]) in result.stdout and \
        _schtasks("/Query", "/TN", WATCHDOG_TASK).returncode == 0


def ensure_installed() -> None:
    try:
        if not is_installed_for_current_program():
            install()
    except Exception as exc:
        log.warning("Could not register autostart: %s", exc)


def mark_stopped_by_user() -> None:
    try:
        STOP_MARKER.write_text(datetime.now().isoformat())
    except OSError:
        pass


def clear_stopped_marker() -> None:
    STOP_MARKER.unlink(missing_ok=True)
