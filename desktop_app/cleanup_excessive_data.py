#!/usr/bin/env python3
"""
Cleanup script to remove excessive app usage records created by the 5-second sync interval.
This script will consolidate multiple short app usage records into fewer, more meaningful records.
"""

import os
import sys
from datetime import datetime, timedelta
from supabase import create_client, Client
from config import SUPABASE_URL, SUPABASE_KEY

def get_supabase_client() -> Client:
    """Get Supabase client."""
    return create_client(SUPABASE_URL, SUPABASE_KEY)

def cleanup_excessive_app_usage():
    """Clean up excessive app usage records."""
    supabase = get_supabase_client()
    
    print("🔍 Starting cleanup of excessive app usage records...")
    
    # Get all app usage records from the last 7 days
    seven_days_ago = (datetime.now() - timedelta(days=7)).isoformat()
    
    print(f"📅 Fetching app usage records from {seven_days_ago} onwards...")
    
    # Get all app usage records
    response = supabase.table('app_usage').select('*').gte('start_time', seven_days_ago).execute()
    
    if not response.data:
        print("✅ No app usage records found to clean up.")
        return
    
    records = response.data
    print(f"📊 Found {len(records)} app usage records to process.")
    
    # Group records by employee, app, and date
    grouped_records = {}
    
    for record in records:
        employee_id = record['employee_id']
        app_name = record['app_name']
        start_date = record['start_time'][:10]  # YYYY-MM-DD
        
        key = (employee_id, app_name, start_date)
        
        if key not in grouped_records:
            grouped_records[key] = []
        
        grouped_records[key].append(record)
    
    print(f"📋 Grouped into {len(grouped_records)} employee-app-date combinations.")
    
    # Process each group
    total_removed = 0
    total_consolidated = 0
    
    for (employee_id, app_name, date), records in grouped_records.items():
        if len(records) <= 1:
            continue  # Skip if only one record
        
        print(f"🔄 Processing {app_name} for employee {employee_id} on {date}: {len(records)} records")
        
        # Sort records by start_time
        records.sort(key=lambda x: x['start_time'])
        
        # Calculate total duration
        total_duration = sum(r.get('duration_seconds', 0) for r in records)
        
        # Create consolidated record
        consolidated_record = {
            'employee_id': employee_id,
            'organization_id': records[0]['organization_id'],
            'session_id': records[0]['session_id'],
            'app_name': app_name,
            'window_title': records[0].get('window_title'),
            'start_time': records[0]['start_time'],
            'end_time': records[-1].get('end_time') or records[-1]['start_time'],
            'duration_seconds': total_duration,
            'is_active': records[-1]['is_active'],
            'created_at': records[0]['created_at']
        }
        
        # Delete all original records
        record_ids = [r['id'] for r in records]
        
        try:
            # Delete the original records
            delete_response = supabase.table('app_usage').delete().in_('id', record_ids).execute()
            
            if delete_response.data:
                total_removed += len(records)
                
                # Insert consolidated record
                insert_response = supabase.table('app_usage').insert(consolidated_record).execute()
                
                if insert_response.data:
                    total_consolidated += 1
                    print(f"  ✅ Consolidated {len(records)} records into 1 (duration: {total_duration}s)")
                else:
                    print(f"  ❌ Failed to insert consolidated record")
            else:
                print(f"  ❌ Failed to delete original records")
                
        except Exception as e:
            print(f"  ❌ Error processing group: {e}")
    
    print(f"\n🎉 Cleanup completed!")
    print(f"📊 Records removed: {total_removed}")
    print(f"📊 Records consolidated: {total_consolidated}")
    print(f"📊 Net reduction: {total_removed - total_consolidated} records")

def cleanup_excessive_web_activity():
    """Clean up excessive web activity records."""
    supabase = get_supabase_client()
    
    print("\n🔍 Starting cleanup of excessive web activity records...")
    
    # Get all web activity records from the last 7 days
    seven_days_ago = (datetime.now() - timedelta(days=7)).isoformat()
    
    print(f"📅 Fetching web activity records from {seven_days_ago} onwards...")
    
    # Get all web activity records
    response = supabase.table('web_activity').select('*').gte('start_time', seven_days_ago).execute()
    
    if not response.data:
        print("✅ No web activity records found to clean up.")
        return
    
    records = response.data
    print(f"📊 Found {len(records)} web activity records to process.")
    
    # Group records by employee, domain, and date
    grouped_records = {}
    
    for record in records:
        employee_id = record['employee_id']
        domain = record.get('domain', 'unknown')
        start_date = record['start_time'][:10]  # YYYY-MM-DD
        
        key = (employee_id, domain, start_date)
        
        if key not in grouped_records:
            grouped_records[key] = []
        
        grouped_records[key].append(record)
    
    print(f"📋 Grouped into {len(grouped_records)} employee-domain-date combinations.")
    
    # Process each group
    total_removed = 0
    total_consolidated = 0
    
    for (employee_id, domain, date), records in grouped_records.items():
        if len(records) <= 1:
            continue  # Skip if only one record
        
        print(f"🔄 Processing {domain} for employee {employee_id} on {date}: {len(records)} records")
        
        # Sort records by start_time
        records.sort(key=lambda x: x['start_time'])
        
        # Calculate total duration
        total_duration = sum(r.get('duration_seconds', 0) for r in records)
        
        # Create consolidated record
        consolidated_record = {
            'employee_id': employee_id,
            'organization_id': records[0]['organization_id'],
            'session_id': records[0]['session_id'],
            'url': records[0]['url'],
            'title': records[0].get('title'),
            'domain': domain,
            'start_time': records[0]['start_time'],
            'end_time': records[-1].get('end_time') or records[-1]['start_time'],
            'duration_seconds': total_duration,
            'is_active': records[-1]['is_active'],
            'created_at': records[0]['created_at']
        }
        
        # Delete all original records
        record_ids = [r['id'] for r in records]
        
        try:
            # Delete the original records
            delete_response = supabase.table('web_activity').delete().in_('id', record_ids).execute()
            
            if delete_response.data:
                total_removed += len(records)
                
                # Insert consolidated record
                insert_response = supabase.table('web_activity').insert(consolidated_record).execute()
                
                if insert_response.data:
                    total_consolidated += 1
                    print(f"  ✅ Consolidated {len(records)} records into 1 (duration: {total_duration}s)")
                else:
                    print(f"  ❌ Failed to insert consolidated record")
            else:
                print(f"  ❌ Failed to delete original records")
                
        except Exception as e:
            print(f"  ❌ Error processing group: {e}")
    
    print(f"\n🎉 Web activity cleanup completed!")
    print(f"📊 Records removed: {total_removed}")
    print(f"📊 Records consolidated: {total_consolidated}")
    print(f"📊 Net reduction: {total_removed - total_consolidated} records")

def main():
    """Main cleanup function."""
    print("🧹 Mycroscope Data Cleanup Script")
    print("=" * 50)
    
    try:
        # Clean up app usage records
        cleanup_excessive_app_usage()
        
        # Clean up web activity records
        cleanup_excessive_web_activity()
        
        print("\n✅ All cleanup operations completed successfully!")
        
    except Exception as e:
        print(f"\n❌ Error during cleanup: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main() 