-- Mycroscope: PostgreSQL schema ONLY (paste this whole file into Supabase → SQL Editor).
-- Do not paste Python (.py) files here.
-- Mycroscope: initial schema for a new Supabase project (Postgres 15+).
-- Apply via: Supabase Dashboard → SQL Editor (paste and run), or `supabase db push` when linked.
-- After run: insert your organizations and employees (e.g. via SQL or Supabase Table Editor) before using the app.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
CREATE TABLE public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- employees (custom auth: app compares password to password_hash column)
-- ---------------------------------------------------------------------------
CREATE TABLE public.employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  organization_id UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT employees_employee_id_key UNIQUE (employee_id),
  CONSTRAINT employees_email_org_key UNIQUE (email, organization_id)
);

CREATE INDEX idx_employees_organization_id ON public.employees (organization_id);

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
CREATE TABLE public.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.employees (id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  session_token TEXT NOT NULL,
  login_time TIMESTAMPTZ NOT NULL,
  logout_time TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ip_address TEXT,
  user_agent TEXT,
  CONSTRAINT sessions_session_token_key UNIQUE (session_token)
);

CREATE INDEX idx_sessions_employee_id ON public.sessions (employee_id);
CREATE INDEX idx_sessions_organization_id ON public.sessions (organization_id);
CREATE INDEX idx_sessions_active ON public.sessions (organization_id, is_active);

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
CREATE TABLE public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_by UUID REFERENCES public.employees (id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT projects_org_name_key UNIQUE (organization_id, name)
);

CREATE INDEX idx_projects_organization_id ON public.projects (organization_id);

-- ---------------------------------------------------------------------------
-- activity_logs
-- ---------------------------------------------------------------------------
CREATE TABLE public.activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.employees (id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES public.sessions (id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL DEFAULT 'general',
  description TEXT,
  timestamp TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_activity_logs_employee_time ON public.activity_logs (employee_id, timestamp DESC);
CREATE INDEX idx_activity_logs_org_time ON public.activity_logs (organization_id, timestamp DESC);

-- ---------------------------------------------------------------------------
-- app_usage
-- ---------------------------------------------------------------------------
CREATE TABLE public.app_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.employees (id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES public.sessions (id) ON DELETE CASCADE,
  app_name TEXT NOT NULL,
  window_title TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  end_time TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  current_project VARCHAR(255),
  activity_type VARCHAR(50) NOT NULL DEFAULT 'session',
  updated_at TIMESTAMPTZ
);

CREATE INDEX idx_app_usage_employee_start ON public.app_usage (employee_id, start_time DESC);
CREATE INDEX idx_app_usage_org_start ON public.app_usage (organization_id, start_time DESC);
CREATE INDEX idx_app_usage_activity_type ON public.app_usage (activity_type);
CREATE INDEX idx_app_usage_current_activity ON public.app_usage (employee_id, activity_type, is_active)
  WHERE activity_type = 'current_activity' AND is_active = TRUE;

-- ---------------------------------------------------------------------------
-- web_activity
-- ---------------------------------------------------------------------------
CREATE TABLE public.web_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.employees (id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES public.sessions (id) ON DELETE CASCADE,
  url TEXT NOT NULL DEFAULT '',
  title TEXT,
  domain TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  current_project VARCHAR(255)
);

CREATE INDEX idx_web_activity_employee_start ON public.web_activity (employee_id, start_time DESC);
CREATE INDEX idx_web_activity_org_start ON public.web_activity (organization_id, start_time DESC);

-- ---------------------------------------------------------------------------
-- daily_summaries
-- ---------------------------------------------------------------------------
CREATE TABLE public.daily_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.employees (id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  date DATE NOT NULL,
  app_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  web_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  activity_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_active_time INTEGER NOT NULL DEFAULT 0,
  total_sessions INTEGER NOT NULL DEFAULT 0,
  most_used_app TEXT,
  most_visited_domain TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT daily_summaries_employee_date_key UNIQUE (employee_id, date)
);

CREATE INDEX idx_daily_summaries_employee_date ON public.daily_summaries (employee_id, date);
CREATE INDEX idx_daily_summaries_organization_date ON public.daily_summaries (organization_id, date);

-- ---------------------------------------------------------------------------
-- Triggers: daily_summaries.updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_daily_summaries_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS update_daily_summaries_updated_at ON public.daily_summaries;
CREATE TRIGGER update_daily_summaries_updated_at
  BEFORE UPDATE ON public.daily_summaries
  FOR EACH ROW
  EXECUTE FUNCTION public.update_daily_summaries_updated_at();

CREATE OR REPLACE FUNCTION public.cleanup_old_daily_summaries()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.daily_summaries
  WHERE date < CURRENT_DATE - INTERVAL '90 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security (desktop app uses the anon key + custom employee auth)
-- Policies allow the anon role full CRUD on these tables. Tighten later with Auth.
-- ---------------------------------------------------------------------------
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.web_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mycroscope_anon_all_organizations" ON public.organizations
  FOR ALL TO anon USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "mycroscope_anon_all_employees" ON public.employees
  FOR ALL TO anon USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "mycroscope_anon_all_sessions" ON public.sessions
  FOR ALL TO anon USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "mycroscope_anon_all_projects" ON public.projects
  FOR ALL TO anon USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "mycroscope_anon_all_activity_logs" ON public.activity_logs
  FOR ALL TO anon USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "mycroscope_anon_all_app_usage" ON public.app_usage
  FOR ALL TO anon USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "mycroscope_anon_all_web_activity" ON public.web_activity
  FOR ALL TO anon USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "mycroscope_anon_all_daily_summaries" ON public.daily_summaries
  FOR ALL TO anon USING (TRUE) WITH CHECK (TRUE);

-- Optional: authenticated role (future web/mobile with user JWT)
CREATE POLICY "mycroscope_authenticated_all_organizations" ON public.organizations
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "mycroscope_authenticated_all_employees" ON public.employees
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "mycroscope_authenticated_all_sessions" ON public.sessions
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "mycroscope_authenticated_all_projects" ON public.projects
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "mycroscope_authenticated_all_activity_logs" ON public.activity_logs
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "mycroscope_authenticated_all_app_usage" ON public.app_usage
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "mycroscope_authenticated_all_web_activity" ON public.web_activity
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "mycroscope_authenticated_all_daily_summaries" ON public.daily_summaries
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);
