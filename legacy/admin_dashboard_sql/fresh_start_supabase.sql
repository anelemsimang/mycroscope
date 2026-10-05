-- Fresh Start Mycroscope Supabase Setup
-- Project URL: https://YOUR_PROJECT_REF.supabase.co
-- This script assumes NO existing tables - run this on a clean database

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Drop existing tables if they exist (clean slate)
DROP TABLE IF EXISTS project_assignments CASCADE;
DROP TABLE IF EXISTS projects CASCADE;
DROP TABLE IF EXISTS web_activity CASCADE;
DROP TABLE IF EXISTS app_usage CASCADE;
DROP TABLE IF EXISTS activity_logs CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS employees CASCADE;
DROP TABLE IF EXISTS admin_keys CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;

-- Create organizations table
CREATE TABLE organizations (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    contact_person VARCHAR(255),
    phone VARCHAR(50),
    address TEXT,
    secret_key VARCHAR(255),
    subscription_plan VARCHAR(50) DEFAULT 'basic',
    subscription_status VARCHAR(50) DEFAULT 'active',
    max_employees INTEGER DEFAULT 10,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create admin_keys table
CREATE TABLE admin_keys (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    secret_key VARCHAR(255) NOT NULL UNIQUE,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '1 year')
);

-- Create employees table
CREATE TABLE employees (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    employee_id VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'employee' CHECK (role IN ('employee', 'manager', 'admin')),
    department VARCHAR(100),
    position VARCHAR(100),
    hire_date DATE DEFAULT CURRENT_DATE,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(organization_id, employee_id),
    UNIQUE(organization_id, email)
);

-- Create sessions table
CREATE TABLE sessions (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    session_token VARCHAR(255) NOT NULL UNIQUE,
    login_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    logout_time TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT true,
    ip_address INET,
    user_agent TEXT
);

-- Create activity_logs table
CREATE TABLE activity_logs (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    activity_type VARCHAR(50) NOT NULL,
    description TEXT,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB
);

-- Create app_usage table
CREATE TABLE app_usage (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    app_name VARCHAR(255) NOT NULL,
    window_title TEXT,
    start_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    end_time TIMESTAMP WITH TIME ZONE,
    duration_seconds INTEGER,
    is_active BOOLEAN DEFAULT true
);

-- Create web_activity table
CREATE TABLE web_activity (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT,
    domain VARCHAR(255),
    start_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    end_time TIMESTAMP WITH TIME ZONE,
    duration_seconds INTEGER,
    is_active BOOLEAN DEFAULT true
);

