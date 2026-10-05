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

export const api = {
  resolveLoginEmail: (identifier: string) => rpc<string | null>('resolve_login_email', { p_identifier: identifier }),

  teamOverview: async (day?: Ymd) =>
    numeric(await rpc<TeamRow[]>('get_team_overview', day ? { p_day: day } : {}),
      ['active_seconds', 'idle_seconds', 'away_seconds', 'paused_seconds']),

  dailyTotals: async (employee: string, from: Ymd, to: Ymd) =>
    numeric(await rpc<DailyTotal[]>('get_daily_totals', { p_employee: employee, p_from: from, p_to: to }),
      ['active_seconds', 'idle_seconds', 'away_seconds', 'paused_seconds']),

  appTotals: async (employee: string, from: Ymd, to: Ymd) =>
    numeric(await rpc<AppTotal[]>('get_app_totals', { p_employee: employee, p_from: from, p_to: to }),
      ['active_seconds', 'idle_seconds']),

  domainTotals: async (employee: string, from: Ymd, to: Ymd) =>
    numeric(await rpc<DomainTotal[]>('get_domain_totals', { p_employee: employee, p_from: from, p_to: to }),
      ['active_seconds', 'idle_seconds']),

  projectTotals: async (employee: string, from: Ymd, to: Ymd) =>
    numeric(await rpc<ProjectTotal[]>('get_project_totals', { p_employee: employee, p_from: from, p_to: to }),
      ['active_seconds', 'idle_seconds']),

  timeline: (employee: string, day: Ymd) => rpc<TimelineRow[]>('get_timeline', { p_employee: employee, p_day: day }),

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

  deleteEmployee: (employee: string, reason: string) => rpc<void>('delete_employee', { p_employee: employee, p_reason: reason }),

  logAccess: (employee: string, action: 'viewed_employee' | 'exported_report' | 'exported_data', details: object = {}) =>
    rpc<void>('log_data_access', { p_employee: employee, p_action: action, p_details: details }).catch(() => undefined),
};
