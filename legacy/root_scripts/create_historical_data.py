#!/usr/bin/env python3
import os
import sys
from supabase import create_client, Client
from dotenv import load_dotenv
from datetime import datetime, timezone, timedelta

# Load environment variables
load_dotenv()

# Supabase configuration
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://YOUR_PROJECT_REF.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "REDACTED_SUPABASE_KEY")

# Initialize Supabase client
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def create_historical_data():
    """Create historical project data for testing"""
    
    employee_id = "a1ffffc7-3995-4e49-9102-37b6e8702dbb"
    organization_id = "3fda15c4-bade-4d15-8fbe-80e4ac329194"
    
    # Projects to create historical data for
    projects = [
        "Shinkx App Dev",
        "Shinkx App Dev2", 
        "Shinkx Facial Recorgnition",
        "Shinkx"
    ]
    
    print("=== Creating historical project data ===")
    
    # Create historical app_usage records for each project
    for i, project in enumerate(projects):
        # Create a record from 1-4 days ago
        days_ago = i + 1
        start_time = datetime.now(timezone.utc) - timedelta(days=days_ago, hours=2)
        end_time = start_time + timedelta(hours=1)
        
        app_usage_data = {
            'employee_id': employee_id,
            'organization_id': organization_id,
            'app_name': f'project_app_{i}',
            'window_title': f'Working on {project}',
            'start_time': start_time.isoformat(),
            'end_time': end_time.isoformat(),
            'duration_seconds': 3600,  # 1 hour
            'is_active': False,  # Historical record
            'current_project': project
        }
        
        try:
            response = supabase.table('app_usage').insert(app_usage_data).execute()
            if response.data:
                print(f"✅ Created historical app_usage for {project}")
            else:
                print(f"❌ Failed to create app_usage for {project}")
        except Exception as e:
            print(f"Error creating app_usage for {project}: {e}")
        
        # Create historical web_activity records
        web_activity_data = {
            'employee_id': employee_id,
            'organization_id': organization_id,
            'url': f'https://{project.lower().replace(" ", "")}.com',
            'title': f'{project} Documentation',
            'domain': f'{project.lower().replace(" ", "")}.com',
            'start_time': start_time.isoformat(),
            'end_time': end_time.isoformat(),
            'duration_seconds': 1800,  # 30 minutes
            'is_active': False,  # Historical record
            'current_project': project
        }
        
        try:
            response = supabase.table('web_activity').insert(web_activity_data).execute()
            if response.data:
                print(f"✅ Created historical web_activity for {project}")
            else:
                print(f"❌ Failed to create web_activity for {project}")
        except Exception as e:
            print(f"Error creating web_activity for {project}: {e}")
        
        # Create historical activity_logs
        activity_log_data = {
            'employee_id': employee_id,
            'organization_id': organization_id,
            'activity_type': 'project_work',
            'description': f'Working on {project}',
            'timestamp': start_time.isoformat(),
            'metadata': {
                'current_project': project,
                'action': 'project_work',
                'duration_minutes': 60
            }
        }
        
        try:
            response = supabase.table('activity_logs').insert(activity_log_data).execute()
            if response.data:
                print(f"✅ Created historical activity_log for {project}")
            else:
                print(f"❌ Failed to create activity_log for {project}")
        except Exception as e:
            print(f"Error creating activity_log for {project}: {e}")
    
    print("\n=== Historical data creation completed ===")

if __name__ == "__main__":
    create_historical_data() 