-- Create projects table
CREATE TABLE projects (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create project_assignments table
CREATE TABLE project_assignments (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    role VARCHAR(100),
    is_active BOOLEAN DEFAULT true
);

-- Insert sample organizations
INSERT INTO organizations (id, name, email, contact_person, phone, address, secret_key, subscription_plan, max_employees) VALUES
('550e8400-e29b-41d4-a716-446655440001', 'TechCorp Solutions', 'admin@techcorp.com', 'John Admin', '+1-555-0101', '123 Tech Street, Silicon Valley, CA', 'techcorp-admin-key-2024-secure', 'premium', 50),
('550e8400-e29b-41d4-a716-446655440002', 'Global Innovations Ltd', 'contact@globalinnovations.com', 'Sarah Manager', '+1-555-0102', '456 Innovation Ave, New York, NY', 'global-innovations-key-2024-secure', 'basic', 25),
('550e8400-e29b-41d4-a716-446655440003', 'StartupXYZ', 'hello@startupxyz.com', 'Alex Founder', '+1-555-0103', '789 Startup Blvd, Austin, TX', 'startupxyz-key-2024-secure', 'basic', 15);

-- Insert admin keys for organizations
INSERT INTO admin_keys (organization_id, secret_key) VALUES
('550e8400-e29b-41d4-a716-446655440001', 'techcorp-admin-key-2024-secure'),
('550e8400-e29b-41d4-a716-446655440002', 'global-innovations-key-2024-secure'),
('550e8400-e29b-41d4-a716-446655440003', 'startupxyz-key-2024-secure');

-- Insert sample projects
INSERT INTO projects (id, organization_id, name, description, status) VALUES
('660e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440001', 'E-commerce Platform', 'Building a modern e-commerce solution', 'active'),
('660e8400-e29b-41d4-a716-446655440002', '550e8400-e29b-41d4-a716-446655440001', 'Mobile App Development', 'iOS and Android app for customer engagement', 'active'),
('660e8400-e29b-41d4-a716-446655440003', '550e8400-e29b-41d4-a716-446655440002', 'AI Research Project', 'Machine learning algorithms for data analysis', 'active'),
('660e8400-e29b-41d4-a716-446655440004', '550e8400-e29b-41d4-a716-446655440003', 'Website Redesign', 'Modernizing the company website', 'active');

-- Insert sample employees
INSERT INTO employees (id, organization_id, employee_id, name, email, password_hash, role, department, position) VALUES
-- TechCorp Solutions employees
('770e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440001', 'TC001', 'John Smith', 'john.smith@techcorp.com', '$2b$10$rQZ8K9vL2mN3pQ4sT5uV6w', 'admin', 'Engineering', 'Senior Developer'),
('770e8400-e29b-41d4-a716-446655440002', '550e8400-e29b-41d4-a716-446655440001', 'TC002', 'Sarah Johnson', 'sarah.johnson@techcorp.com', '$2b$10$rQZ8K9vL2mN3pQ4sT5uV6w', 'manager', 'Product', 'Product Manager'),
('770e8400-e29b-41d4-a716-446655440003', '550e8400-e29b-41d4-a716-446655440001', 'TC003', 'Mike Davis', 'mike.davis@techcorp.com', '$2b$10$rQZ8K9vL2mN3pQ4sT5uV6w', 'employee', 'Engineering', 'Junior Developer'),
('770e8400-e29b-41d4-a716-446655440004', '550e8400-e29b-41d4-a716-446655440001', 'TC004', 'Lisa Wilson', 'lisa.wilson@techcorp.com', '$2b$10$rQZ8K9vL2mN3pQ4sT5uV6w', 'employee', 'Design', 'UI/UX Designer'),

-- Global Innovations employees
('770e8400-e29b-41d4-a716-446655440005', '550e8400-e29b-41d4-a716-446655440002', 'GI001', 'David Brown', 'david.brown@globalinnovations.com', '$2b$10$rQZ8K9vL2mN3pQ4sT5uV6w', 'admin', 'Research', 'Lead Scientist'),
('770e8400-e29b-41d4-a716-446655440006', '550e8400-e29b-41d4-a716-446655440002', 'GI002', 'Emma Taylor', 'emma.taylor@globalinnovations.com', '$2b$10$rQZ8K9vL2mN3pQ4sT5uV6w', 'manager', 'Development', 'Project Manager'),
('770e8400-e29b-41d4-a716-446655440007', '550e8400-e29b-41d4-a716-446655440002', 'GI003', 'James Miller', 'james.miller@globalinnovations.com', '$2b$10$rQZ8K9vL2mN3pQ4sT5uV6w', 'employee', 'Research', 'Data Analyst'),

-- StartupXYZ employees
('770e8400-e29b-41d4-a716-446655440008', '550e8400-e29b-41d4-a716-446655440003', 'SX001', 'Alex Chen', 'alex.chen@startupxyz.com', '$2b$10$rQZ8K9vL2mN3pQ4sT5uV6w', 'admin', 'Engineering', 'CTO'),
('770e8400-e29b-41d4-a716-446655440009', '550e8400-e29b-41d4-a716-446655440003', 'SX002', 'Maria Garcia', 'maria.garcia@startupxyz.com', '$2b$10$rQZ8K9vL2mN3pQ4sT5uV6w', 'employee', 'Marketing', 'Marketing Specialist');

-- Insert project assignments
INSERT INTO project_assignments (project_id, employee_id, organization_id, role) VALUES
('660e8400-e29b-41d4-a716-446655440001', '770e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440001', 'Lead Developer'),
('660e8400-e29b-41d4-a716-446655440001', '770e8400-e29b-41d4-a716-446655440003', '550e8400-e29b-41d4-a716-446655440001', 'Developer'),
('660e8400-e29b-41d4-a716-446655440002', '770e8400-e29b-41d4-a716-446655440002', '550e8400-e29b-41d4-a716-446655440001', 'Project Manager'),
('660e8400-e29b-41d4-a716-446655440002', '770e8400-e29b-41d4-a716-446655440004', '550e8400-e29b-41d4-a716-446655440001', 'UI Designer'),
('660e8400-e29b-41d4-a716-446655440003', '770e8400-e29b-41d4-a716-446655440005', '550e8400-e29b-41d4-a716-446655440002', 'Lead Researcher'),
('660e8400-e29b-41d4-a716-446655440003', '770e8400-e29b-41d4-a716-446655440007', '550e8400-e29b-41d4-a716-446655440002', 'Data Analyst'),
('660e8400-e29b-41d4-a716-446655440004', '770e8400-e29b-41d4-a716-446655440008', '550e8400-e29b-41d4-a716-446655440003', 'Lead Developer'),
('660e8400-e29b-41d4-a716-446655440004', '770e8400-e29b-41d4-a716-446655440009', '550e8400-e29b-41d4-a716-446655440003', 'Content Creator');

-- Insert sample activity logs
INSERT INTO activity_logs (employee_id, organization_id, activity_type, description, timestamp, metadata) VALUES
('770e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440001', 'login', 'User logged in', NOW() - INTERVAL '2 hours', '{"ip": "192.168.1.100", "user_agent": "Chrome/120.0"}'),
('770e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440001', 'project_switch', 'Switched to E-commerce Platform project', NOW() - INTERVAL '1 hour 30 minutes', '{"project_id": "660e8400-e29b-41d4-a716-446655440001"}'),
('770e8400-e29b-41d4-a716-446655440002', '550e8400-e29b-41d4-a716-446655440001', 'login', 'User logged in', NOW() - INTERVAL '3 hours', '{"ip": "192.168.1.101", "user_agent": "Firefox/119.0"}'),
('770e8400-e29b-41d4-a716-446655440003', '550e8400-e29b-41d4-a716-446655440001', 'login', 'User logged in', NOW() - INTERVAL '4 hours', '{"ip": "192.168.1.102", "user_agent": "Safari/17.0"}'),
('770e8400-e29b-41d4-a716-446655440005', '550e8400-e29b-41d4-a716-446655440002', 'login', 'User logged in', NOW() - INTERVAL '5 hours', '{"ip": "192.168.1.103", "user_agent": "Chrome/120.0"}'),
('770e8400-e29b-41d4-a716-446655440008', '550e8400-e29b-41d4-a716-446655440003', 'login', 'User logged in', NOW() - INTERVAL '6 hours', '{"ip": "192.168.1.104", "user_agent": "Edge/120.0"}');

-- Insert sample app usage
INSERT INTO app_usage (employee_id, organization_id, app_name, window_title, start_time, end_time, duration_seconds) VALUES
('770e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440001', 'Visual Studio Code', 'ecommerce-platform/src/App.js', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour 30 minutes', 1800),
('770e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440001', 'Chrome', 'GitHub - techcorp/ecommerce-platform', NOW() - INTERVAL '1 hour 30 minutes', NOW() - INTERVAL '1 hour', 1800),
('770e8400-e29b-41d4-a716-446655440002', '550e8400-e29b-41d4-a716-446655440001', 'Figma', 'Mobile App Design - TechCorp', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours', 3600),
('770e8400-e29b-41d4-a716-446655440003', '550e8400-e29b-41d4-a716-446655440001', 'Visual Studio Code', 'api-endpoints.js', NOW() - INTERVAL '4 hours', NOW() - INTERVAL '3 hours', 3600),
('770e8400-e29b-41d4-a716-446655440005', '550e8400-e29b-41d4-a716-446655440002', 'Jupyter Notebook', 'AI_Research_Project.ipynb', NOW() - INTERVAL '5 hours', NOW() - INTERVAL '4 hours', 3600),
('770e8400-e29b-41d4-a716-446655440008', '550e8400-e29b-41d4-a716-446655440003', 'Visual Studio Code', 'website-redesign/index.html', NOW() - INTERVAL '6 hours', NOW() - INTERVAL '5 hours', 3600);

-- Insert sample web activity
INSERT INTO web_activity (employee_id, organization_id, url, title, domain, start_time, end_time, duration_seconds) VALUES
('770e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440001', 'https://github.com/techcorp/ecommerce-platform', 'GitHub - techcorp/ecommerce-platform', 'github.com', NOW() - INTERVAL '1 hour 30 minutes', NOW() - INTERVAL '1 hour', 1800),
('770e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440001', 'https://stackoverflow.com/questions/react-hooks', 'React Hooks - Stack Overflow', 'stackoverflow.com', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '30 minutes', 1800),
('770e8400-e29b-41d4-a716-446655440002', '550e8400-e29b-41d4-a716-446655440001', 'https://figma.com/file/design-system', 'Design System - Figma', 'figma.com', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours', 3600),
('770e8400-e29b-41d4-a716-446655440005', '550e8400-e29b-41d4-a716-446655440002', 'https://arxiv.org/abs/machine-learning', 'Machine Learning Research - arXiv', 'arxiv.org', NOW() - INTERVAL '5 hours', NOW() - INTERVAL '4 hours', 3600),
('770e8400-e29b-41d4-a716-446655440008', '550e8400-e29b-41d4-a716-446655440003', 'https://developer.mozilla.org/en-US/docs/Web/HTML', 'HTML Documentation - MDN', 'developer.mozilla.org', NOW() - INTERVAL '6 hours', NOW() - INTERVAL '5 hours', 3600);

-- Create indexes for better performance
CREATE INDEX idx_employees_organization_id ON employees(organization_id);
CREATE INDEX idx_employees_email ON employees(email);
CREATE INDEX idx_activity_logs_employee_id ON activity_logs(employee_id);
CREATE INDEX idx_activity_logs_organization_id ON activity_logs(organization_id);
CREATE INDEX idx_activity_logs_timestamp ON activity_logs(timestamp);
CREATE INDEX idx_app_usage_employee_id ON app_usage(employee_id);
CREATE INDEX idx_app_usage_organization_id ON app_usage(organization_id);
CREATE INDEX idx_app_usage_start_time ON app_usage(start_time);
CREATE INDEX idx_web_activity_employee_id ON web_activity(employee_id);
CREATE INDEX idx_web_activity_organization_id ON web_activity(organization_id);
CREATE INDEX idx_web_activity_start_time ON web_activity(start_time);
CREATE INDEX idx_sessions_employee_id ON sessions(employee_id);
CREATE INDEX idx_sessions_organization_id ON sessions(organization_id);
CREATE INDEX idx_admin_keys_organization_id ON admin_keys(organization_id);
CREATE INDEX idx_admin_keys_secret_key ON admin_keys(secret_key);

-- Disable Row Level Security for easier testing (enable later for production)
ALTER TABLE organizations DISABLE ROW LEVEL SECURITY;
ALTER TABLE admin_keys DISABLE ROW LEVEL SECURITY;
ALTER TABLE employees DISABLE ROW LEVEL SECURITY;
ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE app_usage DISABLE ROW LEVEL SECURITY;
ALTER TABLE web_activity DISABLE ROW LEVEL SECURITY;
ALTER TABLE projects DISABLE ROW LEVEL SECURITY;
ALTER TABLE project_assignments DISABLE ROW LEVEL SECURITY;

-- Grant necessary permissions
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE TRIGGER update_organizations_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_employees_updated_at BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Success message
SELECT 'Mycroscope database setup completed successfully!' as status; 