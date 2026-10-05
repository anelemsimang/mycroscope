# Mycroscope - Productivity Tracking System

A complete, production-ready productivity tracking system for corporations to monitor employee activity and generate comprehensive reports.

## 🏗️ Architecture

- **Desktop App (Python)**: Real-time employee activity tracker with auto-launch
- **Mobile App (React Native + Expo)**: Manager dashboard with Supabase integration
- **Backend**: Supabase for real-time data synchronization and authentication

## 📁 Project Structure

```
Mycroscope/
├── desktop_app/          # Python desktop application
├── mobile_app/           # React Native Expo mobile app
├── docs/                 # Documentation and setup guides
└── README.md            # This file
```

## 🚀 Quick Start

### Desktop App Setup
```bash
cd desktop_app
pip install -r requirements.txt
python main.py
```

### Mobile App Setup
```bash
cd mobile_app
npm install
npx expo start
```

## 🔐 Authentication

- Desktop app requires employee ID login
- Mobile app uses Supabase authentication
- Real-time data synchronization

## 📊 Features

- Real-time activity tracking
- Idle time detection
- App usage monitoring
- Project switching
- Offline mode with sync
- PDF report generation
- Manager dashboard
- Employee self-monitoring

## 🛡️ Security

- Encrypted data storage
- Admin-only app disabling
- Secure authentication
- Background thread-safe logging

## 📱 Mobile App Features

- Live employee tracking
- Real-time statistics
- PDF report generation
- Project timeline views
- Manager and employee dashboards

## 🖥️ Desktop App Features

- Auto-launch on startup
- Mandatory employee login
- Real-time activity monitoring
- Offline data storage
- Secure data transmission

## 🔧 Configuration

See individual app directories for detailed setup instructions. 