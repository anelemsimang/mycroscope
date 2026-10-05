-- Fix projects table schema to support dynamic project creation
-- Add missing created_by column

-- Add created_by column to projects table
ALTER TABLE projects 
ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES employees(id) ON DELETE SET NULL;

-- Add is_active column to projects table (for soft deletion)
ALTER TABLE projects 
ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Update existing projects to have a default created_by value
-- We'll set it to the first admin employee in each organization
UPDATE projects 
SET created_by = (
    SELECT e.id 
    FROM employees e 
    WHERE e.organization_id = projects.organization_id 
    AND e.role = 'admin' 
    LIMIT 1
)
WHERE created_by IS NULL;

-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_projects_organization_id ON projects(organization_id);
CREATE INDEX IF NOT EXISTS idx_projects_created_by ON projects(created_by);
CREATE INDEX IF NOT EXISTS idx_projects_is_active ON projects(is_active);

-- Add current_project column to app_usage table if it doesn't exist
ALTER TABLE app_usage 
ADD COLUMN IF NOT EXISTS current_project VARCHAR(255);

-- Add current_project column to web_activity table if it doesn't exist
ALTER TABLE web_activity 
ADD COLUMN IF NOT EXISTS current_project VARCHAR(255);

-- Add indexes for project filtering
CREATE INDEX IF NOT EXISTS idx_app_usage_current_project ON app_usage(current_project);
CREATE INDEX IF NOT EXISTS idx_web_activity_current_project ON web_activity(current_project);

-- Success message
SELECT 'Projects schema updated successfully!' as status; 