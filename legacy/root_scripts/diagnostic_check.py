#!/usr/bin/env python3
"""
Mycroscope Data Synchronization Diagnostic
This script checks the data flow between Desktop App, Mobile App, and Admin Dashboard
"""

import requests
import json
from datetime import datetime, timedelta
from supabase import create_client

# Supabase configuration
SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co"
SUPABASE_KEY = "REDACTED_SUPABASE_KEY"

# Initialize Supabase client
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

def check_organizations():
    """Check what organizations exist in the database"""
    print("🔍 CHECKING ORGANIZATIONS...")
    try:
        response = supabase.table('organizations').select('*').execute()
        if response.data:
            print(f"✅ Found {len(response.data)} organizations:")
            for org in response.data:
                print(f"   - {org['name']} (ID: {org['id']})")
            return response.data
        else:
            print("❌ No organizations found")
            return []
    except Exception as e:
        print(f"❌ Error checking organizations: {e}")
        return []

def check_employees():
    """Check what employees exist and their organizations"""
    print("\n👥 CHECKING EMPLOYEES...")
    try:
        response = supabase.table('employees').select('*').execute()
        if response.data:
            print(f"✅ Found {len(response.data)} employees:")
            for emp in response.data:
                print(f"   - {emp['name']} ({emp['email']}) - Org: {emp['organization_id']}")
            return response.data
        else:
            print("❌ No employees found")
            return []
    except Exception as e:
        print(f"❌ Error checking employees: {e}")
        return []

def check_activity_data(organization_id=None):
    """Check recent activity data"""
    print(f"\n📊 CHECKING ACTIVITY DATA...")
    try:
        query = supabase.table('activity_logs').select('*').order('timestamp', desc=True).limit(10)
        if organization_id:
            query = query.eq('organization_id', organization_id)
        
        response = query.execute()
        if response.data:
            print(f"✅ Found {len(response.data)} recent activity logs:")
            for activity in response.data:
                print(f"   - {activity['activity_type']} by {activity['employee_id']} at {activity['timestamp']}")
            return response.data
        else:
            print("❌ No activity logs found")
            return []
    except Exception as e:
        print(f"❌ Error checking activity data: {e}")
        return []

def check_app_usage(organization_id=None):
    """Check recent app usage data"""
    print(f"\n💻 CHECKING APP USAGE DATA...")
    try:
        query = supabase.table('app_usage').select('*').order('start_time', desc=True).limit(10)
        if organization_id:
            query = query.eq('organization_id', organization_id)
        
        response = query.execute()
        if response.data:
            print(f"✅ Found {len(response.data)} recent app usage records:")
            for usage in response.data:
                print(f"   - {usage['app_name']} by {usage['employee_id']} for {usage['duration_seconds']}s")
            return response.data
        else:
            print("❌ No app usage data found")
            return []
    except Exception as e:
        print(f"❌ Error checking app usage: {e}")
        return []

def check_web_activity(organization_id=None):
    """Check recent web activity data"""
    print(f"\n🌐 CHECKING WEB ACTIVITY DATA...")
    try:
        query = supabase.table('web_activity').select('*').order('start_time', desc=True).limit(10)
        if organization_id:
            query = query.eq('organization_id', organization_id)
        
        response = query.execute()
        if response.data:
            print(f"✅ Found {len(response.data)} recent web activity records:")
            for web in response.data:
                print(f"   - {web['url']} by {web['employee_id']} for {web['duration_seconds']}s")
            return response.data
        else:
            print("❌ No web activity data found")
            return []
    except Exception as e:
        print(f"❌ Error checking web activity: {e}")
        return []

def check_sessions(organization_id=None):
    """Check active sessions"""
    print(f"\n🔐 CHECKING ACTIVE SESSIONS...")
    try:
        query = supabase.table('sessions').select('*').eq('is_active', True)
        if organization_id:
            query = query.eq('organization_id', organization_id)
        
        response = query.execute()
        if response.data:
            print(f"✅ Found {len(response.data)} active sessions:")
            for session in response.data:
                print(f"   - Employee: {session['employee_id']} since {session['login_time']}")
            return response.data
        else:
            print("❌ No active sessions found")
            return []
    except Exception as e:
        print(f"❌ Error checking sessions: {e}")
        return []

def check_mobile_user_organization():
    """Check the mobile app user's organization"""
    print(f"\n📱 CHECKING MOBILE APP USER...")
    try:
        # Look for Anele Msimang
        response = supabase.table('employees').select('*').eq('email', 'anelemsimang@shinkx.com').execute()
        if response.data:
            user = response.data[0]
            print(f"✅ Mobile user found: {user['name']} (ID: {user['id']})")
            print(f"   Organization ID: {user['organization_id']}")
            return user['organization_id']
        else:
            print("❌ Mobile user not found")
            return None
    except Exception as e:
        print(f"❌ Error checking mobile user: {e}")
        return None

def check_desktop_user_organization():
    """Check the desktop app user's organization"""
    print(f"\n🖥️ CHECKING DESKTOP APP USER...")
    try:
        # Look for SHI5818 employee
        response = supabase.table('employees').select('*').eq('employee_id', 'SHI5818').execute()
        if response.data:
            user = response.data[0]
            print(f"✅ Desktop user found: {user['name']} (ID: {user['id']})")
            print(f"   Organization ID: {user['organization_id']}")
            return user['organization_id']
        else:
            print("❌ Desktop user not found")
            return None
    except Exception as e:
        print(f"❌ Error checking desktop user: {e}")
        return None

def main():
    """Run the complete diagnostic"""
    print("🚀 MYCOSCOPE DATA SYNCHRONIZATION DIAGNOSTIC")
    print("=" * 50)
    
    # Check organizations
    organizations = check_organizations()
    
    # Check employees
    employees = check_employees()
    
    # Check mobile and desktop users
    mobile_org = check_mobile_user_organization()
    desktop_org = check_desktop_user_organization()
    
    # Check data for both organizations
    if mobile_org:
        print(f"\n📊 DATA FOR MOBILE USER ORGANIZATION ({mobile_org}):")
        check_activity_data(mobile_org)
        check_app_usage(mobile_org)
        check_web_activity(mobile_org)
        check_sessions(mobile_org)
    
    if desktop_org:
        print(f"\n📊 DATA FOR DESKTOP USER ORGANIZATION ({desktop_org}):")
        check_activity_data(desktop_org)
        check_app_usage(desktop_org)
        check_web_activity(desktop_org)
        check_sessions(desktop_org)
    
    # Check overall data
    print(f"\n📊 OVERALL DATA (ALL ORGANIZATIONS):")
    check_activity_data()
    check_app_usage()
    check_web_activity()
    check_sessions()
    
    # Summary
    print(f"\n🎯 DIAGNOSTIC SUMMARY:")
    print(f"   Mobile User Org: {mobile_org}")
    print(f"   Desktop User Org: {desktop_org}")
    print(f"   Organizations Match: {'✅ YES' if mobile_org == desktop_org else '❌ NO'}")
    
    if mobile_org != desktop_org:
        print(f"\n🚨 ISSUE IDENTIFIED: Organization mismatch!")
        print(f"   - Mobile app user is in organization: {mobile_org}")
        print(f"   - Desktop app user is in organization: {desktop_org}")
        print(f"   - This is why the mobile app can't see the desktop app's data!")
    else:
        print(f"\n✅ Organizations match - data should be visible!")

if __name__ == "__main__":
    main() 