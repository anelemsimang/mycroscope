#!/usr/bin/env python3
"""
Test script to demonstrate the new app session logic.
"""

from datetime import datetime, timedelta

def simulate_app_sessions():
    """Simulate how the new app session logic works."""
    
    print("🎯 App Session Logic Demo")
    print("=" * 50)
    
    # Simulate a typical workday
    scenarios = [
        {
            "time": "9:00 AM",
            "action": "Open Chrome",
            "result": "Session 1 started"
        },
        {
            "time": "9:15 AM", 
            "action": "Alt+Tab to Word",
            "result": "Still Session 1 (Chrome minimized)"
        },
        {
            "time": "9:30 AM",
            "action": "Close Chrome",
            "result": "Session 1 ended (2h 30m)"
        },
        {
            "time": "10:00 AM",
            "action": "Open Chrome again",
            "result": "Session 2 started"
        },
        {
            "time": "10:30 AM",
            "action": "Close Chrome",
            "result": "Session 2 ended (30m)"
        },
        {
            "time": "11:00 AM",
            "action": "Open Chrome third time",
            "result": "Session 3 started"
        }
    ]
    
    print("📅 Typical Workday Scenario:")
    print()
    
    for scenario in scenarios:
        print(f"🕐 {scenario['time']}: {scenario['action']}")
        print(f"   → {scenario['result']}")
        print()
    
    print("📊 Summary:")
    print("   • Chrome opened 3 times = 3 sessions")
    print("   • Minimizing doesn't end session")
    print("   • Only closing ends the session")
    print("   • Each session has clear start/end times")
    print()
    print("✅ This is much more intuitive than time-based sessions!")

if __name__ == "__main__":
    simulate_app_sessions() 