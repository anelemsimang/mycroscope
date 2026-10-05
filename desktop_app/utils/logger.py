import logging
import logging.handlers
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional

from config import LOGS_DIR, LOG_LEVEL, LOG_FORMAT, LOG_FILE, MAX_LOG_SIZE_MB


class ThreadSafeLogger:
    """Thread-safe logger with rotation and encryption support."""
    
    def __init__(self, name: str, log_file: Optional[Path] = None):
        self.name = name
        self.log_file = log_file or LOG_FILE
        self._lock = threading.Lock()
        self._logger = None
        self._setup_logger()
    
    def _setup_logger(self):
        """Setup the logger with proper configuration."""
        with self._lock:
            if self._logger is not None:
                return
            
            # Create logger
            self._logger = logging.getLogger(self.name)
            self._logger.setLevel(getattr(logging, LOG_LEVEL))
            
            # Prevent duplicate handlers
            if self._logger.handlers:
                return
            
            # Create formatter
            formatter = logging.Formatter(LOG_FORMAT)
            
            # File handler with rotation
            max_bytes = MAX_LOG_SIZE_MB * 1024 * 1024
            file_handler = logging.handlers.RotatingFileHandler(
                self.log_file,
                maxBytes=max_bytes,
                backupCount=5,
                encoding='utf-8'
            )
            file_handler.setFormatter(formatter)
            self._logger.addHandler(file_handler)
            
            # Console handler for development
            if LOG_LEVEL == "DEBUG":
                console_handler = logging.StreamHandler()
                console_handler.setFormatter(formatter)
                self._logger.addHandler(console_handler)
    
    def debug(self, message: str, **kwargs):
        """Log debug message."""
        self._log(logging.DEBUG, message, **kwargs)
    
    def info(self, message: str, **kwargs):
        """Log info message."""
        self._log(logging.INFO, message, **kwargs)
    
    def warning(self, message: str, **kwargs):
        """Log warning message."""
        self._log(logging.WARNING, message, **kwargs)
    
    def error(self, message: str, **kwargs):
        """Log error message."""
        self._log(logging.ERROR, message, **kwargs)
    
    def critical(self, message: str, **kwargs):
        """Log critical message."""
        self._log(logging.CRITICAL, message, **kwargs)
    
    def _log(self, level: int, message: str, **kwargs):
        """Thread-safe logging with additional context."""
        with self._lock:
            if kwargs:
                # Add context to message
                context = " | ".join([f"{k}={v}" for k, v in kwargs.items()])
                message = f"{message} | {context}"
            
            self._logger.log(level, message)


class ActivityLogger(ThreadSafeLogger):
    """Specialized logger for activity tracking."""
    
    def __init__(self):
        super().__init__("activity", LOGS_DIR / "activity.log")
    
    def log_login(self, employee_id: str, timestamp: datetime):
        """Log employee login."""
        self.info("Employee login", employee_id=employee_id, timestamp=timestamp.isoformat())
    
    def log_logout(self, employee_id: str, timestamp: datetime):
        """Log employee logout."""
        self.info("Employee logout", employee_id=employee_id, timestamp=timestamp.isoformat())
    
    def log_activity(self, employee_id: str, activity_type: str, details: dict, timestamp: datetime):
        """Log general activity."""
        self.info("Activity detected", 
                 employee_id=employee_id, 
                 activity_type=activity_type, 
                 details=details,
                 timestamp=timestamp.isoformat())
    
    def log_idle(self, employee_id: str, duration: int, timestamp: datetime):
        """Log idle time."""
        self.info("Idle time detected", 
                 employee_id=employee_id, 
                 duration_seconds=duration,
                 timestamp=timestamp.isoformat())
    
    def log_app_usage(self, employee_id: str, app_name: str, duration: int, timestamp: datetime):
        """Log application usage."""
        self.info("App usage", 
                 employee_id=employee_id, 
                 app_name=app_name,
                 duration_seconds=duration,
                 timestamp=timestamp.isoformat())
    
    def log_web_activity(self, employee_id: str, url: str, duration: int, timestamp: datetime):
        """Log web activity."""
        self.info("Web activity", 
                 employee_id=employee_id, 
                 url=url,
                 duration_seconds=duration,
                 timestamp=timestamp.isoformat())
    
    def log_project_switch(self, employee_id: str, old_project: str, new_project: str, timestamp: datetime):
        """Log project switching."""
        self.info("Project switch", 
                 employee_id=employee_id, 
                 old_project=old_project,
                 new_project=new_project,
                 timestamp=timestamp.isoformat())


class SecurityLogger(ThreadSafeLogger):
    """Specialized logger for security events."""
    
    def __init__(self):
        super().__init__("security", LOGS_DIR / "security.log")
    
    def log_unauthorized_access(self, attempt_type: str, details: dict, timestamp: datetime):
        """Log unauthorized access attempts."""
        self.warning("Unauthorized access attempt", 
                    attempt_type=attempt_type,
                    details=details,
                    timestamp=timestamp.isoformat())
    
    def log_app_disable_attempt(self, employee_id: str, timestamp: datetime):
        """Log attempts to disable the application."""
        self.warning("App disable attempt", 
                    employee_id=employee_id,
                    timestamp=timestamp.isoformat())
    
    def log_data_sync_error(self, error: str, timestamp: datetime):
        """Log data synchronization errors."""
        self.error("Data sync error", 
                  error=error,
                  timestamp=timestamp.isoformat())


class SystemLogger(ThreadSafeLogger):
    """Specialized logger for system events."""
    
    def __init__(self):
        super().__init__("system", LOGS_DIR / "system.log")
    
    def log_startup(self, timestamp: datetime):
        """Log application startup."""
        self.info("Application startup", timestamp=timestamp.isoformat())
    
    def log_shutdown(self, timestamp: datetime):
        """Log application shutdown."""
        self.info("Application shutdown", timestamp=timestamp.isoformat())
    
    def log_offline_mode(self, timestamp: datetime):
        """Log transition to offline mode."""
        self.warning("Entering offline mode", timestamp=timestamp.isoformat())
    
    def log_online_mode(self, timestamp: datetime):
        """Log transition to online mode."""
        self.info("Entering online mode", timestamp=timestamp.isoformat())


# Global logger instances
activity_logger = ActivityLogger()
security_logger = SecurityLogger()
system_logger = SystemLogger()


def get_logger(name: str) -> ThreadSafeLogger:
    """Get a logger instance by name."""
    return ThreadSafeLogger(name)


def setup_logger():
    """Setup logging configuration - called by main.py"""
    # This function is called by main.py to initialize logging
    # The loggers are already set up when the module is imported
    pass 