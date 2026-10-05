// Typed wrappers around the v2 database API. Row level security on the server
// decides what each caller may see; nothing here is a security boundary.
import { supabase } from './supabase';
import type { Ymd } from './format';

export type Role = 'owner' | 'manager' | 'employee';
export type ActivityState = 'active' | 'idle' | 'away' | 'paused' | 'logged_out';

export interface TeamRow {
  employee_id: string;
  name: string;
  employee_code: string;
  email: string;
  role: Role;
  is_active: boolean;
  activated: boolean;
  is_online: boolean;
  last_seen_at: string | null;
  current_state: ActivityState | null;
  current_app: string | null;
  current_window_title: string | null;
  current_domain: string | null;
  current_project: string | null;
  active_seconds: number;
  idle_seconds: number;
  away_seconds: number;
  paused_seconds: number;
  needs_acknowledgement: boolean;
}

export interface DailyTotal {
  day: Ymd;
  active_seconds: number;
  idle_seconds: number;
  away_seconds: number;
  paused_seconds: number;
  first_activity_at: string | null;
  last_activity_at: string | null;
}

export interface AppTotal { app_name: string; active_seconds: number; idle_seconds: number; last_used_at: string }
export interface DomainTotal {
  domain: string; active_seconds: number; idle_seconds: number; last_visited_at: string; sample_title: string | null;
}
export interface ProjectTotal { project_id: string | null; project_name: string; active_seconds: number; idle_seconds: number }
export interface TimelineRow {
  id: string;
  state: Exclude<ActivityState, 'logged_out'>;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  domain: string | null;
  project_name: string | null;
}

export interface EmployeeRow {
  id: string;
  name: string;
  email: string;
  employee_code: string;
  role: Role;
  is_active: boolean;
  auth_user_id: string | null;
  created_at: string;
}

export interface AgentStatus {
  state: ActivityState;
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  domain: string | null;
  project_name: string | null;
  last_seen_at: string;
  is_online: boolean;
}

export interface SegmentRow {
  started_at: string;
  ended_at: string;
  state: 'active' | 'idle';
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  domain: string | null;
}

export interface Project { id: string; name: string; is_active: boolean }

export interface ComplianceSettings {
  track_apps: boolean;
  track_window_titles: boolean;
  track_web_domains: boolean;
  track_full_urls: boolean;
  idle_threshold_seconds: number;
  allow_pause: boolean;
  retention_days: number;
  summary_retention_days: number;
  notice_custom_text: string | null;
  information_officer_name: string | null;
  information_officer_email: string | null;
  updated_at: string;
}

export interface Policy {
  id: string;
  version: number;
  notice_text: string;
  published_at: string;
  published_by: string | null;
}

export interface Consent { employee_id: string; policy_id: string; acknowledged_at: string; agent_version: string | null }

