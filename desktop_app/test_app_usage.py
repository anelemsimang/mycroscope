#!/usr/bin/env python3
"""
Test script to manually create an app usage record in the database.
"""

import sys
import os
from datetime import datetime, timezone

# Add the current directory to the path so we can import our modules
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from core.supabase_client import get_supabase_client

def test_app_usage_sync():
    """Test creating an app usage record manually."""
    
    # Get the Supabase client
    supabase = get_supabase_client()
    
    # Test employee data (you'll need to replace with actual values)
    employee_id = "a1ffffc7-3995-4e49-9102-37b6e8702dbb"  # From the logs
    organization_id = "3fda15c4-bade-4d15-8fbe-80e4ac329194"  # From the logs
    
    # Create test app usage data
    app_data = {
        "employee_id": employee_id,
        "organization_id": organization_id,
        "app_name": "test_app.exe",
        "duration_seconds": 60,
        "start_time": datetime.now(timezone.utc).isoformat(),
        "is_active": True
    }
    
    print(f"Testing app usage sync with data: {app_data}")
    
    try:
        # Try to create the record directly in the database
        response = supabase.client.table('app_usage').insert(app_data).execute()
        
        if response.data:
            print("✅ App usage record created successfully!")
            print(f"Created record: {response.data[0]}")
            return True
        else:
            print("❌ Failed to create app usage record - no response data")
            return False
            
    except Exception as e:
        print(f"❌ Error creating app usage record: {e}")
        return False

if __name__ == "__main__":
    print("Testing app usage sync...")
    success = test_app_usage_sync()
    if success:
        print("Test completed successfully!")
    else:
        print("Test failed!") 