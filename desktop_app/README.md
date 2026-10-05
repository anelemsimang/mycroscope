# Mycroscope Desktop App Setup

## 🚀 Quick Start (For Non-Coders)

### Step 1: Install Python
- Download Python from https://python.org
- Make sure to check "Add Python to PATH" during installation

### Step 2: Install Dependencies
Open Command Prompt/PowerShell in this folder and run:
```bash
pip install -r requirements.txt
```

### Step 3: Set Up Environment
1. Copy `env_example.txt` and rename it to `.env`
2. Edit `.env` and replace the placeholder values:
   - `SUPABASE_URL`: Your Supabase project URL
   - `SUPABASE_KEY`: Your Supabase anon key
   - `ENCRYPTION_KEY`: Any 32-character string for security
   - `ADMIN_PASSWORD`: Password for admin access

### Step 4: Run the App
```bash
python main.py
```

## 🔧 What Each Setting Does

- **SUPABASE_URL**: Where your data is stored (like a cloud database)
- **SUPABASE_KEY**: Password to access your data
- **ENCRYPTION_KEY**: Keeps your data secure (can be any 32 characters)
- **ADMIN_PASSWORD**: Password to disable the app (default: admin123)

## 🛡️ Security Features

- **Auto-launch**: Starts when computer boots
- **Login required**: Must log in before using computer
- **Admin protection**: Only admins can disable the app
- **Encrypted data**: All data is encrypted locally

## 📁 File Structure

```
desktop_app/
├── main.py              # Main application
├── config.py            # Settings and configuration
├── requirements.txt     # Python packages needed
├── .env                 # Your credentials (create this)
├── env_example.txt      # Example credentials
├── core/                # Core tracking features
├── utils/               # Utilities and helpers
└── data/                # Local data storage
```

## ❓ Common Issues

**"Module not found" error**: Run `pip install -r requirements.txt`

**"Permission denied"**: Run Command Prompt as Administrator

**"Supabase connection failed"**: Check your URL and key in `.env`

## 🔐 Getting Supabase Credentials

1. Go to https://supabase.com
2. Create a new project
3. Go to Settings > API
4. Copy the URL and anon key to your `.env` file 