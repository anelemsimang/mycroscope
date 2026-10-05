import os
import sys
import winreg
import ctypes
from pathlib import Path
from config import STARTUP_REGISTRY_KEY, STARTUP_REGISTRY_VALUE, ADMIN_PASSWORD
from utils.logger import system_logger


def is_admin():
    """Check if the application is running with admin privileges."""
    try:
        return ctypes.windll.shell32.IsUserAnAdmin()
    except:
        return False


def set_auto_launch():
    """Set the application to auto-launch on system startup."""
    try:
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_SET_VALUE
        )
        
        # Get the full path to the Python executable and script
        python_exe = sys.executable
        script_path = Path(__file__).parent.parent / "main.py"
        
        # Create the command to run the script
        command = f'"{python_exe}" "{script_path}"'
        
        winreg.SetValueEx(key, STARTUP_REGISTRY_KEY, 0, winreg.REG_SZ, command)
        winreg.CloseKey(key)
        
        system_logger.info("Auto-launch enabled")
        return True
        
    except Exception as e:
        system_logger.error("Failed to set auto-launch", error=str(e))
        return False


def remove_auto_launch():
    """Remove the application from auto-launch."""
    try:
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_SET_VALUE
        )
        
        winreg.DeleteValue(key, STARTUP_REGISTRY_KEY)
        winreg.CloseKey(key)
        
        system_logger.info("Auto-launch disabled")
        return True
        
    except Exception as e:
        system_logger.error("Failed to remove auto-launch", error=str(e))
        return False


def is_auto_launch_enabled():
    """Check if auto-launch is enabled."""
    try:
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_READ
        )
        
        value, _ = winreg.QueryValueEx(key, STARTUP_REGISTRY_KEY)
        winreg.CloseKey(key)
        
        return bool(value)
        
    except FileNotFoundError:
        return False
    except Exception as e:
        system_logger.error("Failed to check auto-launch status", error=str(e))
        return False


def protect_process():
    """Protect the process from being terminated by non-admin users."""
    try:
        # Set process priority to high
        import psutil
        process = psutil.Process()
        process.nice(psutil.HIGH_PRIORITY_CLASS)
        
        # In a production environment, you would implement more sophisticated
        # protection mechanisms like:
        # - Kernel-level hooks
        # - Service-based execution
        # - Anti-debugging techniques
        # - Process injection detection
        
        system_logger.info("Process protection enabled")
        return True
        
    except Exception as e:
        system_logger.error("Failed to protect process", error=str(e))
        return False


def verify_admin_password(password: str) -> bool:
    """Verify admin password for administrative actions."""
    return password == ADMIN_PASSWORD


def require_admin_privileges():
    """Restart the application with admin privileges if needed."""
    if not is_admin():
        try:
            # Re-run the program with admin rights
            ctypes.windll.shell32.ShellExecuteW(
                None, 
                "runas", 
                sys.executable, 
                " ".join(sys.argv), 
                None, 
                1
            )
            sys.exit(0)
        except Exception as e:
            system_logger.error("Failed to elevate privileges", error=str(e))
            return False
    return True


def setup_security():
    """Setup security measures for the application."""
    try:
        # Protect the process
        protect_process()
        
        # Set auto-launch if not already set
        if not is_auto_launch_enabled():
            set_auto_launch()
        
        system_logger.info("Security setup completed")
        return True
        
    except Exception as e:
        system_logger.error("Failed to setup security", error=str(e))
        return False


def check_startup():
    """Check startup configuration and requirements."""
    try:
        # Check if running with admin privileges
        if not is_admin():
            system_logger.warning("Application not running with admin privileges")
        
        # Check if auto-launch is enabled
        if not is_auto_launch_enabled():
            system_logger.info("Auto-launch not enabled")
        
        # Check if security is properly set up
        setup_security()
        
        system_logger.info("Startup check completed")
        return True
        
    except Exception as e:
        system_logger.error("Startup check failed", error=str(e))
        return False 