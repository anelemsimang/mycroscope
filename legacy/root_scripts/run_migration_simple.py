#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client, Client

# Load environment variables from .env file
load_dotenv()

def run_migration(migration_file):
    """Run a SQL migration file using Supabase client"""
    try:
        # Get database connection details from environment (same as desktop app)
        supabase_url = os.getenv('SUPABASE_URL')
        supabase_key = os.getenv('SUPABASE_KEY')
        
        if not supabase_url or not supabase_key:
            print("❌ SUPABASE_URL or SUPABASE_KEY environment variables not set")
            print("Please check your .env file or environment variables")
            return False
        
        # Create Supabase client
        supabase: Client = create_client(supabase_url, supabase_key)
        
        # Read the migration file
        migration_path = Path(migration_file)
        if not migration_path.exists():
            print(f"❌ Migration file not found: {migration_file}")
            return False
        
        with open(migration_path, 'r', encoding='utf-8') as f:
            sql_content = f.read()
        
        print(f"📋 Running migration: {migration_file}")
        print(f"🔗 Database: {supabase_url}")
        print(f"📝 SQL content:\n{sql_content}")
        
        # Split SQL into individual statements
        sql_statements = [stmt.strip() for stmt in sql_content.split(';') if stmt.strip()]
        
        # Execute each statement
        for i, statement in enumerate(sql_statements, 1):
            if statement:
                print(f"🔧 Executing statement {i}/{len(sql_statements)}...")
                try:
                    # Use rpc to execute raw SQL
                    result = supabase.rpc('exec_sql', {'sql': statement}).execute()
                    print(f"✅ Statement {i} executed successfully")
                except Exception as e:
                    print(f"❌ Statement {i} failed: {e}")
                    return False
        
        print("✅ Migration completed successfully")
        return True
            
    except Exception as e:
        print(f"❌ Error running migration: {e}")
        return False

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python run_migration_simple.py <migration_file.sql>")
        sys.exit(1)
    
    migration_file = sys.argv[1]
    success = run_migration(migration_file)
    sys.exit(0 if success else 1) 