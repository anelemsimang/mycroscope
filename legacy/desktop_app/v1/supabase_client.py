import json
import threading
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any
from supabase import create_client, Client
import requests
import os
import hashlib
import logging

from config import SUPABASE_URL, SUPABASE_KEY
from utils.logger import activity_logger, security_logger

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class SupabaseClient:
    def __init__(self):
        if not SUPABASE_URL or not SUPABASE_KEY:
            raise RuntimeError(
                "Missing Supabase configuration. Set SUPABASE_URL and SUPABASE_KEY in desktop_app/.env "
                "(copy from .env.example). Create the database from supabase/migrations/ in your Supabase project."
            )
        self.supabase_url = SUPABASE_URL
        self.supabase_key = SUPABASE_KEY
        self.client: Client = create_client(self.supabase_url, self.supabase_key)
        self.current_employee = None
        self.current_session = None

    def authenticate_employee(self, email_or_employee_id: str, password: str) -> Optional[Dict[str, Any]]:
        """Authenticate employee using email or employee_id"""
        try:
            logger.info(f"Attempting authentication for: {email_or_employee_id}")
            
            # Try email first
            response = self.client.table('employees').select('*').eq('email', email_or_employee_id).execute()
            
            if not response.data:
                # Try employee_id
                response = self.client.table('employees').select('*').eq('employee_id', email_or_employee_id).execute()
            
            if not response.data:
                logger.warning(f"No employee found with email or employee_id: {email_or_employee_id}")
                return None
            
            employee = response.data[0]
            
            # Check password (in production, use proper hashing)
            if employee['password_hash'] != password:
                logger.warning(f"Password mismatch for employee: {employee['name']}")
                return None
            
            # Check if employee is active
            if not employee['is_active']:
                logger.warning(f"Employee account is inactive: {employee['name']}")
                return None
            
            self.current_employee = employee
            logger.info(f"Successfully authenticated: {employee['name']} (Organization: {employee['organization_id']})")
            return employee
            
        except Exception as e:
            logger.error(f"Authentication error: {e}")
            return None

    def create_session(self, employee_id: str, organization_id: str) -> Optional[str]:
        """Create a new session for the employee"""
        try:
            session_token = hashlib.sha256(f"{employee_id}{datetime.now().isoformat()}".encode()).hexdigest()
            
            session_data = {
                'employee_id': self.current_employee['id'],  # Use UUID instead of string ID
                'organization_id': self.current_employee['organization_id'],  # This is already UUID
                'session_token': session_token,
                'login_time': datetime.now(timezone.utc).isoformat(),
                'is_active': True,
                'ip_address': '127.0.0.1',  # In production, get real IP
                'user_agent': 'Mycroscope Desktop App'
            }
            
            response = self.client.table('sessions').insert(session_data).execute()
            
            if response.data:
                self.current_session = response.data[0]
                logger.info(f"Session created for employee: {employee_id}")
                return session_token
            
            return None
            
        except Exception as e:
            logger.error(f"Error creating session: {e}")
            return None

    def end_session(self, session_token: str) -> bool:
        """End an active session"""
        try:
            response = self.client.table('sessions').update({
                'is_active': False,
                'logout_time': datetime.now(timezone.utc).isoformat()
            }).eq('session_token', session_token).execute()
            
            if response.data:
                logger.info(f"Session ended: {session_token}")
                return True
            
            return False
            
        except Exception as e:
            logger.error(f"Error ending session: {e}")
            return False

    def log_activity(self, activity_type: str, description: str = None, metadata: Dict[str, Any] = None) -> bool:
        """Log employee activity"""
        if not self.current_employee or not self.current_session:
            logger.warning("No active employee or session for activity logging")
            return False
        
        try:
            activity_data = {
                'employee_id': self.current_employee['id'],  # Use UUID instead of string ID
                'organization_id': self.current_employee['organization_id'],  # This is already UUID
                'session_id': self.current_session['id'],
                'activity_type': activity_type,
                'description': description,
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'metadata': metadata or {}
            }
            
            response = self.client.table('activity_logs').insert(activity_data).execute()
            
            if response.data:
                logger.debug(f"Activity logged: {activity_type}")
                return True
            
            return False
            
        except Exception as e:
            logger.error(f"Error logging activity: {e}")
            return False

    def log_app_usage(self, app_name: str, window_title: str = None, duration_seconds: int = 0) -> bool:
        """Log application usage"""
        if not self.current_employee or not self.current_session:
            logger.warning("No active employee or session for app usage logging")
            return False
        
        try:
            app_data = {
                'employee_id': self.current_employee['id'],  # Use UUID instead of string ID
                'organization_id': self.current_employee['organization_id'],  # This is already UUID
                'session_id': self.current_session['id'],
                'app_name': app_name,
                'window_title': window_title,
                'start_time': datetime.now(timezone.utc).isoformat(),
                'duration_seconds': duration_seconds,
                'is_active': True
            }
            
            response = self.client.table('app_usage').insert(app_data).execute()
            
            if response.data:
                logger.debug(f"App usage logged: {app_name}")
                return True
            
            return False
            
        except Exception as e:
            logger.error(f"Error logging app usage: {e}")
            return False

    def log_web_activity(self, url: str, title: str = None, domain: str = None, duration_seconds: int = 0) -> bool:
        """Log web browsing activity"""
        if not self.current_employee or not self.current_session:
            logger.warning("No active employee or session for web activity logging")
            return False
        
        try:
            web_data = {
                'employee_id': self.current_employee['id'],  # Use UUID instead of string ID
                'organization_id': self.current_employee['organization_id'],  # This is already UUID
                'session_id': self.current_session['id'],
                'url': url,
                'title': title,
                'domain': domain,
                'start_time': datetime.now(timezone.utc).isoformat(),
                'duration_seconds': duration_seconds,
                'is_active': True
            }
            
            response = self.client.table('web_activity').insert(web_data).execute()
            
            if response.data:
                logger.debug(f"Web activity logged: {url}")
                return True
            
            return False
            
        except Exception as e:
            logger.error(f"Error logging web activity: {e}")
            return False

    def get_employee_by_email(self, email: str, organization_id: str = None) -> Optional[Dict[str, Any]]:
        """Get employee by email with optional organization filtering"""
        try:
            query = self.client.table('employees').select('*').eq('email', email)
            
            if organization_id:
                query = query.eq('organization_id', organization_id)
            
            response = query.execute()
            
            if response.data:
                return response.data[0]
            
            return None
            
        except Exception as e:
            logger.error(f"Error getting employee by email: {e}")
            return None

    def get_employee_by_employee_id(self, employee_id: str, organization_id: str = None) -> Optional[Dict[str, Any]]:
        """Get employee by employee_id with optional organization filtering"""
        try:
            query = self.client.table('employees').select('*').eq('employee_id', employee_id)
            
            if organization_id:
                query = query.eq('organization_id', organization_id)
            
            response = query.execute()
            
            if response.data:
                return response.data[0]
            
            return None
            
        except Exception as e:
            logger.error(f"Error getting employee by employee_id: {e}")
            return None

    def get_activity_logs(self, organization_id: str = None, employee_id: str = None, 
                         start_date: str = None, end_date: str = None) -> List[Dict[str, Any]]:
        """Get activity logs with optional filtering"""
        try:
            query = self.client.table('activity_logs').select('*').order('timestamp', desc=True)
            
            if organization_id:
                query = query.eq('organization_id', organization_id)
            
            if employee_id:
                query = query.eq('employee_id', employee_id)
            
            if start_date:
                query = query.gte('timestamp', start_date)
            
            if end_date:
                query = query.lte('timestamp', end_date)
            
            response = query.execute()
            
            return response.data or []
            
        except Exception as e:
            logger.error(f"Error getting activity logs: {e}")
            return []

    def get_active_sessions(self, organization_id: str = None) -> List[Dict[str, Any]]:
        """Get active sessions with optional organization filtering"""
        try:
            query = self.client.table('sessions').select('*').eq('is_active', True).order('login_time', desc=True)
            
            if organization_id:
                query = query.eq('organization_id', organization_id)
            
            response = query.execute()
            
            return response.data or []
            
        except Exception as e:
            logger.error(f"Error getting active sessions: {e}")
            return []

    def get_app_usage(self, organization_id: str = None, employee_id: str = None,
                     start_date: str = None, end_date: str = None) -> List[Dict[str, Any]]:
        """Get app usage data with optional filtering"""
        try:
            query = self.client.table('app_usage').select('*').order('start_time', desc=True)
            
            if organization_id:
                query = query.eq('organization_id', organization_id)
            
            if employee_id:
                query = query.eq('employee_id', employee_id)
            
            if start_date:
                query = query.gte('start_time', start_date)
            
            if end_date:
                query = query.lte('start_time', end_date)
            
            response = query.execute()
            
            return response.data or []
            
        except Exception as e:
            logger.error(f"Error getting app usage: {e}")
            return []

    def get_web_activity(self, organization_id: str = None, employee_id: str = None,
                        start_date: str = None, end_date: str = None) -> List[Dict[str, Any]]:
        """Get web activity data with optional filtering"""
        try:
            query = self.client.table('web_activity').select('*').order('start_time', desc=True)
            
            if organization_id:
                query = query.eq('organization_id', organization_id)
            
            if employee_id:
                query = query.eq('employee_id', employee_id)
            
            if start_date:
                query = query.gte('start_time', start_date)
            
            if end_date:
                query = query.lte('start_time', end_date)
            
            response = query.execute()
            
            return response.data or []
            
        except Exception as e:
            logger.error(f"Error getting web activity: {e}")
            return []

    def is_authenticated(self) -> bool:
        """Check if employee is authenticated"""
        return self.current_employee is not None and self.current_session is not None

    def get_current_employee(self) -> Optional[Dict[str, Any]]:
        """Get current authenticated employee"""
        return self.current_employee

    def get_current_session(self) -> Optional[Dict[str, Any]]:
        """Get current session"""
        return self.current_session

    def logout(self) -> bool:
        """Logout current employee"""
        try:
            if self.current_session:
                self.end_session(self.current_session['session_token'])
            
            self.current_employee = None
            self.current_session = None
            
            logger.info("Employee logged out successfully")
            return True
            
        except Exception as e:
            logger.error(f"Error during logout: {e}")
            return False

    def sync_activity_data(self, activity_data: Dict[str, Any]) -> bool:
        """Sync activity data to Supabase"""
        try:
            if not self.current_employee or not self.current_session:
                logger.warning("No active employee or session for activity sync")
                return False
            
            # Create activity log entry directly
            activity_log_data = {
                'employee_id': activity_data.get("employee_id"),  # Use the UUID from activity_data
                'organization_id': activity_data.get("organization_id"),  # Use the UUID from activity_data
                'session_id': self.current_session['id'],
                'activity_type': activity_data.get("activity_type", "general"),
                'description': f"Activity sync: {activity_data.get('details', {})}",
                'timestamp': activity_data.get("timestamp", datetime.now(timezone.utc).isoformat()),
                'metadata': activity_data.get("details", {})
            }
            
            response = self.client.table('activity_logs').insert(activity_log_data).execute()
            
            if response.data:
                logger.info("Activity data sync successful")
                return True
            else:
                logger.error("Activity data sync failed - no response data")
                return False
            
        except Exception as e:
            logger.error(f"Error syncing activity data: {e}")
            return False

    def sync_current_activity(self, activity_data: Dict[str, Any]) -> bool:
        """Sync current activity data to Supabase (separate from session tracking)"""
        try:
            if not self.current_employee or not self.current_session:
                logger.warning("No active employee or session for current activity sync")
                return False
            
            # Check if there's already a current activity record for this employee
            # Since activity_type column might not exist, we'll use a different approach
            # We'll look for records with is_active=True and no end_time (current sessions)
            response = self.client.table('app_usage').select('*').eq('employee_id', activity_data.get("employee_id")).eq('is_active', True).is_('end_time', 'null').execute()
            
            if response.data and len(response.data) > 0:
                # Update existing current activity record
                existing_record = response.data[0]
                update_data = {
                    'app_name': activity_data.get("app_name"),
                    'window_title': activity_data.get("window_title"),
                    'duration_seconds': activity_data.get("duration_seconds", 0),
                    'start_time': activity_data.get("start_time"),
                    'current_project': activity_data.get("current_project")  # Add project information
                    # Removed updated_at since that column doesn't exist
                }
                
                response = self.client.table('app_usage').update(update_data).eq('id', existing_record['id']).execute()
                
                if response.data:
                    logger.info(f"Current activity updated for {activity_data.get('app_name')}: successful")
                    return True
                else:
                    logger.error(f"Current activity update for {activity_data.get('app_name')}: failed - no response data")
                    return False
            else:
                # Create new current activity record
                current_activity_data = {
                    'employee_id': activity_data.get("employee_id"),
                    'organization_id': activity_data.get("organization_id"),
                    'session_id': self.current_session['id'],
                    'app_name': activity_data.get("app_name", "unknown"),
                    'window_title': activity_data.get("window_title"),
                    'start_time': activity_data.get("start_time", datetime.now(timezone.utc).isoformat()),
                    'duration_seconds': activity_data.get("duration_seconds", 0),
                    'end_time': None,  # Active session, no end time yet
                    'is_active': True,
                    'current_project': activity_data.get("current_project")  # Add project information
                    # Note: activity_type column is not included to avoid errors if it doesn't exist
                }
                
                response = self.client.table('app_usage').insert(current_activity_data).execute()
                
                if response.data:
                    logger.info(f"Current activity sync for {activity_data.get('app_name')}: successful")
                    return True
                else:
                    logger.error(f"Current activity sync for {activity_data.get('app_name')}: failed - no response data")
                    return False
            
        except Exception as e:
            logger.error(f"Error syncing current activity: {e}")
            return False

    def sync_app_usage(self, app_data: Dict[str, Any]) -> bool:
        """Sync app usage data to Supabase"""
        try:
            if not self.current_employee or not self.current_session:
                logger.warning("No active employee or session for app usage sync")
                return False
            
            # Check if there's already an active record for this app
            existing_record = None
            if app_data.get("is_active", False):
                response = self.client.table('app_usage').select('*').eq('employee_id', app_data.get("employee_id")).eq('app_name', app_data.get("app_name")).eq('is_active', True).execute()
                if response.data and len(response.data) > 0:
                    existing_record = response.data[0]
            
            if existing_record:
                # Update existing active record
                update_data = {
                    'duration_seconds': app_data.get("duration_seconds", 0),
                    'window_title': app_data.get("window_title"),
                    'updated_at': datetime.now(timezone.utc).isoformat(),
                    'current_project': app_data.get("current_project")  # Add project information
                }
                
                response = self.client.table('app_usage').update(update_data).eq('id', existing_record['id']).execute()
                
                if response.data:
                    logger.info(f"App usage updated for {app_data.get('app_name')}: successful")
                    return True
                else:
                    logger.error(f"App usage update for {app_data.get('app_name')}: failed - no response data")
                    return False
            else:
                # Create new app usage entry
                app_usage_data = {
                    'employee_id': app_data.get("employee_id"),  # Use the UUID from app_data
                    'organization_id': app_data.get("organization_id"),  # Use the UUID from app_data
                    'session_id': self.current_session['id'],
                    'app_name': app_data.get("app_name", "unknown"),
                    'window_title': app_data.get("window_title"),
                    'start_time': app_data.get("start_time", datetime.now(timezone.utc).isoformat()),
                    'duration_seconds': app_data.get("duration_seconds", 0),
                    'end_time': app_data.get("end_time"),  # Can be None for active sessions
                    'is_active': app_data.get("is_active", True),
                    'current_project': app_data.get("current_project")  # Add project information
                }
                
                response = self.client.table('app_usage').insert(app_usage_data).execute()
                
                if response.data:
                    logger.info(f"App usage sync for {app_data.get('app_name')}: successful")
                    return True
                else:
                    logger.error(f"App usage sync for {app_data.get('app_name')}: failed - no response data")
                    return False
            
        except Exception as e:
            logger.error(f"Error syncing app usage: {e}")
            return False

    def sync_web_activity(self, web_data: Dict[str, Any]) -> bool:
        """Sync web activity data to Supabase"""
        try:
            if not self.current_employee or not self.current_session:
                logger.warning("No active employee or session for web activity sync")
                return False
            
            # Extract domain from URL if not provided
            url = web_data.get("url", "")
            domain = web_data.get("domain")
            if not domain and url and '://' in url:
                try:
                    from urllib.parse import urlparse
                    parsed = urlparse(url)
                    domain = parsed.netloc
                except:
                    domain = url.split('/')[0] if '/' in url else url
            
            # Remove www. prefix from domain
            if domain and domain.startswith('www.'):
                domain = domain[4:]
            
            # Create web activity entry directly
            web_activity_data = {
                'employee_id': web_data.get("employee_id"),  # Use the UUID from web_data
                'organization_id': web_data.get("organization_id"),  # Use the UUID from web_data
                'session_id': self.current_session['id'],
                'url': url,
                'title': web_data.get("title"),
                'domain': domain,
                'start_time': web_data.get("timestamp", datetime.now(timezone.utc).isoformat()),
                'duration_seconds': web_data.get("duration_seconds", 0),
                'is_active': True,
                'current_project': web_data.get("current_project")  # Add project information
            }
            
            response = self.client.table('web_activity').insert(web_activity_data).execute()
            
            if response.data:
                logger.info(f"Web activity sync for {domain} - {web_data.get('title', 'Unknown')}: successful")
                return True
            else:
                logger.error(f"Web activity sync for {domain}: failed - no response data")
                return False
            
        except Exception as e:
            logger.error(f"Error syncing web activity: {e}")
            return False


# Global Supabase manager instance
supabase_client = SupabaseClient()

def get_supabase_client() -> SupabaseClient:
    """Get the global Supabase client instance"""
    return supabase_client 