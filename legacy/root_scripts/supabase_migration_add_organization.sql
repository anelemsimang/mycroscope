-- Migration Script: Add organization column to existing tables
-- Run this in your Supabase SQL Editor to update existing tables

-- Add organization column to employees table
ALTER TABLE employees 
ADD COLUMN IF NOT EXISTS organization VARCHAR(255) DEFAULT 'Default';

-- Add organization column to activity_logs table
ALTER TABLE activity_logs 
ADD COLUMN IF NOT EXISTS organization VARCHAR(255) DEFAULT 'Default';

-- Add organization column to sessions table
ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS organization VARCHAR(255) DEFAULT 'Default';

-- Add organization column to app_usage table
ALTER TABLE app_usage 
ADD COLUMN IF NOT EXISTS organization VARCHAR(255) DEFAULT 'Default';

-- Add organization column to web_activity table
ALTER TABLE web_activity 
ADD COLUMN IF NOT EXISTS organization VARCHAR(255) DEFAULT 'Default';

-- Create indexes for organization-based queries
CREATE INDEX IF NOT EXISTS idx_employees_organization ON employees(organization);
CREATE INDEX IF NOT EXISTS idx_activity_logs_organization ON activity_logs(organization);
CREATE INDEX IF NOT EXISTS idx_sessions_organization ON sessions(organization);
CREATE INDEX IF NOT EXISTS idx_app_usage_organization ON app_usage(organization);
CREATE INDEX IF NOT EXISTS idx_web_activity_organization ON web_activity(organization);

-- Update existing sample data to have organization
UPDATE employees 
SET organization = 'TechCorp' 
WHERE organization = 'Default' OR organization IS NULL;

-- Make organization column NOT NULL after setting defaults
ALTER TABLE employees ALTER COLUMN organization SET NOT NULL;
ALTER TABLE activity_logs ALTER COLUMN organization SET NOT NULL;
ALTER TABLE sessions ALTER COLUMN organization SET NOT NULL;
ALTER TABLE app_usage ALTER COLUMN organization SET NOT NULL;
ALTER TABLE web_activity ALTER COLUMN organization SET NOT NULL; 