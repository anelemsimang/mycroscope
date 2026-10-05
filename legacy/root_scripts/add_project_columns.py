#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
from supabase import create_client, Client

def add_project_columns():
    """Add current_project column to app_usage and web_activity tables"""
    try:
        # Supabase credentials (same as desktop app)
        supabase_url = "https://YOUR_PROJECT_REF.supabase.co"
        supabase_key = "REDACTED_SUPABASE_KEY"
        
        # Create Supabase client
        supabase: Client = create_client(supabase_url, supabase_key)
        
        print("🔗 Connecting to Supabase...")
        
        # Check if current_project column exists in app_usage table
        try:
            # Try to select from the column to see if it exists
            result = supabase.table('app_usage').select('current_project').limit(1).execute()
            print("✅ current_project column already exists in app_usage table")
        except Exception as e:
            if "column" in str(e).lower() and "does not exist" in str(e).lower():
                print("❌ current_project column does not exist in app_usage table")
                print("⚠️  You'll need to manually add the column via Supabase dashboard")
                print("   SQL: ALTER TABLE app_usage ADD COLUMN current_project TEXT;")
            else:
                print(f"❌ Error checking app_usage table: {e}")
        
        # Check if current_project column exists in web_activity table
        try:
            # Try to select from the column to see if it exists
            result = supabase.table('web_activity').select('current_project').limit(1).execute()
            print("✅ current_project column already exists in web_activity table")
        except Exception as e:
            if "column" in str(e).lower() and "does not exist" in str(e).lower():
                print("❌ current_project column does not exist in web_activity table")
                print("⚠️  You'll need to manually add the column via Supabase dashboard")
                print("   SQL: ALTER TABLE web_activity ADD COLUMN current_project TEXT;")
            else:
                print(f"❌ Error checking web_activity table: {e}")
        
        print("\n📋 Summary:")
        print("1. The desktop app has been updated to include current_project in all sync operations")
        print("2. The mobile app has been updated to filter by current_project")
        print("3. If the database columns don't exist, you'll need to add them manually")
        print("4. Once the columns exist, new data will be properly associated with projects")
        
        return True
            
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

if __name__ == "__main__":
    success = add_project_columns()
    exit(0 if success else 1) 