import tkinter as tk
from tkinter import ttk, messagebox
import time
from typing import Optional, List, Dict
from supabase import create_client, Client
import logging

logger = logging.getLogger(__name__)

class ProjectManager:
    def __init__(self, supabase_client: Client, organization_id: str, employee_id: str):
        self.supabase = supabase_client
        self.organization_id = organization_id
        self.employee_id = employee_id
        self.projects_cache = []
        self.cache_timestamp = 0
        self.cache_duration = 300  # 5 minutes
        
    def get_projects(self, force_refresh: bool = False) -> List[Dict]:
        """Get all projects for the organization"""
        current_time = time.time()
        
        if not force_refresh and self.projects_cache and (current_time - self.cache_timestamp) < self.cache_duration:
            return self.projects_cache
        
        try:
            response = self.supabase.table('projects').select('*').eq('organization_id', self.organization_id).execute()
            
            if response.data:
                self.projects_cache = response.data
                self.cache_timestamp = current_time
                return response.data
            else:
                self.projects_cache = []
                return []
                
        except Exception as e:
            logger.error(f"Error fetching projects: {e}")
            return []
    
    def create_project(self, project_name: str, description: str = "") -> Optional[Dict]:
        """Create a new project"""
        try:
            # Check if project already exists
            existing_projects = self.get_projects()
            for project in existing_projects:
                if project['name'].lower() == project_name.lower():
                    return None  # Project already exists
            
            # Create new project
            project_data = {
                'organization_id': self.organization_id,
                'name': project_name,
                'description': description,
                'created_by': self.employee_id
            }
            
            response = self.supabase.table('projects').insert(project_data).execute()
            
            if response.data:
                # Refresh cache
                self.get_projects(force_refresh=True)
                return response.data[0]
            
            return None
            
        except Exception as e:
            logger.error(f"Error creating project: {e}")
            return None
    
    def show_project_dialog(self) -> Optional[str]:
        """Show project selection/creation dialog and return selected project name"""
        dialog = ProjectDialog(self)
        return dialog.show()

