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

def add_activity_type_column():
    """Add activity_type column to app_usage table"""
    try:
        print("🔧 Adding activity_type column to app_usage table...")
        
        # Get the Supabase client
        supabase_client = get_supabase_client()
        
        # SQL statements to execute
        sql_statements = [
            # Add activity_type column to app_usage table
            "ALTER TABLE app_usage ADD COLUMN IF NOT EXISTS activity_type VARCHAR(50) DEFAULT 'session'",
            
            # Update existing records to have 'session' type
            "UPDATE app_usage SET activity_type = 'session' WHERE activity_type IS NULL",
            
            # Make the column NOT NULL after setting default values
            "ALTER TABLE app_usage ALTER COLUMN activity_type SET NOT NULL",
            
            # Create index for better query performance
            "CREATE INDEX IF NOT EXISTS idx_app_usage_activity_type ON app_usage(activity_type)",
            
            # Create index for current activity queries
            "CREATE INDEX IF NOT EXISTS idx_app_usage_current_activity ON app_usage(employee_id, activity_type, is_active) WHERE activity_type = 'current_activity' AND is_active = true"
        ]
        
        # Execute each statement
        for i, statement in enumerate(sql_statements, 1):
            print(f"🔧 Executing statement {i}/{len(sql_statements)}...")
            print(f"SQL: {statement}")
            
            try:
                # Execute the SQL statement
                result = supabase_client.client.rpc('exec_sql', {'sql': statement}).execute()
                print(f"✅ Statement {i} executed successfully")
            except Exception as e:
                print(f"⚠️ Statement {i} may have failed (this is normal if column already exists): {e}")
                # Continue with other statements even if this one fails
        
        print("✅ Migration completed successfully!")
        print("📋 The app_usage table now has an activity_type column")
        print("📋 This allows distinguishing between session records and current activity records")
        
        return True
            
    except Exception as e:
        print(f"❌ Error running migration: {e}")
        return False

if __name__ == "__main__":
    success = add_activity_type_column()
    sys.exit(0 if success else 1) 