# Mobile App Registration Guide

## How to Register Employees Using Admin Dashboard Credentials

### Step 1: Get Your Organization Credentials
1. Open your **Admin Dashboard** (http://localhost:3000)
2. Go to the **Organizations** tab
3. Find your organization in the table
4. Copy the **Organization Name** and **Secret Key**

### Step 2: Use the Mobile App
1. Open the **Mycroscope Mobile App**
2. Navigate to **Employee Registration**
3. Enter your organization details:
   - **Organization Name**: (from admin dashboard)
   - **Secret Key**: (from admin dashboard)
4. Tap **"Verify Organization"**
5. Once verified, you can register employees

### Step 3: Register Employees
1. After organization verification, fill in employee details:
   - **Full Name**: Employee's full name
   - **Email**: Employee's email address
   - **Password**: Generate or enter a password
   - **Department**: Select from dropdown
   - **Role**: Employee, Manager, or Admin
2. Tap **"Register Employee"**
3. The employee will receive their login credentials

### Step 4: Employee Login
Employees can now login to the **Desktop App** using:
- **Email**: (the email you registered)
- **Password**: (the password you set)

### Security Features
- ✅ **Secret Key Validation**: Only authorized organizations can register employees
- ✅ **Organization Verification**: Ensures employees are linked to the correct organization
- ✅ **Active Status Check**: Only active organizations can register employees
- ✅ **Unique Employee IDs**: Auto-generated to prevent conflicts

### Troubleshooting
- **"Invalid organization name or secret key"**: Double-check the credentials from your admin dashboard
- **"Organization not found"**: Make sure the organization is active in the admin dashboard
- **"Employee ID already exists"**: The app will auto-generate a new ID, just try again

### Example Credentials
From your admin dashboard, you might see:
- **Organization Name**: "Acme Corporation"
- **Secret Key**: "acme_2024_secret_key_12345"

Use these exact values in the mobile app registration form. 