class ProjectDialog:
    def __init__(self, project_manager: ProjectManager):
        self.project_manager = project_manager
        self.selected_project = None
        self.dialog = None
        
    def show(self) -> Optional[str]:
        """Show the project dialog and return the selected project name"""
        # Create dialog in main thread
        self.dialog = tk.Toplevel()
        self.dialog.title("Select Project")
        self.dialog.geometry("400x500")
        self.dialog.resizable(False, False)
        self.dialog.transient()  # Make dialog modal
        self.dialog.grab_set()  # Make dialog modal
        
        # Center the dialog
        self.dialog.update_idletasks()
        x = (self.dialog.winfo_screenwidth() // 2) - (400 // 2)
        y = (self.dialog.winfo_screenheight() // 2) - (500 // 2)
        self.dialog.geometry(f"400x500+{x}+{y}")
        
        self.create_widgets()
        
        # Wait for dialog to close
        self.dialog.wait_window()
        
        return self.selected_project
    
    def create_widgets(self):
        """Create the dialog widgets"""
        # Main frame
        main_frame = ttk.Frame(self.dialog, padding="20")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        # Title
        title_label = ttk.Label(main_frame, text="What project are you working on?", font=("Arial", 14, "bold"))
        title_label.grid(row=0, column=0, columnspan=2, pady=(0, 20))
        
        # Default option
        default_frame = ttk.Frame(main_frame)
        default_frame.grid(row=1, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 20))
        
        default_btn = ttk.Button(default_frame, text="📧 Default Work (Emails, General)", 
                                command=lambda: self.select_project("Default"))
        default_btn.pack(fill=tk.X, pady=5)
        
        # Existing projects section
        projects_label = ttk.Label(main_frame, text="Existing Projects:", font=("Arial", 12, "bold"))
        projects_label.grid(row=2, column=0, columnspan=2, pady=(0, 10), sticky=tk.W)
        
        # Projects listbox
        self.projects_listbox = tk.Listbox(main_frame, height=8, font=("Arial", 10))
        self.projects_listbox.grid(row=3, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 10))
        self.projects_listbox.bind('<Double-Button-1>', self.on_project_select)
        
        # Load existing projects
        self.load_existing_projects()
        
        # New project section
        new_project_label = ttk.Label(main_frame, text="Create New Project:", font=("Arial", 12, "bold"))
        new_project_label.grid(row=4, column=0, columnspan=2, pady=(20, 10), sticky=tk.W)
        
        # Project name entry
        name_frame = ttk.Frame(main_frame)
        name_frame.grid(row=5, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 10))
        
        ttk.Label(name_frame, text="Project Name:").pack(anchor=tk.W)
        self.project_name_entry = ttk.Entry(name_frame, font=("Arial", 10))
        self.project_name_entry.pack(fill=tk.X, pady=(5, 0))
        
        # Project description entry
        desc_frame = ttk.Frame(main_frame)
        desc_frame.grid(row=6, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 15))
        
        ttk.Label(desc_frame, text="Description (optional):").pack(anchor=tk.W)
        self.project_desc_entry = ttk.Entry(desc_frame, font=("Arial", 10))
        self.project_desc_entry.pack(fill=tk.X, pady=(5, 0))
        
        # Create project button
        create_btn = ttk.Button(main_frame, text="Create New Project", 
                               command=self.create_new_project)
        create_btn.grid(row=7, column=0, columnspan=2, pady=(0, 20))
        
        # Cancel button
        cancel_btn = ttk.Button(main_frame, text="Cancel", 
                               command=self.cancel)
        cancel_btn.grid(row=8, column=0, columnspan=2)
        
        # Configure grid weights
        main_frame.columnconfigure(0, weight=1)
        self.dialog.columnconfigure(0, weight=1)
        self.dialog.rowconfigure(0, weight=1)
    
    def load_existing_projects(self):
        """Load existing projects into the listbox"""
        try:
            projects = self.project_manager.get_projects()
            
            # Filter out "Default" project since it has its own button
            filtered_projects = [p for p in projects if p['name'].lower() != 'default']
            
            for project in filtered_projects:
                self.projects_listbox.insert(tk.END, f"📁 {project['name']}")
                if project.get('description'):
                    self.projects_listbox.insert(tk.END, f"   {project['description']}")
                self.projects_listbox.insert(tk.END, "")  # Empty line
                
        except Exception as e:
            logger.error(f"Error loading projects: {e}")
    
    def on_project_select(self, event):
        """Handle project selection from listbox"""
        selection = self.projects_listbox.curselection()
        if selection:
            # Get the selected project name (remove the 📁 prefix)
            project_text = self.projects_listbox.get(selection[0])
            if project_text.startswith("📁 "):
                project_name = project_text[3:]  # Remove "📁 " prefix
                self.select_project(project_name)
    
    def select_project(self, project_name: str):
        """Select a project and close dialog"""
        self.selected_project = project_name
        self.dialog.destroy()
    
    def create_new_project(self):
        """Create a new project"""
        project_name = self.project_name_entry.get().strip()
        description = self.project_desc_entry.get().strip()
        
        if not project_name:
            messagebox.showerror("Error", "Please enter a project name")
            return
        
        # Check if project already exists
        existing_projects = self.project_manager.get_projects()
        for project in existing_projects:
            if project['name'].lower() == project_name.lower():
                messagebox.showerror("Error", f"Project '{project_name}' already exists")
                return
        
        # Create the project
        new_project = self.project_manager.create_project(project_name, description)
        
        if new_project:
            messagebox.showinfo("Success", f"Project '{project_name}' created successfully!")
            self.select_project(project_name)
        else:
            messagebox.showerror("Error", "Failed to create project. Please try again.")
    
    def cancel(self):
        """Cancel and close dialog"""
        self.selected_project = None
        self.dialog.destroy() 