export interface AuditEntry {
  id: number;
  actor_employee_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export const AUDIT_PAGE = 50;

/** PostgREST returns at most this many rows per request (Supabase default). */
export const SEGMENT_LIMIT = 1000;

const ONLINE_WINDOW_MS = 2 * 60 * 1000;

export interface ActivationResult { employee_id?: string; employee_code: string; activation_code: string; expires_at: string }

/** Turns PostgREST/GoTrue errors into a message suitable for an alert. */
export function errorMessage(error: unknown): string {
  if (!error) return 'Something went wrong.';
  const e = error as { message?: string; code?: string };
  if (e.message?.includes('Failed to fetch') || e.message?.includes('Network request failed')) {
    return "Can't reach the server. Check your internet connection.";
  }
  if (e.code === '42501') return "You don't have permission to do that.";
  return e.message || 'Something went wrong.';
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

const num = (v: unknown) => Number(v ?? 0);

function numeric<T extends object>(rows: T[] | null, keys: (keyof T)[]): T[] {
  return (rows ?? []).map((r) => {
    const copy = { ...r };
    for (const k of keys) (copy as Record<keyof T, unknown>)[k] = num(r[k]);
    return copy;
  });
}

const projectArg = (project?: string | null) => (project ? { p_project: project } : {});

export const api = {
  resolveLoginEmail: (identifier: string) => rpc<string | null>('resolve_login_email', { p_identifier: identifier }),

  teamOverview: async (day?: Ymd) =>
    numeric(await rpc<TeamRow[]>('get_team_overview', day ? { p_day: day } : {}),
      ['active_seconds', 'idle_seconds', 'away_seconds', 'paused_seconds']),

  dailyTotals: async (employee: string, from: Ymd, to: Ymd, project?: string | null) =>
    numeric(await rpc<DailyTotal[]>('get_daily_totals', { p_employee: employee, p_from: from, p_to: to, ...projectArg(project) }),
      ['active_seconds', 'idle_seconds', 'away_seconds', 'paused_seconds']),

  appTotals: async (employee: string, from: Ymd, to: Ymd, project?: string | null) =>
    numeric(await rpc<AppTotal[]>('get_app_totals', { p_employee: employee, p_from: from, p_to: to, ...projectArg(project) }),
      ['active_seconds', 'idle_seconds']),

  domainTotals: async (employee: string, from: Ymd, to: Ymd, project?: string | null) =>
    numeric(await rpc<DomainTotal[]>('get_domain_totals', { p_employee: employee, p_from: from, p_to: to, ...projectArg(project) }),
      ['active_seconds', 'idle_seconds']),

  projectTotals: async (employee: string, from: Ymd, to: Ymd) =>
    numeric(await rpc<ProjectTotal[]>('get_project_totals', { p_employee: employee, p_from: from, p_to: to }),
      ['active_seconds', 'idle_seconds']),

  timeline: (employee: string, day: Ymd, project?: string | null) =>
    rpc<TimelineRow[]>('get_timeline', { p_employee: employee, p_day: day, ...projectArg(project) }),

  projects: async () => {
    const { data, error } = await supabase.from('projects').select('id,name,is_active').order('name');
    if (error) throw error;
    return (data ?? []) as Project[];
  },

  complianceSettings: async (organizationId: string): Promise<ComplianceSettings> => {
    const [settings, org] = await Promise.all([
      supabase.from('organization_settings')
        .select('track_apps,track_window_titles,track_web_domains,track_full_urls,idle_threshold_seconds,allow_pause,retention_days,summary_retention_days,notice_custom_text,updated_at')
        .eq('organization_id', organizationId).single(),
      supabase.from('organizations').select('information_officer_name,information_officer_email').eq('id', organizationId).single(),
    ]);
    if (settings.error) throw settings.error;
    if (org.error) throw org.error;
    return { ...settings.data, ...org.data } as ComplianceSettings;
  },

  /** Saves settings and Information Officer together; returns the current notice version. */
  saveComplianceSettings: (s: Omit<ComplianceSettings, 'updated_at'>) =>
    rpc<Policy>('save_compliance_settings', {
      p_track_apps: s.track_apps,
      p_track_window_titles: s.track_window_titles,
      p_track_web_domains: s.track_web_domains,
      p_track_full_urls: s.track_full_urls,
      p_idle_threshold_seconds: s.idle_threshold_seconds,
      p_allow_pause: s.allow_pause,
      p_retention_days: s.retention_days,
      p_summary_retention_days: s.summary_retention_days,
      p_notice_custom_text: s.notice_custom_text,
      p_information_officer_name: s.information_officer_name,
      p_information_officer_email: s.information_officer_email,
    }),

  policies: async () => {
    const { data, error } = await supabase
      .from('monitoring_policies')
      .select('id,version,notice_text,published_at,published_by')
      .order('version', { ascending: false });
    if (error) throw error;
    return (data ?? []) as Policy[];
  },

  consents: async () => {
    const { data, error } = await supabase
      .from('consents')
      .select('employee_id,policy_id,acknowledged_at,agent_version')
      .order('acknowledged_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as Consent[];
  },

  /** Newest first; pass the last id seen to load the next page. */
  auditLog: async (opts: { beforeId?: number; actions?: string[] } = {}) => {
    let q = supabase.from('audit_log').select('id,actor_employee_id,action,target_type,target_id,details,created_at');
    if (opts.beforeId !== undefined) q = q.lt('id', opts.beforeId);
    if (opts.actions?.length) q = q.in('action', opts.actions);
    const { data, error } = await q.order('id', { ascending: false }).limit(AUDIT_PAGE);
    if (error) throw error;
    return (data ?? []) as AuditEntry[];
  },

  employees: async () => {
    const { data, error } = await supabase
      .from('employees')
      .select('id,name,email,employee_code,role,is_active,auth_user_id,created_at')
      .order('name');
    if (error) throw error;
    return (data ?? []) as EmployeeRow[];
  },

  employee: async (id: string) => {
    const { data, error } = await supabase
      .from('employees')
      .select('id,name,email,employee_code,role,is_active,auth_user_id,created_at')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data as EmployeeRow | null;
  },

  createEmployee: async (name: string, email: string, role: Role, code?: string) =>
    (await rpc<ActivationResult[]>('create_employee', {
      p_name: name, p_email: email, p_role: role, p_employee_code: code || null,
    }))[0],

  issueActivationCode: async (employee: string) =>
    (await rpc<ActivationResult[]>('issue_activation_code', { p_employee: employee }))[0],

  updateEmployee: (employee: string, changes: { name?: string; role?: Role; is_active?: boolean }) =>
    rpc('update_employee', {
      p_employee: employee, p_name: changes.name ?? null, p_role: changes.role ?? null,
      p_is_active: changes.is_active ?? null,
    }),

  agentStatus: async (employee: string): Promise<AgentStatus | null> => {
    const { data, error } = await supabase
      .from('agent_status')
      .select('state,app_name,window_title,url,domain,last_seen_at,projects(name)')
      .eq('employee_id', employee)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const project = data.projects as { name: string } | { name: string }[] | null;
    return {
      state: data.state as ActivityState,
      app_name: data.app_name, window_title: data.window_title, url: data.url, domain: data.domain,
      project_name: (Array.isArray(project) ? project[0]?.name : project?.name) ?? null,
      last_seen_at: data.last_seen_at,
      is_online: data.state !== 'logged_out' && Date.now() - Date.parse(data.last_seen_at) < ONLINE_WINDOW_MS,
    };
  },

  /** Active/idle segments overlapping [fromIso, toIso), newest first, for one app or one website. */
  segments: async (employee: string, fromIso: string, toIso: string,
    filter: { app?: string; domain?: string; project?: string | null }) => {
    let q = supabase
      .from('activity_segments')
      .select('started_at,ended_at,state,app_name,window_title,url,domain')
      .eq('employee_id', employee)
      .in('state', ['active', 'idle'])
      .lt('started_at', toIso)
      .gt('ended_at', fromIso);
    if (filter.project) q = q.eq('project_id', filter.project);
    if (filter.domain !== undefined) q = q.eq('domain', filter.domain);
    if (filter.app !== undefined) q = filter.app === 'Unknown' ? q.is('app_name', null) : q.eq('app_name', filter.app);
    const { data, error } = await q.order('started_at', { ascending: false }).limit(SEGMENT_LIMIT);
    if (error) throw error;
    return (data ?? []) as SegmentRow[];
  },

  deleteActivity: (employee: string, fromIso: string, toIso: string, reason: string) =>
    rpc<number>('delete_activity', { p_employee: employee, p_from: fromIso, p_to: toIso, p_reason: reason }),

  deleteEmployee: (employee: string, reason: string) => rpc<void>('delete_employee', { p_employee: employee, p_reason: reason }),

  logAccess: (employee: string, action: 'viewed_employee' | 'exported_report' | 'exported_data', details: object = {}) =>
    rpc<void>('log_data_access', { p_employee: employee, p_action: action, p_details: details }).catch(() => undefined),
};
