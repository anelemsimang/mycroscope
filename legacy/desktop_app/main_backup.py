import sys
import threading
import tkinter as tk
from tkinter import ttk, messagebox
from datetime import datetime, date, timedelta
from core.activity_tracker import ActivityTracker
from core.supabase_client import supabase_client, get_supabase_client
from config import APP_NAME, THEME_COLORS
from utils.logger import system_logger, activity_logger, setup_logger
from utils.startup import setup_security, require_admin_privileges, verify_admin_password, check_startup
from utils.encryption import encrypt_data, decrypt_data
import time
import logging

# Setup logging
setup_logger()
logger = logging.getLogger(__name__)

class LoginWindow:
    def __init__(self, root):
        self.root = root
        self.root.title(f"{APP_NAME} - Login")
        self.root.geometry("400x400")
        self.root.configure(bg=THEME_COLORS["background"])
        self.root.resizable(False, False)
        self.root.attributes('-topmost', True)
        self.employee_id = tk.StringVar()
        self.password = tk.StringVar()
        self.tracker = None
        self._build_ui()
        self._center_window()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.logged_in = False
        
        # Setup security on startup
        setup_security()

    def _build_ui(self):
        # Create main frame
        main_frame = tk.Frame(self.root, bg=THEME_COLORS["background"])
        main_frame.pack(fill="both", expand=True, padx=20, pady=20)
        
        # Title
        title_label = tk.Label(
            main_frame, 
            text=APP_NAME, 
            font=("Segoe UI", 20, "bold"), 
            fg=THEME_COLORS["primary"], 
            bg=THEME_COLORS["background"]
        )
        title_label.pack(pady=(0, 20))
        
        # Form frame
        form_frame = tk.Frame(main_frame, bg=THEME_COLORS["background"])
        form_frame.pack(fill="x", pady=10)
        
        # Employee ID
        tk.Label(form_frame, text="Employee ID:", bg=THEME_COLORS["background"], fg=THEME_COLORS["text"], font=("Segoe UI", 11)).pack(anchor="w", pady=(0, 5))
        emp_entry = tk.Entry(form_frame, textvariable=self.employee_id, font=("Segoe UI", 11), width=30)
        emp_entry.pack(fill="x", pady=(0, 15))
        
        # Password
        tk.Label(form_frame, text="Password:", bg=THEME_COLORS["background"], fg=THEME_COLORS["text"], font=("Segoe UI", 11)).pack(anchor="w", pady=(0, 5))
        pwd_entry = tk.Entry(form_frame, textvariable=self.password, show="*", font=("Segoe UI", 11), width=30)
        pwd_entry.pack(fill="x", pady=(0, 15))
        
        # Button frame
        button_frame = tk.Frame(main_frame, bg=THEME_COLORS["background"])
        button_frame.pack(fill="x", pady=20)
        
        # Login button - make it very obvious
        login_button = tk.Button(
            button_frame, 
            text="LOGIN", 
            command=self._on_login,
            bg=THEME_COLORS["primary"],
            fg="white",
            font=("Segoe UI", 14, "bold"),
            relief="raised",
            bd=3,
            padx=40,
            pady=12,
            cursor="hand2"
        )
        login_button.pack()
        
        # Add some debug info
        debug_label = tk.Label(
            main_frame, 
            text="Button should be visible below", 
            bg=THEME_COLORS["background"], 
            fg="red", 
            font=("Segoe UI", 10)
        )
        debug_label.pack(pady=(10, 0))

    def _center_window(self):
        self.root.update_idletasks()
        w = self.root.winfo_width()
        h = self.root.winfo_height()
        ws = self.root.winfo_screenwidth()
        hs = self.root.winfo_screenheight()
        x = (ws // 2) - (w // 2)
        y = (hs // 2) - (h // 2)
        self.root.geometry(f'{w}x{h}+{x}+{y}')

    def _on_login(self):
        emp_id = self.employee_id.get().strip()
        pwd = self.password.get().strip()
        if not emp_id or not pwd:
            messagebox.showerror("Login Failed", "Please enter Employee ID and Password.")
            return
        # Authenticate with Supabase
        employee = supabase_client.authenticate_employee(emp_id, pwd)
        if employee:
            # Create session for the employee using the UUID (id field)
            session_token = supabase_client.create_session(employee['id'], employee['organization_id'])
            if session_token:
                self.logged_in = True
                self.root.withdraw()
                self._start_tracking(emp_id)
            else:
                messagebox.showerror("Login Failed", "Failed to create session.")
        else:
            messagebox.showerror("Login Failed", "Invalid Employee ID or Password.")

    def _start_tracking(self, emp_id):
        self.tracker = ActivityTracker(emp_id, supabase_client)
        self.tracker.start_tracking()
        system_logger.log_startup(datetime.now())
        self._show_main_window(emp_id)

    def _show_main_window(self, emp_id):
        main_win = tk.Toplevel(self.root)
        main_win.title(f"{APP_NAME} - Tracking")
        main_win.geometry("350x200")
        main_win.configure(bg=THEME_COLORS["background"])
        main_win.resizable(False, False)
        main_win.protocol("WM_DELETE_WINDOW", self._on_close)
        tk.Label(main_win, text=f"Welcome, {emp_id}", font=("Segoe UI", 14, "bold"), fg=THEME_COLORS["primary"], bg=THEME_COLORS["background"]).pack(pady=(20, 10))
        ttk.Button(main_win, text="Logout", command=self._on_logout).pack(pady=(20, 0))
        # Block Alt+Tab, Ctrl+Alt+Del, etc. (best effort, not foolproof)
        self._block_shortcuts(main_win)

    def _on_logout(self):
        if self.tracker:
            self.tracker.stop_tracking()
        system_logger.log_shutdown(datetime.now())
        self.root.destroy()
        sys.exit(0)

    def _on_close(self):
        # Prevent closing login window unless logged in
        if not self.logged_in:
            messagebox.showwarning("Action Blocked", "You must log in to use this computer.")
        else:
            self._on_logout()

    def _block_shortcuts(self, win):
        # This is a best-effort; true blocking requires system-level hooks/admin
        def disable_event():
            pass
        win.bind("<Alt-Tab>", lambda e: "break")
        win.bind("<Control-Alt-Delete>", lambda e: "break")
        win.protocol("WM_DELETE_WINDOW", disable_event)

class DailyAggregator:
    def __init__(self):
        self.supabase = get_supabase_client()
        
    def aggregate_daily_data(self, employee_id: str, organization_id: str, target_date: date = None) -> dict:
        """Aggregate daily data for an employee"""
        if target_date is None:
            target_date = date.today() - timedelta(days=1)
            
        logger.info(f"Aggregating daily data for employee {employee_id} on {target_date}")
        
        try:
            # Get data for the specified date
            start_time = datetime.combine(target_date, datetime.min.time()).isoformat()
            end_time = datetime.combine(target_date, datetime.max.time()).isoformat()
            
            # Fetch and aggregate data
            app_data = self._fetch_data('app_usage', employee_id, start_time, end_time)
            web_data = self._fetch_data('web_activity', employee_id, start_time, end_time)
            activity_data = self._fetch_data('activity_logs', employee_id, start_time, end_time)
            sessions_data = self._fetch_data('sessions', employee_id, start_time, end_time)
            
            # Create summary
            summary = {
                'employee_id': employee_id,
                'organization_id': organization_id,
                'date': target_date.isoformat(),
                'app_summary': self._process_app_summary(app_data),
                'web_summary': self._process_web_summary(web_data),
                'activity_summary': self._process_activity_summary(activity_data),
                'total_active_time': sum(app.get('duration_seconds', 0) or 0 for app in app_data),
                'total_sessions': len(sessions_data)
            }
            
            logger.info(f"Daily summary created: {summary['total_active_time']}s active time")
            return summary
            
        except Exception as e:
            logger.error(f"Error aggregating daily data: {e}")
            return {}
    
    def _fetch_data(self, table: str, employee_id: str, start_time: str, end_time: str) -> list:
        """Fetch data from a table for the specified time range"""
        try:
            if table == 'activity_logs':
                response = self.supabase.table(table).select('*').eq('employee_id', employee_id).gte('timestamp', start_time).lte('timestamp', end_time).execute()
            else:
                response = self.supabase.table(table).select('*').eq('employee_id', employee_id).gte('start_time', start_time).lte('start_time', end_time).execute()
            return response.data or []
        except Exception as e:
            logger.error(f"Error fetching {table}: {e}")
            return []
    
    def _process_app_summary(self, app_data: list) -> list:
        """Process app usage data into summary format"""
        app_groups = {}
        for app in app_data:
            app_name = app.get('app_name', 'Unknown')
            if app_name not in app_groups:
                app_groups[app_name] = {'total_time': 0, 'session_count': 0}
            app_groups[app_name]['total_time'] += app.get('duration_seconds', 0) or 0
            app_groups[app_name]['session_count'] += 1
        
        return [{'app_name': k, 'total_time': v['total_time'], 'session_count': v['session_count']} 
                for k, v in app_groups.items()]
    
    def _process_web_summary(self, web_data: list) -> list:
        """Process web activity data into summary format"""
        domain_groups = {}
        for web in web_data:
            try:
                from urllib.parse import urlparse
                domain = urlparse(web.get('url', '')).netloc or 'Unknown'
            except:
                domain = 'Unknown'
            
            if domain not in domain_groups:
                domain_groups[domain] = {'total_time': 0, 'visit_count': 0}
            domain_groups[domain]['total_time'] += web.get('duration_seconds', 0) or 0
            domain_groups[domain]['visit_count'] += 1
        
        return [{'domain': k, 'total_time': v['total_time'], 'visit_count': v['visit_count']} 
                for k, v in domain_groups.items()]
    
    def _process_activity_summary(self, activity_data: list) -> list:
        """Process activity logs into summary format"""
        activity_groups = {}
        for activity in activity_data:
            activity_type = activity.get('activity_type', 'Unknown')
            if activity_type not in activity_groups:
                activity_groups[activity_type] = {'frequency': 0}
            activity_groups[activity_type]['frequency'] += 1
        
        return [{'activity_type': k, 'frequency': v['frequency']} 
                for k, v in activity_groups.items()]
    
    def save_daily_summary(self, summary: dict) -> bool:
        """Save daily summary to database"""
        try:
            # Check if summary already exists
            existing = self.supabase.table('daily_summaries').select('id').eq('employee_id', summary['employee_id']).eq('date', summary['date']).execute()
            
            if existing.data:
                # Update existing
                self.supabase.table('daily_summaries').update(summary).eq('employee_id', summary['employee_id']).eq('date', summary['date']).execute()
            else:
                # Insert new
                self.supabase.table('daily_summaries').insert(summary).execute()
            
            logger.info(f"Daily summary saved for {summary['date']}")
            return True
            
        except Exception as e:
            logger.error(f"Error saving daily summary: {e}")
            return False

    def process_all_employees(self, organization_id: str, target_date: date = None) -> int:
        """Process daily aggregation for all employees in an organization"""
        try:
            # Get all employees in the organization
            response = self.supabase.table('employees').select('id').eq('organization_id', organization_id).execute()
            employees = response.data or []
            
            processed_count = 0
            for employee in employees:
                try:
                    summary = self.aggregate_daily_data(employee['id'], organization_id, target_date)
                    if summary and self.save_daily_summary(summary):
                        processed_count += 1
                except Exception as e:
                    logger.error(f"Error processing employee {employee['id']}: {e}")
            
            logger.info(f"Processed daily summaries for {processed_count}/{len(employees)} employees")
            return processed_count
            
        except Exception as e:
            logger.error(f"Error processing all employees: {e}")
            return 0
    
    def cleanup_old_summaries(self) -> int:
        """Clean up summaries older than 90 days"""
        try:
            cutoff_date = (date.today() - timedelta(days=90)).isoformat()
            response = self.supabase.table('daily_summaries').delete().lt('date', cutoff_date).execute()
            
            deleted_count = len(response.data) if response.data else 0
            logger.info(f"Cleaned up {deleted_count} old daily summaries")
            return deleted_count
            
        except Exception as e:
            logger.error(f"Error cleaning up old summaries: {e}")
            return 0

class MycroscopeApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("Mycroscope - Employee Monitoring")
        self.root.geometry("400x300")
        self.root.resizable(False, False)
        
        # Initialize components
        self.supabase = get_supabase_client()
        self.activity_tracker = None
        self.daily_aggregator = DailyAggregator()
        self.current_employee = None
        self.current_organization = None
        
        # Setup UI
        self.setup_ui()
        
        # Check startup
        check_startup()
        
        # Start daily aggregation scheduler
        self.start_daily_aggregation()
    
    def setup_ui(self):
        """Setup the user interface"""
        # Title
        title_label = tk.Label(self.root, text="Mycroscope", font=("Arial", 16, "bold"))
        title_label.pack(pady=20)
        
        # Login frame
        self.login_frame = tk.Frame(self.root)
        self.login_frame.pack(pady=20)
        
        # Employee ID
        tk.Label(self.login_frame, text="Employee ID:").pack()
        self.employee_id_entry = tk.Entry(self.login_frame, width=30)
        self.employee_id_entry.pack(pady=5)
        
        # Password
        tk.Label(self.login_frame, text="Password:").pack()
        self.password_entry = tk.Entry(self.login_frame, show="*", width=30)
        self.password_entry.pack(pady=5)
        
        # Login button
        self.login_button = tk.Button(self.login_frame, text="Login", command=self.login, bg="#4CAF50", fg="white", width=20)
        self.login_button.pack(pady=10)
        
        # Status label
        self.status_label = tk.Label(self.root, text="Please login to start monitoring", fg="gray")
        self.status_label.pack(pady=10)
        
        # Main frame (hidden initially)
        self.main_frame = tk.Frame(self.root)
        
        # Status display
        self.status_display = tk.Label(self.main_frame, text="", font=("Arial", 10))
        self.status_display.pack(pady=10)
        
        # Control buttons
        button_frame = tk.Frame(self.main_frame)
        button_frame.pack(pady=10)
        
        self.start_button = tk.Button(button_frame, text="Start Monitoring", command=self.start_monitoring, bg="#2196F3", fg="white", width=15)
        self.start_button.pack(side=tk.LEFT, padx=5)
        
        self.stop_button = tk.Button(button_frame, text="Stop Monitoring", command=self.stop_monitoring, bg="#f44336", fg="white", width=15, state=tk.DISABLED)
        self.stop_button.pack(side=tk.LEFT, padx=5)
        
        # Logout button
        self.logout_button = tk.Button(self.main_frame, text="Logout", command=self.logout, bg="#FF9800", fg="white", width=15)
        self.logout_button.pack(pady=10)
    
    def login(self):
        """Handle user login"""
        employee_id = self.employee_id_entry.get().strip()
        password = self.password_entry.get().strip()
        
        if not employee_id or not password:
            messagebox.showerror("Error", "Please enter both employee ID and password")
            return
        
        try:
            # Get employee data
            response = self.supabase.table('employees').select('*, organizations(*)').eq('employee_id', employee_id).single().execute()
            
            if not response.data:
                messagebox.showerror("Error", "Invalid employee ID")
                return
            
            employee = response.data
            
            # Verify password (in production, use proper hashing)
            if employee['password'] != password:
                messagebox.showerror("Error", "Invalid password")
                return
            
            # Store current user info
            self.current_employee = employee
            self.current_organization = employee['organizations']
            
            # Switch to main interface
            self.login_frame.pack_forget()
            self.main_frame.pack()
            
            self.status_label.config(text=f"Logged in as {employee['name']}")
            self.status_display.config(text=f"Employee: {employee['name']}\nOrganization: {employee['organizations']['name']}")
            
            logger.info(f"Employee {employee['name']} logged in successfully")
            
        except Exception as e:
            logger.error(f"Login error: {e}")
            messagebox.showerror("Error", f"Login failed: {str(e)}")
    
    def start_monitoring(self):
        """Start activity monitoring"""
        if not self.current_employee:
            messagebox.showerror("Error", "Please login first")
            return
        
        try:
            self.activity_tracker = ActivityTracker(
                employee_id=self.current_employee['id'],
                organization_id=self.current_employee['organization_id']
            )
            
            # Start monitoring in a separate thread
            self.monitoring_thread = threading.Thread(target=self.activity_tracker.start_monitoring, daemon=True)
            self.monitoring_thread.start()
            
            self.start_button.config(state=tk.DISABLED)
            self.stop_button.config(state=tk.NORMAL)
            self.status_display.config(text=f"Monitoring started for {self.current_employee['name']}")
            
            logger.info("Activity monitoring started")
            
        except Exception as e:
            logger.error(f"Error starting monitoring: {e}")
            messagebox.showerror("Error", f"Failed to start monitoring: {str(e)}")
    
    def stop_monitoring(self):
        """Stop activity monitoring"""
        if self.activity_tracker:
            self.activity_tracker.stop_monitoring()
            self.activity_tracker = None
            
            self.start_button.config(state=tk.NORMAL)
            self.stop_button.config(state=tk.DISABLED)
            self.status_display.config(text="Monitoring stopped")
            
            logger.info("Activity monitoring stopped")
    
    def logout(self):
        """Handle user logout"""
        self.stop_monitoring()
        
        self.current_employee = None
        self.current_organization = None
        
        self.main_frame.pack_forget()
        self.login_frame.pack()
        
        self.employee_id_entry.delete(0, tk.END)
        self.password_entry.delete(0, tk.END)
        
        self.status_label.config(text="Please login to start monitoring")
        
        logger.info("User logged out")
    
    def start_daily_aggregation(self):
        """Start daily aggregation scheduler"""
        def run_daily_aggregation():
            while True:
                try:
                    # Wait until next day at 1 AM
                    now = datetime.now()
                    next_run = now.replace(hour=1, minute=0, second=0, microsecond=0)
                    if next_run <= now:
                        next_run += timedelta(days=1)
                    
                    wait_seconds = (next_run - now).total_seconds()
                    logger.info(f"Next daily aggregation scheduled for {next_run}")
                    time.sleep(wait_seconds)
                    
                    # Run aggregation for all employees in the organization
                    if self.current_organization:
                        logger.info("Starting daily aggregation...")
                        self.daily_aggregator.process_all_employees(self.current_organization['id'])
                        
                        # Clean up old summaries (older than 90 days)
                        self.daily_aggregator.cleanup_old_summaries()
                        
                except Exception as e:
                    logger.error(f"Error in daily aggregation: {e}")
                    time.sleep(3600)  # Wait an hour before retrying
        
        # Start aggregation thread
        aggregation_thread = threading.Thread(target=run_daily_aggregation, daemon=True)
        aggregation_thread.start()
        logger.info("Daily aggregation scheduler started")
    
    def run(self):
        """Start the application"""
        self.root.mainloop()

def main():
    # Require admin privileges for enhanced security
    require_admin_privileges()
    
    root = tk.Tk()
    app = LoginWindow(root)
    root.mainloop()

if __name__ == "__main__":
    main() 