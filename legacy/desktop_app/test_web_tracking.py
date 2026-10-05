#!/usr/bin/env python3
"""
Test script to verify enhanced web tracking functionality.
"""

import sys
import os
from datetime import datetime, timezone

# Add the current directory to the path so we can import our modules
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from core.activity_tracker import ActivityTracker

def test_web_info_extraction():
    """Test the enhanced web info extraction with various video platforms."""
    
    # Create a temporary activity tracker for testing
    tracker = ActivityTracker("TEST001", None)
    
    # Test cases for different video platforms
    test_cases = [
        # YouTube examples
        ("Amazing Coding Tutorial - YouTube - Google Chrome", "chrome"),
        ("How to Build a React App - Tech Channel - Google Chrome", "chrome"),
        ("Funny Cat Video - Google Chrome", "chrome"),
        
        # Netflix examples
        ("Stranger Things Season 4 - Netflix - Google Chrome", "chrome"),
        ("The Crown - Netflix - Google Chrome", "chrome"),
        
        # Hulu examples
        ("The Handmaid's Tale - Hulu - Google Chrome", "chrome"),
        
        # Disney+ examples
        ("The Mandalorian - Disney+ - Google Chrome", "chrome"),
        
        # Amazon Prime examples
        ("The Boys - Amazon.com - Google Chrome", "chrome"),
        
        # Regular website examples
        ("GitHub - Build software better, together - github.com - Google Chrome", "chrome"),
        ("Stack Overflow - Where Developers Learn, Share, & Build Careers - stackoverflow.com - Google Chrome", "chrome"),
    ]
    
    print("🧪 Testing Enhanced Web Info Extraction")
    print("=" * 60)
    
    for window_title, browser in test_cases:
        url, domain, page_title = tracker._extract_web_info(window_title, browser)
        print(f"Window Title: {window_title}")
        print(f"Extracted - Title: '{page_title}' | Domain: '{domain}' | URL: '{url}'")
        print("-" * 60)
    
    print("✅ Web info extraction test completed!")

def test_web_activity_sync():
    """Test creating a web activity record manually."""
    
    from core.supabase_client import get_supabase_client
    
    # Get the Supabase client
    supabase = get_supabase_client()
    
    # Test employee data
    employee_id = "a1ffffc7-3995-4e49-9102-37b6e8702dbb"
    organization_id = "3fda15c4-bade-4d15-8fbe-80e4ac329194"
    
    # Create test web activity data
    web_data = {
        "employee_id": employee_id,
        "organization_id": organization_id,
        "url": "https://www.youtube.com/watch?v=example",
        "domain": "youtube.com",
        "title": "Amazing Coding Tutorial",
        "duration_seconds": 120,
        "start_time": datetime.now(timezone.utc).isoformat(),
        "is_active": True
    }
    
    print(f"Testing web activity sync with data: {web_data}")
    
    try:
        # Try to create the record directly in the database
        response = supabase.client.table('web_activity').insert(web_data).execute()
        
        if response.data:
            print("✅ Web activity record created successfully!")
            print(f"Created record: {response.data[0]}")
            return True
        else:
            print("❌ Failed to create web activity record - no response data")
            return False
            
    except Exception as e:
        print(f"❌ Error creating web activity record: {e}")
        return False

if __name__ == "__main__":
    print("Testing enhanced web tracking...")
    
    # Test web info extraction
    test_web_info_extraction()
    
    print("\n" + "=" * 60 + "\n")
    
    # Test web activity sync
    success = test_web_activity_sync()
    if success:
        print("✅ All web tracking tests completed successfully!")
    else:
        print("❌ Web activity sync test failed!") 