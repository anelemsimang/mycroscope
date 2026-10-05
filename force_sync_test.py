#!/usr/bin/env python3
import os
import sys
from supabase import create_client, Client
from dotenv import load_dotenv
from datetime import datetime, timezone

# Load environment variables
load_dotenv()

# Supabase configuration
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://YOUR_PROJECT_REF.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "REDACTED_SUPABASE_KEY")

# Initialize Supabase client
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def force_sync_test():
    """Force update the current activity record with the project"""
    
    employee_id = "a1ffffc7-3995-4e49-9102-37b6e8702dbb"
    organization_id = "3fda15c4-bade-4d15-8fbe-80e4ac329194"
    project_name = "Shinkx App Dev2"
    
    print("=== Force updating current activity with project ===")
    
    # Find the current active app_usage record
    try:
        response = supabase.table('app_usage').select('*').eq('employee_id', employee_id).eq('is_active', True).is_('end_time', 'null').execute()
        
        if response.data and len(response.data) > 0:
            record = response.data[0]
            print(f"Found active record: {record.get('app_name')} (ID: {record.get('id')})")
            print(f"Current project: {record.get('current_project')}")
            
            # Update the record with the project
            update_data = {
                'current_project': project_name
            }
            
            update_response = supabase.table('app_usage').update(update_data).eq('id', record.get('id')).execute()
            
            if update_response.data:
                print(f"✅ Successfully updated project to: {project_name}")
            else:
                print("❌ Failed to update project")
        else:
            print("❌ No active app_usage record found")
            
    except Exception as e:
        print(f"Error updating record: {e}")
    
    # Also create a new activity log entry with the project
    print("\n=== Creating activity log entry with project ===")
    try:
        activity_log_data = {
            'employee_id': employee_id,
            'organization_id': organization_id,
            'activity_type': 'project_switch',
            'description': f'Switched to project: {project_name}',
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'metadata': {
                'current_project': project_name,
                'action': 'project_switch'
            }
        }
        
        response = supabase.table('activity_logs').insert(activity_log_data).execute()
        
        if response.data:
            print(f"✅ Successfully created activity log with project: {project_name}")
        else:
            print("❌ Failed to create activity log")
            
    except Exception as e:
        print(f"Error creating activity log: {e}")

if __name__ == "__main__":
    force_sync_test() 