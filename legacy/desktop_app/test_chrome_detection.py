#!/usr/bin/env python3
"""
Test script to check if Chrome is being detected as a foreground window.
"""

import win32gui
import win32process
import psutil
import time

def test_chrome_detection():
    """Test if Chrome is being detected as the foreground window."""
    
    print("🔍 Testing Chrome Detection")
    print("=" * 50)
    
    for i in range(10):  # Check 10 times
        try:
            # Get foreground window
            hwnd = win32gui.GetForegroundWindow()
            window_title = win32gui.GetWindowText(hwnd)
            
            # Get process info
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            if pid:
                process = psutil.Process(pid)
                app_name = process.name()
                
                print(f"Time {i+1}:")
                print(f"  Window Title: {window_title}")
                print(f"  Process Name: {app_name}")
                print(f"  PID: {pid}")
                
                # Check if it's Chrome
                if 'chrome' in app_name.lower():
                    print("  ✅ Chrome detected!")
                    
                    # Check if it's a browser window
                    browser_detected = False
                    browser_name = None
                    
                    for browser in ['chrome', 'firefox', 'edge', 'safari']:
                        if browser in window_title.lower():
                            browser_detected = True
                            browser_name = browser
                            break
                    
                    if browser_detected:
                        print(f"  ✅ Browser window detected: {browser_name}")
                    else:
                        print("  ❌ Not detected as browser window")
                else:
                    print("  ❌ Not Chrome")
                
                print("-" * 30)
            
        except Exception as e:
            print(f"Error: {e}")
        
        time.sleep(2)  # Wait 2 seconds between checks
    
    print("✅ Chrome detection test completed!")

if __name__ == "__main__":
    print("Please open Chrome and navigate to a website, then run this test.")
    input("Press Enter when ready...")
    test_chrome_detection() 