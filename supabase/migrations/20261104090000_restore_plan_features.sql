-- These features belong in the catalogue. Databases that loaded the plan list
-- before they were added still refuse the reports with "Upgrade to unlock this report".

insert into public.plan_feature_grants (feature_key, plan_key) values
  ('software_usage', 'work_activity'),
  ('channels', 'work_activity'),
  ('file_activity', 'workforce'),
  ('ai_tools', 'workforce'),
  ('trends', 'productivity'),
  ('api', 'productivity')
on conflict (feature_key) do update set plan_key = excluded.plan_key;
