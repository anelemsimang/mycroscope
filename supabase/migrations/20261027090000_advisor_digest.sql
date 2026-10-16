-- =============================================================================
-- Mycroscope: written reports can hash a person code.
--   Supabase keeps pgcrypto in the extensions schema. These two functions only
--   look in public, so digest(text, unknown) was reported as missing.
-- Run after 20261020090000_work_advisor.sql.
-- =============================================================================

create schema if not exists extensions;

alter function public.advisor_directory(uuid) set search_path = public, extensions;
alter function public.advisor_pack(uuid, uuid, date, date) set search_path = public, extensions;

notify pgrst, 'reload schema';
