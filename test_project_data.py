#!/usr/bin/env python3
import os
import sys
from supabase import create_client, Client
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Supabase configuration
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://YOUR_PROJECT_REF.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "REDACTED_SUPABASE_KEY")

# Initialize Supabase client
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def test_project_data():
    """Test if there's any activity data with the Shinkx project"""
    
    # Test 1: Check app_usage table
    print("=== Checking app_usage table ===")
    try:
        response = supabase.table('app_usage').select('*').eq('current_project', 'Shinkx Facial Recorgnition').execute()
        print(f"App usage records with 'Shinkx Facial Recorgnition': {len(response.data)}")
        for record in response.data:
            print(f"  - Employee: {record.get('employee_id')}, App: {record.get('app_name')}, Project: {record.get('current_project')}")
    except Exception as e:
        print(f"Error querying app_usage: {e}")
    
    # Test 2: Check web_activity table
    print("\n=== Checking web_activity table ===")
    try:
        response = supabase.table('web_activity').select('*').eq('current_project', 'Shinkx Facial Recorgnition').execute()
        print(f"Web activity records with 'Shinkx Facial Recorgnition': {len(response.data)}")
        for record in response.data:
            print(f"  - Employee: {record.get('employee_id')}, URL: {record.get('url')}, Project: {record.get('current_project')}")
    except Exception as e:
        print(f"Error querying web_activity: {e}")
    
    # Test 3: Check activity_logs table
    print("\n=== Checking activity_logs table ===")
    try:
        response = supabase.table('activity_logs').select('*').not_('metadata', 'is', None).execute()
        print(f"Activity logs with metadata: {len(response.data)}")
        for record in response.data:
            if record.get('metadata', {}).get('current_project') == 'Shinkx Facial Recorgnition':
                print(f"  - Employee: {record.get('employee_id')}, Project: {record.get('metadata', {}).get('current_project')}")
    except Exception as e:
        print(f"Error querying activity_logs: {e}")
    
    # Test 4: Check all app_usage records for the employee
    print("\n=== Checking all app_usage for employee a1ffffc7-3995-4e49-9102-37b6e8702dbb ===")
    try:
        response = supabase.table('app_usage').select('*').eq('employee_id', 'a1ffffc7-3995-4e49-9102-37b6e8702dbb').execute()
        print(f"Total app_usage records for employee: {len(response.data)}")
        for record in response.data:
            print(f"  - App: {record.get('app_name')}, Project: {record.get('current_project')}, Active: {record.get('is_active')}")
    except Exception as e:
        print(f"Error querying app_usage for employee: {e}")
    
    # Test 5: Check projects table
    print("\n=== Checking projects table ===")
    try:
        response = supabase.table('projects').select('*').execute()
        print(f"Total projects: {len(response.data)}")
        for project in response.data:
            print(f"  - Project: {project.get('name')}, Org: {project.get('organization_id')}, Active: {project.get('is_active')}")
    except Exception as e:
        print(f"Error querying projects: {e}")

if __name__ == "__main__":
    test_project_data() 