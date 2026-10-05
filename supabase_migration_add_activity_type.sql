-- Migration: Add activity_type column to app_usage table
-- This allows distinguishing between session records and current activity records

-- Add activity_type column to app_usage table
ALTER TABLE app_usage 
ADD COLUMN activity_type VARCHAR(50) DEFAULT 'session';

-- Add comment to explain the column
COMMENT ON COLUMN app_usage.activity_type IS 'Type of activity record: session (closed app), current_activity (real-time tracking)';

-- Update existing records to have 'session' type
UPDATE app_usage 
SET activity_type = 'session' 
WHERE activity_type IS NULL;

-- Make the column NOT NULL after setting default values
ALTER TABLE app_usage 
ALTER COLUMN activity_type SET NOT NULL;

-- Create index for better query performance
CREATE INDEX idx_app_usage_activity_type ON app_usage(activity_type);

-- Create index for current activity queries
CREATE INDEX idx_app_usage_current_activity ON app_usage(employee_id, activity_type, is_active) 
WHERE activity_type = 'current_activity' AND is_active = true; 
