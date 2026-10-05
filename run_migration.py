#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import sys
import subprocess
from pathlib import Path

def run_migration(migration_file):
    """Run a SQL migration file using psql"""
    try:
        # Get database connection details from environment
        database_url = os.getenv('SUPABASE_DB_URL')
        if not database_url:
            print("❌ SUPABASE_DB_URL environment variable not set")
            return False
        
        # Read the migration file
        migration_path = Path(migration_file)
        if not migration_path.exists():
            print(f"❌ Migration file not found: {migration_file}")
            return False
        
        with open(migration_path, 'r', encoding='utf-8') as f:
            sql_content = f.read()
        
        print(f"📋 Running migration: {migration_file}")
        print(f"📝 SQL content:\n{sql_content}")
        
        # Run the migration using psql
        result = subprocess.run([
            'psql', database_url, '-f', str(migration_path)
        ], capture_output=True, text=True)
        
        if result.returncode == 0:
            print("✅ Migration completed successfully")
            return True
        else:
            print(f"❌ Migration failed with error: {result.stderr}")
            return False
            
    except Exception as e:
        print(f"❌ Error running migration: {e}")
        return False

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python run_migration.py <migration_file.sql>")
        sys.exit(1)
    
    migration_file = sys.argv[1]
    success = run_migration(migration_file)
    sys.exit(0 if success else 1)
