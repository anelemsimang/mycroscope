-- Mycroscope Admin Dashboard Database Setup
-- Run this in your Supabase SQL Editor

-- 1. Create organizations table
CREATE TABLE IF NOT EXISTS organizations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    contact_person VARCHAR(255) NOT NULL,
    secret_key VARCHAR(100) NOT NULL UNIQUE,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'suspended')),
    subscription_tier VARCHAR(20) DEFAULT 'basic' CHECK (subscription_tier IN ('basic', 'professional', 'enterprise')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Create admin_keys table
CREATE TABLE IF NOT EXISTS admin_keys (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    key_code VARCHAR(100) NOT NULL UNIQUE,
    organization_name VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Create employees table (if not exists)
CREATE TABLE IF NOT EXISTS employees (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id VARCHAR(100) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL,
    department VARCHAR(100),
    role VARCHAR(100),
    organization VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Create activity_logs table (if not exists)
CREATE TABLE IF NOT EXISTS activity_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id VARCHAR(100) NOT NULL,
    organization VARCHAR(255) NOT NULL,
    activity_type VARCHAR(100) NOT NULL,
    details TEXT,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Create sessions table (if not exists)
CREATE TABLE IF NOT EXISTS sessions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id VARCHAR(100) NOT NULL,
    organization VARCHAR(255) NOT NULL,
    start_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    end_time TIMESTAMP WITH TIME ZONE,
    duration_minutes INTEGER DEFAULT 0
);

-- 6. Create app_usage table (if not exists)
CREATE TABLE IF NOT EXISTS app_usage (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id VARCHAR(100) NOT NULL,
    organization VARCHAR(255) NOT NULL,
    app_name VARCHAR(255) NOT NULL,
    start_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    end_time TIMESTAMP WITH TIME ZONE,
    duration_minutes INTEGER DEFAULT 0
);

-- 7. Create web_activity table (if not exists)
CREATE TABLE IF NOT EXISTS web_activity (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id VARCHAR(100) NOT NULL,
    organization VARCHAR(255) NOT NULL,
    url VARCHAR(500),
    title VARCHAR(255),
    start_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    end_time TIMESTAMP WITH TIME ZONE,
    duration_minutes INTEGER DEFAULT 0
);

-- 8. Insert sample organizations (this will work)
INSERT INTO organizations (name, email, contact_person, secret_key, status, subscription_tier) VALUES
('TechCorp Solutions', 'admin@techcorp.com', 'John Smith', 'TECH-ABC123-2024', 'approved', 'professional'),
('Innovate Labs', 'contact@innovatelabs.com', 'Sarah Johnson', 'INNO-DEF456-2024', 'pending', 'basic'),
('Global Systems', 'info@globalsystems.com', 'Mike Wilson', 'GLOB-GHI789-2024', 'suspended', 'enterprise')
ON CONFLICT (secret_key) DO NOTHING;

-- 9. Insert sample admin keys
INSERT INTO admin_keys (key_code, organization_name, expires_at) VALUES
('ADMIN-TEST123456', 'TechCorp Solutions', NOW() + INTERVAL '30 days'),
('ADMIN-DEMO789012', 'Innovate Labs', NOW() + INTERVAL '30 days')
ON CONFLICT (key_code) DO NOTHING;

-- 10. Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);
CREATE INDEX IF NOT EXISTS idx_organizations_created_at ON organizations(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_keys_organization ON admin_keys(organization_name);
CREATE INDEX IF NOT EXISTS idx_employees_organization ON employees(organization);
CREATE INDEX IF NOT EXISTS idx_activity_logs_employee ON activity_logs(employee_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_timestamp ON activity_logs(timestamp);

-- 11. Disable Row Level Security for testing (enable later for production)
ALTER TABLE organizations DISABLE ROW LEVEL SECURITY;
ALTER TABLE admin_keys DISABLE ROW LEVEL SECURITY;
ALTER TABLE employees DISABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE app_usage DISABLE ROW LEVEL SECURITY;
ALTER TABLE web_activity DISABLE ROW LEVEL SECURITY;

-- 12. Grant permissions (adjust as needed for your setup)
GRANT ALL ON organizations TO anon;
GRANT ALL ON admin_keys TO anon;
GRANT ALL ON employees TO anon;
GRANT ALL ON activity_logs TO anon;
GRANT ALL ON sessions TO anon;
GRANT ALL ON app_usage TO anon;
GRANT ALL ON web_activity TO anon; 