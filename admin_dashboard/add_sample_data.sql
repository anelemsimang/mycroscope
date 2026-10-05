-- Add sample activity data to demonstrate analytics
-- This script will add realistic activity logs to show the analytics in action

-- First, let's add some sample activity logs
INSERT INTO activity_logs (employee_id, organization_id, activity_type, description, timestamp, metadata) VALUES
-- Employee 1 activities (assuming you have an employee with id 'emp001')
('emp001', (SELECT id FROM organizations LIMIT 1), 'login', 'User logged in', '2024-12-01 09:00:00', '{"app_name": "Mycroscope Desktop", "ip_address": "192.168.1.100"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'app_launch', 'VS Code launched', '2024-12-01 09:05:00', '{"app_name": "VS Code", "window_title": "project/src/main.py"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'web_visit', 'Visited GitHub', '2024-12-01 09:15:00', '{"domain": "github.com", "url": "https://github.com/user/repo"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'app_launch', 'Chrome launched', '2024-12-01 09:20:00', '{"app_name": "Chrome", "window_title": "GitHub"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'web_visit', 'Visited Stack Overflow', '2024-12-01 10:00:00', '{"domain": "stackoverflow.com", "url": "https://stackoverflow.com/questions/123"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'app_launch', 'Slack launched', '2024-12-01 10:30:00', '{"app_name": "Slack", "window_title": "Team Chat"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'project_switch', 'Switched to project B', '2024-12-01 11:00:00', '{"project_name": "Project B", "previous_project": "Project A"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'app_launch', 'Excel launched', '2024-12-01 11:30:00', '{"app_name": "Excel", "window_title": "data.xlsx"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'idle_start', 'User became idle', '2024-12-01 12:00:00', '{"idle_duration": 300}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'idle_end', 'User returned', '2024-12-01 12:05:00', '{"idle_duration": 300}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'web_visit', 'Visited Google', '2024-12-01 12:10:00', '{"domain": "google.com", "url": "https://google.com"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'logout', 'User logged out', '2024-12-01 17:00:00', '{"session_duration": 28800}'),

-- Employee 2 activities
('emp002', (SELECT id FROM organizations LIMIT 1), 'login', 'User logged in', '2024-12-01 08:30:00', '{"app_name": "Mycroscope Desktop", "ip_address": "192.168.1.101"}'),
('emp002', (SELECT id FROM organizations LIMIT 1), 'app_launch', 'Word launched', '2024-12-01 08:35:00', '{"app_name": "Word", "window_title": "report.docx"}'),
('emp002', (SELECT id FROM organizations LIMIT 1), 'web_visit', 'Visited LinkedIn', '2024-12-01 09:00:00', '{"domain": "linkedin.com", "url": "https://linkedin.com"}'),
('emp002', (SELECT id FROM organizations LIMIT 1), 'app_launch', 'PowerPoint launched', '2024-12-01 10:00:00', '{"app_name": "PowerPoint", "window_title": "presentation.pptx"}'),
('emp002', (SELECT id FROM organizations LIMIT 1), 'web_visit', 'Visited YouTube', '2024-12-01 11:00:00', '{"domain": "youtube.com", "url": "https://youtube.com/watch?v=123"}'),
('emp002', (SELECT id FROM organizations LIMIT 1), 'logout', 'User logged out', '2024-12-01 16:30:00', '{"session_duration": 28800}'),

-- More recent activities for today
('emp001', (SELECT id FROM organizations LIMIT 1), 'login', 'User logged in', '2024-12-02 09:00:00', '{"app_name": "Mycroscope Desktop", "ip_address": "192.168.1.100"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'app_launch', 'VS Code launched', '2024-12-02 09:05:00', '{"app_name": "VS Code", "window_title": "project/src/main.py"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'web_visit', 'Visited GitHub', '2024-12-02 09:15:00', '{"domain": "github.com", "url": "https://github.com/user/repo"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'app_launch', 'Chrome launched', '2024-12-02 09:20:00', '{"app_name": "Chrome", "window_title": "GitHub"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'web_visit', 'Visited Stack Overflow', '2024-12-02 10:00:00', '{"domain": "stackoverflow.com", "url": "https://stackoverflow.com/questions/123"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'app_launch', 'Slack launched', '2024-12-02 10:30:00', '{"app_name": "Slack", "window_title": "Team Chat"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'project_switch', 'Switched to project B', '2024-12-02 11:00:00', '{"project_name": "Project B", "previous_project": "Project A"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'app_launch', 'Excel launched', '2024-12-02 11:30:00', '{"app_name": "Excel", "window_title": "data.xlsx"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'idle_start', 'User became idle', '2024-12-02 12:00:00', '{"idle_duration": 300}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'idle_end', 'User returned', '2024-12-02 12:05:00', '{"idle_duration": 300}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'web_visit', 'Visited Google', '2024-12-02 12:10:00', '{"domain": "google.com", "url": "https://google.com"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'logout', 'User logged out', '2024-12-02 17:00:00', '{"session_duration": 28800}'),

-- Activities for the last 7 days
('emp001', (SELECT id FROM organizations LIMIT 1), 'login', 'User logged in', '2024-11-26 09:00:00', '{"app_name": "Mycroscope Desktop", "ip_address": "192.168.1.100"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'app_launch', 'VS Code launched', '2024-11-26 09:05:00', '{"app_name": "VS Code", "window_title": "project/src/main.py"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'web_visit', 'Visited GitHub', '2024-11-26 09:15:00', '{"domain": "github.com", "url": "https://github.com/user/repo"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'logout', 'User logged out', '2024-11-26 17:00:00', '{"session_duration": 28800}'),

('emp001', (SELECT id FROM organizations LIMIT 1), 'login', 'User logged in', '2024-11-27 09:00:00', '{"app_name": "Mycroscope Desktop", "ip_address": "192.168.1.100"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'app_launch', 'Chrome launched', '2024-11-27 09:05:00', '{"app_name": "Chrome", "window_title": "Google"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'web_visit', 'Visited Stack Overflow', '2024-11-27 10:00:00', '{"domain": "stackoverflow.com", "url": "https://stackoverflow.com/questions/123"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'logout', 'User logged out', '2024-11-27 17:00:00', '{"session_duration": 28800}'),

('emp001', (SELECT id FROM organizations LIMIT 1), 'login', 'User logged in', '2024-11-28 09:00:00', '{"app_name": "Mycroscope Desktop", "ip_address": "192.168.1.100"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'app_launch', 'Slack launched', '2024-11-28 09:05:00', '{"app_name": "Slack", "window_title": "Team Chat"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'web_visit', 'Visited LinkedIn', '2024-11-28 10:00:00', '{"domain": "linkedin.com", "url": "https://linkedin.com"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'logout', 'User logged out', '2024-11-28 17:00:00', '{"session_duration": 28800}'),

('emp001', (SELECT id FROM organizations LIMIT 1), 'login', 'User logged in', '2024-11-29 09:00:00', '{"app_name": "Mycroscope Desktop", "ip_address": "192.168.1.100"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'app_launch', 'Excel launched', '2024-11-29 09:05:00', '{"app_name": "Excel", "window_title": "data.xlsx"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'web_visit', 'Visited YouTube', '2024-11-29 10:00:00', '{"domain": "youtube.com", "url": "https://youtube.com/watch?v=123"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'logout', 'User logged out', '2024-11-29 17:00:00', '{"session_duration": 28800}'),

('emp001', (SELECT id FROM organizations LIMIT 1), 'login', 'User logged in', '2024-11-30 09:00:00', '{"app_name": "Mycroscope Desktop", "ip_address": "192.168.1.100"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'app_launch', 'Word launched', '2024-11-30 09:05:00', '{"app_name": "Word", "window_title": "report.docx"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'web_visit', 'Visited Google', '2024-11-30 10:00:00', '{"domain": "google.com", "url": "https://google.com"}'),
('emp001', (SELECT id FROM organizations LIMIT 1), 'logout', 'User logged out', '2024-11-30 17:00:00', '{"session_duration": 28800}');

-- Note: This script assumes you have:
-- 1. At least one organization in the organizations table
-- 2. Employees with employee_id 'emp001' and 'emp002' in the employees table
-- 3. The activity_logs table exists with the correct schema

-- If you don't have employees yet, you can create them first:
-- INSERT INTO employees (organization_id, employee_id, name, email, password_hash, role, is_active) VALUES
-- ((SELECT id FROM organizations LIMIT 1), 'emp001', 'John Doe', 'john@company.com', 'hashed_password', 'employee', true),
-- ((SELECT id FROM organizations LIMIT 1), 'emp002', 'Jane Smith', 'jane@company.com', 'hashed_password', 'employee', true); 