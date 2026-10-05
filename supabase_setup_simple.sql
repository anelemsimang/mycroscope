-- Mycroscope Database Setup (Simplified)
-- Run these commands in your Supabase SQL Editor

-- Create employees table with organization support
CREATE TABLE IF NOT EXISTS employees (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    department VARCHAR(100),
    role VARCHAR(20) DEFAULT 'employee' CHECK (role IN ('employee', 'manager', 'admin')),
    organization VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create activity_logs table with organization support
CREATE TABLE IF NOT EXISTS activity_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL,
    organization VARCHAR(255) NOT NULL,
    activity_type VARCHAR(100) NOT NULL,
    details JSONB,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create sessions table with organization support
CREATE TABLE IF NOT EXISTS sessions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL,
    organization VARCHAR(255) NOT NULL,
    login_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    logout_time TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT true,
    current_project VARCHAR(100) DEFAULT 'Default',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create app_usage table with organization support
CREATE TABLE IF NOT EXISTS app_usage (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL,
    organization VARCHAR(255) NOT NULL,
    app_name VARCHAR(255) NOT NULL,
    duration_seconds INTEGER NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create web_activity table with organization support
CREATE TABLE IF NOT EXISTS web_activity (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL,
    organization VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_employees_organization ON employees(organization);
CREATE INDEX IF NOT EXISTS idx_activity_logs_organization ON activity_logs(organization);
CREATE INDEX IF NOT EXISTS idx_activity_logs_employee_id ON activity_logs(employee_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_timestamp ON activity_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_organization ON sessions(organization);
CREATE INDEX IF NOT EXISTS idx_sessions_employee_id ON sessions(employee_id);
CREATE INDEX IF NOT EXISTS idx_sessions_is_active ON sessions(is_active);
CREATE INDEX IF NOT EXISTS idx_app_usage_organization ON app_usage(organization);
CREATE INDEX IF NOT EXISTS idx_app_usage_employee_id ON app_usage(employee_id);
CREATE INDEX IF NOT EXISTS idx_web_activity_organization ON web_activity(organization);
CREATE INDEX IF NOT EXISTS idx_web_activity_employee_id ON web_activity(employee_id);

-- Insert sample data for testing (with organization field)
INSERT INTO employees (employee_id, name, email, password, department, role, organization) VALUES
('EMP001', 'John Manager', 'john.manager@company.com', 'password123', 'Management', 'manager', 'TechCorp'),
('EMP002', 'Sarah Employee', 'sarah.employee@company.com', 'password123', 'Engineering', 'employee', 'TechCorp'),
('EMP003', 'Mike Admin', 'mike.admin@company.com', 'password123', 'IT', 'admin', 'TechCorp')
ON CONFLICT (employee_id) DO NOTHING;

-- Disable Row Level Security for now (we'll handle auth in the app)
ALTER TABLE employees DISABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE app_usage DISABLE ROW LEVEL SECURITY;
ALTER TABLE web_activity DISABLE ROW LEVEL SECURITY; 