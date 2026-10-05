#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import tkinter as tk
from tkinter import ttk, messagebox
import sys
import os
from datetime import datetime, date, timedelta
import logging

# Add the current directory to the Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from config import (
    APP_NAME, THEME_COLORS, TRACK_APPLICATIONS, TRACK_WEB_ACTIVITY,
    TRACK_MOUSE_MOVEMENTS, TRACK_KEYBOARD_ACTIVITY
)
from core.activity_tracker import ActivityTracker
from core.supabase_client import get_supabase_client
from core.project_manager import ProjectManager
from utils.logger import system_logger
from utils.startup import setup_security

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global Supabase client
supabase_client = get_supabase_client()

class LoginWindow:
    def __init__(self, root):
        self.root = root
        self.root.title(APP_NAME)
        self.root.geometry("400x350")
        self.root.resizable(False, False)
        self.root.attributes('-topmost', True)
        self.employee_id = tk.StringVar()
        self.password = tk.StringVar()
        self.project_var = tk.StringVar()
        self.tracker = None
        self.project_manager = None
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
        
        # Project selection
        tk.Label(form_frame, text="Project:", bg=THEME_COLORS["background"], fg=THEME_COLORS["text"], font=("Segoe UI", 11)).pack(anchor="w", pady=(0, 5))
        self.project_combobox = ttk.Combobox(form_frame, textvariable=self.project_var, state="readonly", font=("Segoe UI", 11))
        self.project_combobox.pack(fill="x", pady=(0, 15))
        
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

    def _center_window(self):
        self.root.update_idletasks()
        w = self.root.winfo_width()
        h = self.root.winfo_height()
        ws = self.root.winfo_screenwidth()
        hs = self.root.winfo_screenheight()
        x = (ws // 2) - (w // 2)
        y = (hs // 2) - (h // 2)
        self.root.geometry(f'{w}x{h}+{x}+{y}')

    def _load_projects(self, organization_id: str):
        """Load projects for the organization"""
        try:
            project_manager = ProjectManager(supabase_client.client, organization_id, "")
            projects = project_manager.get_projects()
            
            # Add Default option and existing projects
            project_options = ["Default"]
            for project in projects:
                project_options.append(project['name'])
            
            self.project_combobox['values'] = project_options
            self.project_combobox.current(0)  # Set to Default
            
        except Exception as e:
            logger.error(f"Error loading projects: {e}")
            # Fallback to just Default
            self.project_combobox['values'] = ["Default"]
            self.project_combobox.current(0)

    def _on_login(self):
        emp_id = self.employee_id.get().strip()
        pwd = self.password.get().strip()
        project = self.project_var.get().strip()
        
        if not emp_id or not pwd:
            messagebox.showerror("Login Failed", "Please enter Employee ID and Password.")
            return
        
        # Authenticate with Supabase
        employee = supabase_client.authenticate_employee(emp_id, pwd)
        if employee:
            # Load projects for this organization
            self._load_projects(employee['organization_id'])
            
            # Create session for the employee using the UUID (id field)
            session_token = supabase_client.create_session(employee['id'], employee['organization_id'])
            if session_token:
                self.logged_in = True
                self.root.withdraw()
                self._start_tracking(emp_id, project)
            else:
                messagebox.showerror("Login Failed", "Failed to create session.")
        else:
            messagebox.showerror("Login Failed", "Invalid Employee ID or Password.")

    def _start_tracking(self, emp_id, project):
        self.tracker = ActivityTracker(emp_id, supabase_client)
        if project and project != "Default":
            self.tracker.switch_project(project)
        else:
            self.tracker.switch_project("Default")
        self.tracker.start_tracking()
        system_logger.log_startup(datetime.now())
        self._show_main_window(emp_id, project)

    def _show_main_window(self, emp_id, project):
        main_win = tk.Toplevel(self.root)
        main_win.title(f"{APP_NAME} - Tracking")
        main_win.geometry("350x200")
        main_win.configure(bg=THEME_COLORS["background"])
        main_win.resizable(False, False)
        main_win.protocol("WM_DELETE_WINDOW", self._on_close)
        tk.Label(main_win, text=f"Welcome, {emp_id}", font=("Segoe UI", 14, "bold"), fg=THEME_COLORS["primary"], bg=THEME_COLORS["background"]).pack(pady=(20, 10))
        tk.Label(main_win, text=f"Project: {project}", font=("Segoe UI", 11), bg=THEME_COLORS["background"], fg=THEME_COLORS["text"]).pack(pady=5)
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

def main():
    # Require admin privileges for enhanced security
    try:
        root = tk.Tk()
        app = LoginWindow(root)
        root.mainloop()
    except Exception as e:
        logger.error(f"Application error: {e}")
        messagebox.showerror("Error", f"Application failed to start: {e}")

if __name__ == "__main__":
    main() 