#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from supabase import create_client, Client

def check_database_data():
    """Check what data exists in the database and if it has project information"""
    try:
        # Supabase credentials
        supabase_url = "https://YOUR_PROJECT_REF.supabase.co"
        supabase_key = "REDACTED_SUPABASE_KEY"
        
        # Create Supabase client
        supabase: Client = create_client(supabase_url, supabase_key)
        
        print("🔍 Checking database data...")
        
        # Check app_usage data
        print("\n📱 APP_USAGE TABLE:")
        app_usage_result = supabase.table('app_usage').select('*').limit(5).execute()
        if app_usage_result.data:
            print(f"Found {len(app_usage_result.data)} app usage records")
            for record in app_usage_result.data:
                print(f"App: {record.get('app_name')}, Project: {record.get('current_project')}")
        else:
            print("No app usage records found")
        
        # Check web_activity data
        print("\n🌐 WEB_ACTIVITY TABLE:")
        web_activity_result = supabase.table('web_activity').select('*').limit(5).execute()
        if web_activity_result.data:
            print(f"Found {len(web_activity_result.data)} web activity records")
            for record in web_activity_result.data:
                print(f"URL: {record.get('url')}, Project: {record.get('current_project')}")
        else:
            print("No web activity records found")
        
        # Check what projects exist
        print("\n📋 PROJECT ANALYSIS:")
        app_projects = set()
        web_projects = set()
        
        # Get all app usage projects
        all_app_usage = supabase.table('app_usage').select('current_project').execute()
        if all_app_usage.data:
            for record in all_app_usage.data:
                project = record.get('current_project')
                if project:
                    app_projects.add(project)
        
        # Get all web activity projects
        all_web_activity = supabase.table('web_activity').select('current_project').execute()
        if all_web_activity.data:
            for record in all_web_activity.data:
                project = record.get('current_project')
                if project:
                    web_projects.add(project)
        
        print(f"Projects in app_usage: {list(app_projects)}")
        print(f"Projects in web_activity: {list(web_projects)}")
        
        # Check for NULL/empty project values
        null_app_count = 0
        null_web_count = 0
        
        if all_app_usage.data:
            null_app_count = sum(1 for record in all_app_usage.data if not record.get('current_project'))
        
        if all_web_activity.data:
            null_web_count = sum(1 for record in all_web_activity.data if not record.get('current_project'))
        
        print(f"Records with NULL/empty project in app_usage: {null_app_count}")
        print(f"Records with NULL/empty project in web_activity: {null_web_count}")
        
        print("\n📋 SUMMARY:")
        if not app_projects and not web_projects:
            print("❌ No project data found in database")
            print("💡 All existing records have NULL/empty project values")
            print("💡 New data from desktop app will have project information")
        else:
            print("✅ Project data found in database")
            print("💡 Some records have project information")
        
        return True
            
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

if __name__ == "__main__":
    success = check_database_data()
    exit(0 if success else 1) 