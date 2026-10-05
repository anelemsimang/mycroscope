#!/usr/bin/env python3
# NOT SQL — do not paste this file into the Supabase SQL editor.
# Run locally: python fix_schema_simple.py   (uses desktop_app/.env)
"""
Verify expected Supabase tables/columns (read-only). No test data is inserted.
"""

import os
import socket
import sys
from typing import Optional
from urllib.parse import urlparse

from supabase import create_client
import logging

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import SUPABASE_URL, SUPABASE_KEY


def _is_dns_or_network_error(exc: BaseException) -> bool:
    """True if failure is likely DNS / connectivity, not missing DB columns."""
    seen: set[int] = set()
    e: Optional[BaseException] = exc
    while e is not None and id(e) not in seen:
        seen.add(id(e))
        if isinstance(e, socket.gaierror):
            return True
        errno = getattr(e, "errno", None)
        if errno in (11001, 11002):  # Windows: host not found / non-authoritative host
            return True
        text = str(e).lower()
        if "getaddrinfo" in text or "name or service not known" in text or "failed to resolve" in text:
            return True
        e = getattr(e, "__cause__", None) or getattr(e, "original_error", None)
    return False

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def fix_schema():
    """Fix the projects table schema"""
    try:
        if not SUPABASE_URL or not SUPABASE_KEY:
            print("❌ Set SUPABASE_URL and SUPABASE_KEY in .env (see .env.example)")
            return False

        parsed = urlparse(SUPABASE_URL)
        if parsed.scheme not in ("https", "http") or not parsed.hostname:
            print("❌ SUPABASE_URL should look like: https://YOUR_REF.supabase.co")
            print(f"   Current value parses as host: {parsed.hostname!r}")
            return False

        # Initialize Supabase client
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

        print("🔄 Checking database schema (read-only)...")

        try:
            # Validates table + columns exist; empty database is fine.
            supabase.table("projects").select("id, organization_id, name, created_by, is_active").limit(1).execute()
            supabase.table("app_usage").select("id, current_project").limit(1).execute()
            supabase.table("web_activity").select("id, current_project").limit(1).execute()
            print("✅ Schema looks correct (projects, app_usage, web_activity).")
        except Exception as e:
            print(f"❌ Request failed: {e}")
            if _is_dns_or_network_error(e):
                host = parsed.hostname or "(could not parse host)"
                print("\n⚠️  This looks like a network/DNS problem (not a missing SQL column).")
                print(f"   Host from SUPABASE_URL: {host}")
                print("   • Copy Project URL again from Supabase → Project Settings → API (no spaces or quotes).")
                print("   • Check internet / VPN / firewall; try opening the URL in a browser.")
                return False
            print("\n🔧 If tables are missing, apply supabase/migrations/ in the SQL editor, or add columns:")
            print("\n" + "=" * 50)
            print(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES employees(id) ON DELETE SET NULL;"
            )
            print("ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;")
            print("ALTER TABLE app_usage ADD COLUMN IF NOT EXISTS current_project VARCHAR(255);")
            print("ALTER TABLE web_activity ADD COLUMN IF NOT EXISTS current_project VARCHAR(255);")
            print("=" * 50)
            return False
        
        return True
        
    except Exception as e:
        print(f"❌ Schema check failed: {e}")
        return False

if __name__ == "__main__":
    success = fix_schema()
    if success:
        print("\n🎉 Schema is correct! You can now create new projects.")
    else:
        print("\n💥 Fix the issue above, then run this script again.") 