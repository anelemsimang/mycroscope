-- Add current_project column to app_usage table if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'app_usage' 
        AND column_name = 'current_project'
    ) THEN
        ALTER TABLE app_usage ADD COLUMN current_project TEXT;
        RAISE NOTICE 'Added current_project column to app_usage table';
    ELSE
        RAISE NOTICE 'current_project column already exists in app_usage table';
    END IF;
END $$;

-- Add current_project column to web_activity table if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'web_activity' 
        AND column_name = 'current_project'
    ) THEN
        ALTER TABLE web_activity ADD COLUMN current_project TEXT;
        RAISE NOTICE 'Added current_project column to web_activity table';
    ELSE
        RAISE NOTICE 'current_project column already exists in web_activity table';
    END IF;
END $$;

-- Create index on current_project for better query performance
CREATE INDEX IF NOT EXISTS idx_app_usage_current_project ON app_usage(current_project);
CREATE INDEX IF NOT EXISTS idx_web_activity_current_project ON web_activity(current_project); 