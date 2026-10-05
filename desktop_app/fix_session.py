#!/usr/bin/env python3
import re

def fix_session_creation():
    with open('main.py', 'r') as f:
        content = f.read()
    
    # Add session creation after employee authentication
    content = re.sub(
        r'(employee = supabase_client\.authenticate_employee\(emp_id, pwd\)\n\s+if employee:\n\s+self\.logged_in = True\n\s+self\.root\.withdraw\(\)\n\s+self\._start_tracking\(emp_id\))',
        r'''employee = supabase_client.authenticate_employee(emp_id, pwd)
        if employee:
            # Create session for the employee
            session_token = supabase_client.create_session(employee['id'], employee['organization_id'])
            if session_token:
                self.logged_in = True
                self.root.withdraw()
                self._start_tracking(emp_id)
            else:
                messagebox.showerror("Login Failed", "Failed to create session.")''',
        content
    )
    
    with open('main.py', 'w') as f:
        f.write(content)
    
    print("Added session creation to login flow!")

if __name__ == "__main__":
    fix_session_creation() 