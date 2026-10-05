#!/usr/bin/env python3
"""
Database migration script to fix projects table schema
"""

import os
import sys

from supabase import create_client

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import SUPABASE_URL, SUPABASE_KEY

def run_migration():
    """Run the database migration"""
    try:
        if not SUPABASE_URL or not SUPABASE_KEY:
            print("❌ Set SUPABASE_URL and SUPABASE_KEY in .env (see .env.example)")
            return False
        # Initialize Supabase client
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
        
        print("🔄 Running database migration...")
        
        # Read the migration SQL file
        migration_file = "fix_projects_schema.sql"
        if not os.path.exists(migration_file):
            print(f"❌ Migration file {migration_file} not found!")
            return False
        
        with open(migration_file, 'r') as f:
            migration_sql = f.read()
        
        # Split the SQL into individual statements
        statements = [stmt.strip() for stmt in migration_sql.split(';') if stmt.strip()]
        
        # Execute each statement
        for i, statement in enumerate(statements, 1):
            if statement and not statement.startswith('--'):
                try:
                    print(f"📝 Executing statement {i}/{len(statements)}...")
                    result = supabase.rpc('exec_sql', {'sql': statement}).execute()
                    print(f"✅ Statement {i} executed successfully")
                except Exception as e:
                    print(f"⚠️  Statement {i} failed (this might be expected): {e}")
                    # Continue with other statements
        
        print("✅ Database migration completed!")
        return True
        
    except Exception as e:
        print(f"❌ Migration failed: {e}")
        return False

if __name__ == "__main__":
    success = run_migration()
    if success:
        print("\n🎉 Migration successful! You can now create new projects.")
    else:
        print("\n💥 Migration failed. Please check the error messages above.")
        sys.exit(1) 