-- Add is_active column to projects table
ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

-- Update existing projects to be active
UPDATE projects SET is_active = TRUE WHERE is_active IS NULL; 