#!/usr/bin/env python3
"""
Script to restart the Mycroscope desktop app.
"""

import subprocess
import time
import sys
import os

def restart_desktop_app():
    """Restart the desktop app by killing the current process and starting a new one."""
    
    print("🔄 Restarting Mycroscope desktop app...")
    
    try:
        # Kill any existing Python processes running main.py
        print("Stopping current desktop app...")
        subprocess.run(["taskkill", "/f", "/im", "python.exe"], capture_output=True)
        
        # Wait a moment for the process to fully stop
        time.sleep(2)
        
        # Start the desktop app again
        print("Starting new desktop app...")
        subprocess.Popen([sys.executable, "main.py"], 
                        cwd=os.path.dirname(os.path.abspath(__file__)),
                        creationflags=subprocess.CREATE_NEW_CONSOLE)
        
        print("✅ Desktop app restarted successfully!")
        print("Please log in again with your employee credentials.")
        
    except Exception as e:
        print(f"❌ Error restarting desktop app: {e}")

if __name__ == "__main__":
    restart_desktop_app() 