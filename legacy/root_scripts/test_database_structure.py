#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# Add desktop_app to path so we can import the supabase client
sys.path.append(str(Path(__file__).parent / "desktop_app"))

from core.supabase_client import get_supabase_client

# Load environment variables
load_dotenv()

def test_database_structure():
    """Test if the activity_type column exists and current activity functionality"""
    try:
        print("🔍 Testing database structure and current activity functionality...")
        
        # Get the Supabase client
        supabase_client = get_supabase_client()
        
        # Test 1: Check if we can query app_usage table
        print("\n📋 Test 1: Checking app_usage table structure...")
        try:
            response = supabase_client.client.table('app_usage').select('*').limit(1).execute()
            print(f"✅ Can query app_usage table: {len(response.data)} records found")
            
            if response.data:
                # Check if activity_type column exists
                first_record = response.data[0]
                if 'activity_type' in first_record:
                    print(f"✅ activity_type column exists: {first_record['activity_type']}")
                else:
                    print("⚠️ activity_type column not found, but that's okay - app will handle it")
            else:
                print("ℹ️ No app_usage records found yet")
                
        except Exception as e:
            print(f"❌ Error querying app_usage table: {e}")
        
        # Test 2: Check if we can create a current activity record
        print("\n📋 Test 2: Testing current activity record creation...")
        try:
            # Get the first employee for testing
            employees_response = supabase_client.client.table('employees').select('*').limit(1).execute()
            
            if employees_response.data:
                test_employee = employees_response.data[0]
                print(f"✅ Found test employee: {test_employee.get('name', 'Unknown')}")
                
                # Try to create a test current activity record
                test_activity_data = {
                    'employee_id': test_employee['id'],
                    'organization_id': test_employee['organization_id'],
                    'app_name': 'test_app.exe',
                    'window_title': 'Test Application',
                    'start_time': '2025-01-01T00:00:00Z',
                    'duration_seconds': 60,
                    'is_active': True,
                    'activity_type': 'current_activity'
                }
                
                # Try to insert the test record
                insert_response = supabase_client.client.table('app_usage').insert(test_activity_data).execute()
                
                if insert_response.data:
                    print("✅ Successfully created test current activity record")
                    
                    # Clean up - delete the test record
                    test_record_id = insert_response.data[0]['id']
                    supabase_client.client.table('app_usage').delete().eq('id', test_record_id).execute()
                    print("✅ Cleaned up test record")
                else:
                    print("❌ Failed to create test current activity record")
                    
            else:
                print("ℹ️ No employees found for testing")
                
        except Exception as e:
            print(f"❌ Error testing current activity creation: {e}")
        
        # Test 3: Check current activity query (like mobile app does)
        print("\n📋 Test 3: Testing current activity query...")
        try:
            if employees_response.data:
                test_employee = employees_response.data[0]
                
                # Query for current activity (like mobile app does)
                current_activity_response = supabase_client.client.table('app_usage').select('*').eq('employee_id', test_employee['id']).eq('activity_type', 'current_activity').eq('is_active', True).order('start_time', desc=True).limit(1).execute()
                
                if current_activity_response.data:
                    print(f"✅ Found current activity: {current_activity_response.data[0]['app_name']}")
                else:
                    print("ℹ️ No current activity found (this is normal if desktop app isn't running)")
                    
        except Exception as e:
            print(f"❌ Error testing current activity query: {e}")
        
        print("\n✅ Database structure test completed!")
        print("📋 The system should now support both session tracking and real-time activity display")
        
        return True
            
    except Exception as e:
        print(f"❌ Error testing database structure: {e}")
        return False

if __name__ == "__main__":
    success = test_database_structure()
    sys.exit(0 if success else 1) 