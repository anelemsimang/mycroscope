// Typed wrappers around the v2 database API. Row level security on the server
// decides what each caller may see; nothing here is a security boundary.
import { supabase } from './supabase';
import type { Ymd } from './format';
import { assembleDayBreakdown } from './dayBreakdown';
import { NO_PROJECT, projectQuery } from './projects';

export type Role = 'owner' | 'manager' | 'employee';
export type ActivityState = 'active' | 'idle' | 'away' | 'paused' | 'logged_out' | 'off_hours' | 'inactive';

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
  team_id: string | null;
  team_name: string | null;
}

export interface DailyTotal {
  day: Ymd;
  active_seconds: number;
  idle_seconds: number;
  away_seconds: number;
  paused_seconds: number;
  first_activity_at: string | null;
  last_activity_at: string | null;
  /** Answers about idle or away time. They are not extra time on top of idle and away. */
  meeting_seconds: number;
  call_seconds: number;
  break_seconds: number;
  other_seconds: number;
  /** The part of those answers the company currently counts as productive. */
  productive_offline_seconds: number;
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
  team_id: string | null;
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
  tracking_schedule: 'always' | 'work_hours';
  /** ISO weekdays, Monday = 1. */
  work_days: number[];
  /** HH:MM or HH:MM:SS */
  work_start: string;
  work_end: string;
  flag_after_hours_use: boolean;
  detect_tampering: boolean;
  detect_removable_media: boolean;
  detect_cloud_sync: boolean;
  detect_network_drives: boolean;
  file_retention_days: number;
  ask_offline_reason: boolean;
  offline_prompt_minutes: number;
  /** Which answers are added to productive time. Applied to past days as well. */
  productive_offline_reasons: OfflineReason[];
  track_work_location: boolean;
  /** Null when the company has not set a weekly office-day target. */
  office_days_per_week: number | null;
  alert_unapproved_ai: boolean;
  advisor_enabled: boolean;
  advisor_weekly_email: boolean;
  require_mfa: boolean;
  information_officer_name: string | null;
  information_officer_email: string | null;
  updated_at: string;
}

const SETTINGS_COLUMNS = 'track_apps,track_window_titles,track_web_domains,track_full_urls,idle_threshold_seconds,' +
  'allow_pause,retention_days,summary_retention_days,notice_custom_text,tracking_schedule,work_days,work_start,' +
  'work_end,flag_after_hours_use,detect_tampering,detect_removable_media,detect_cloud_sync,detect_network_drives,' +
  'file_retention_days,ask_offline_reason,offline_prompt_minutes,productive_offline_reasons,' +
  'track_work_location,office_days_per_week,alert_unapproved_ai,advisor_enabled,advisor_weekly_email,require_mfa,updated_at';

export type ServiceLevel = 'full' | 'read_only';
export interface ServiceStatus {
  level: ServiceLevel;
  status: 'active' | 'past_due' | 'lapsed' | 'cancelled' | 'suspended';
  plan: string;
  current_period_end: string | null;
  grace_until: string | null;
  seats: number;
  seats_used: number;
  require_mfa: boolean;
  /** Free uses the catalogue cap. A paid plan uses the purchased seats that are still in their year. */
  seat_cap: number | null;
  cancel_at_period_end?: boolean;
  pending_plan?: string | null;
  next_seat_end?: string | null;
}

export interface PurchasedSeat {
  id: string;
  period_start: string;
  period_end: string;
  cancel_at_period_end: boolean;
}

export interface Team { id: string; name: string; office_days_per_week: number | null }

export interface OfficeNetwork { id: string; name: string; cidrs: string[]; wifi_names: string[] }
export interface WorkLocationDay { day: Ymd; location: 'office' | 'remote' | 'mixed'; office_name: string | null }
export interface OfficeAdherence {
  employee_id: string; name: string; team_name: string | null;
  office_days: number; remote_days: number; mixed_days: number;
  target_per_week: number | null; weeks_judged: number; weeks_met: number | null;
}
export interface TeamManager { team_id: string; employee_id: string }

export interface AiCatalogTool { id: string; name: string; domains: string[]; app_names: string[]; approved: boolean | null }
export interface AiAdoptionRow { tool_id: string; tool_name: string; approved: boolean | null; people_using: number; people: number }
export interface AiPersonUsage {
  employee_id: string; name: string; tool_id: string; tool_name: string;
  days_used: number; days_per_week: number; level: 'occasional' | 'consistent';
  before_hours: number | null; after_hours: number | null; before_days: number | null; after_days: number | null;
}
export interface OperatorAiTool { id: string; name: string; domains: string[]; app_names: string[]; enabled: boolean }
export interface AdvisorQuestion { id: string; question: string; answer: string; team_id: string | null; created_at: string }
export interface CoachingNote { id: string; team_id: string | null; team_name: string | null; week_start: Ymd; body: string; created_at: string }

export type Category = 'productive' | 'neutral' | 'unproductive';
export interface CategoryRule { id: string; kind: 'app' | 'domain'; pattern: string; category: Category; team_id: string | null }

/** Stable feature keys from the plan catalogue. Cumulative: a higher plan includes every key below it. */
export type Feature = 'real_time_visibility' | 'time_tracking' | 'schedule_adherence' | 'website_tracking'
  | 'software_usage' | 'channels'
  | 'teams' | 'work_location_insights' | 'productivity_goals' | 'workload_planning'
  | 'file_activity' | 'ai_tools'
  | 'capacity_planning' | 'financial_estimates' | 'coaching' | 'trends' | 'api';

const INSIGHT_FEATURES: Feature[] = [
  'trends', 'workload_planning', 'capacity_planning', 'software_usage',
  'work_location_insights', 'ai_tools', 'coaching',
];

export function planHasInsights(features: readonly string[]): boolean {
  return INSIGHT_FEATURES.some((key) => features.includes(key));
}

export interface PlanCatalogueEntry {
  key: string;
  name: string;
  rank: number;
  net_price_cents: number;
  vat_cents: number;
  gross_price_cents: number;
  seat_cap: number | null;
  retention_label: string;
  vat_enabled: boolean;
  vat_rate: number;
  features: Feature[];
}

export type Severity = 'low' | 'medium' | 'high';
export interface AlertRule {
  id: string; name: string; kind: 'domain' | 'app'; pattern: string; severity: Severity;
  action: 'alert' | 'restrict';
  work_hours_only: boolean; enabled: boolean; pack: string | null;
}
export type RulePack = 'file_sharing' | 'personal_email' | 'bluetooth';
export type ChannelKind = 'slack' | 'teams' | 'webhook';
export interface NotificationChannel {
  id: string; kind: ChannelKind; name: string; url_hint: string; min_severity: Severity; enabled: boolean;
  created_at: string; last_sent_at: string | null; last_error: string | null; last_error_at: string | null;
}
export interface ApiKey {
  id: string; name: string; key_prefix: string; created_at: string; last_used_at: string | null;
  revoked_at: string | null; created_by_name: string | null;
}
export type OfflineReason = 'meeting' | 'call' | 'break' | 'other';
export interface OfflineEntry {
  id: string;
  started_at: string;
  ended_at: string;
  reason: OfflineReason;
  note: string | null;
  hostname: string | null;
}

export interface FileEvent {
  id: string; occurred_at: string; event_type: 'drive_connected' | 'phone_connected' | 'file_copied';
  destination: 'removable' | 'phone' | 'cloud' | 'network'; label: string | null; file_name: string | null;
  file_count: number; size_bytes: number | null; hostname: string | null;
}

export interface WorkSchedule {
  id: string;
  team_id: string | null;
  employee_id: string | null;
  work_days: number[];
  work_start: string;
  work_end: string;
}

export interface Goal { id: string; team_id: string | null; productive_hours: number; under_percent: number; over_percent: number }
export interface CategoryTotal { category: Category | 'uncategorised'; active_seconds: number; idle_seconds: number }

export type Granularity = 'day' | 'week' | 'month';
export interface TrendPoint {
  period_start: Ymd;
  people: number;
  person_days: number;
  active_seconds: number;
  idle_seconds: number;
  productive_seconds: number;
  unproductive_seconds: number;
  /** All answers about time away from the computer, including breaks. */
  offline_seconds: number;
  /** The part of that time in reasons the company counts as productive. Not included in productive_seconds. */
  productive_offline_seconds: number;
}
export interface SoftwareUsage {
  name: string;
  active_seconds: number;
  users: number;
  /** Everyone in scope who could have used it (the denominator for adoption). */
  people: number;
  category: Category | 'uncategorised';
  licence_id: string | null;
  licence_seats: number | null;
  monthly_cost_per_seat: number | null;
}
export type WorkloadStatus = 'no_goal' | 'no_data' | 'under' | 'healthy' | 'over';
export interface WorkloadRow {
  employee_id: string;
  name: string;
  team_id: string | null;
  team_name: string | null;
  days_worked: number;
  active_seconds: number;
  productive_seconds: number;
  goal_hours: number | null;
  under_percent: number | null;
  over_percent: number | null;
  /** Productive time per day worked as a percentage of the daily goal. */
  utilisation: number | null;
  status: WorkloadStatus;
  /** Explained time away from the computer. productive_seconds already includes the productive part of it. */
  offline_seconds: number;
}
export interface CapacityRow {
  team_id: string | null;
  team_name: string | null;
  people: number;
  person_days: number;
  productive_seconds: number;
  goal_hours: number | null;
  avg_productive_hours: number;
  /** Negative when the team is above its goal. */
  gap_hours: number | null;
  fte_gap: number | null;
  /** Null unless the caller is a manager not limited to teams. */
  annual_salary: number | null;
  annual_cost: number | null;
  monthly_cost: number | null;
}
export interface WorkforceCost { team_id: string | null; annual_salary: number }

export type DataRequestKind = 'access' | 'correction' | 'objection' | 'deletion' | 'other';
export type DataRequestStatus = 'open' | 'in_progress' | 'completed' | 'rejected';
export interface DataRequest {
  id: string;
  employee_id: string;
  kind: DataRequestKind;
  message: string;
  status: DataRequestStatus;
  response: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntegrityAlert {
  employee_id: string;
  employee_name: string;
  occurred_at: string;
  kind: string;
  severity: 'high' | 'medium' | 'low';
  details: Record<string, unknown>;
}

export interface SupportGrant { id: string; reason: string; expires_at: string; revoked_at: string | null; created_at: string }

export interface Payment {
  reference: string; amount_cents: number; currency: string; seats: number; months: number; paid_at: string;
}

export interface PlanQuote {
  kind: 'new' | 'renewal' | 'upgrade' | 'downgrade' | 'current' | 'seats';
  gross_cents: number;
  net_cents?: number;
  vat_cents?: number;
  seats: number;
  min_seats?: number;
  plan: string;
  intent_id?: string;
  message?: string;
}

export interface Invoice {
  number: string;
  issued_at: string;
  organization_name: string;
  plan_name: string;
  description: string;
  seats: number;
  net_cents: number;
  vat_cents: number;
  gross_cents: number;
  vat_rate: number;
  vat_enabled: boolean;
  business_name: string;
  business_vat_number: string | null;
  business_address: string;
}

export interface OperatorOrg {
  organization_id: string;
  name: string;
  created_at: string;
  owner_name: string | null;
  owner_email: string | null;
  plan: string | null;
  status: ServiceStatus['status'] | null;
  level: ServiceLevel | null;
  seats: number | null;
  active_employees: number;
  activated_employees: number;
  agents_online: number;
  last_activity_at: string | null;
  current_period_end: string | null;
  support_access_until: string | null;
}

export interface SystemHealth {
  organizations: number;
  paying_organizations: number;
  free_organizations: number;
  active_employees: number;
  agents_online: number;
  segments_last_24h: number;
  last_maintenance_at: string | null;
  open_data_requests: number;
}

export interface OperatorAuditEntry {
  id: number; operator_auth_id: string | null; operator_email: string | null; action: string;
  organization_id: string | null; details: Record<string, unknown>; created_at: string;
}

export interface SupportSnapshotRow {
  employee_id: string; name: string; role: Role; is_active: boolean; activated: boolean;
  agent_version: string | null; agent_state: string | null; last_seen_at: string | null; hostname: string | null;
  os_version: string | null; needs_acknowledgement: boolean; recent_problems: { type: string; at: string }[] | null;
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
  const msg = e.message?.trim() ?? '';
  if (e.code === '42501' && (!msg || /^permission denied\b/i.test(msg) || msg === 'Not allowed')) {
    return "You don't have permission to do that.";
  }
  return sayManager(msg) || 'Something went wrong.';
}

/** The account that creates the organisation is stored as owner. The product calls that person a manager. */
function sayManager(text: string): string {
  return text
    .replace(/\bOwners\b/g, 'Managers')
    .replace(/\bowners\b/g, 'managers')
    .replace(/\bOwner\b/g, 'Manager')
    .replace(/\bowner\b/g, 'manager');
}

async function functionError(error: unknown): Promise<string> {
  const fallback = errorMessage(error);
  const response = (error as { context?: { json?: () => Promise<unknown> } }).context;
  if (!response?.json) return fallback;
  try {
    const body = await response.json();
    if (body && typeof body === 'object') {
      const text = (body as { error?: unknown; message?: unknown }).error
        ?? (body as { message?: unknown }).message;
      if (typeof text === 'string' && text.trim() && !text.includes('non-2xx')) return sayManager(text);
    }
  } catch {
    return fallback;
  }
  return fallback;
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

const num = (v: unknown) => Number(v ?? 0);
const optNum = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function nullableNumeric<T extends object>(rows: T[], keys: (keyof T)[]): T[] {
  return rows.map((r) => {
    const copy = { ...r };
    for (const k of keys) (copy as Record<keyof T, unknown>)[k] = optNum(r[k]);
    return copy;
  });
}

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

  dailyTotals: async (employee: string, from: Ymd, to: Ymd, project?: string | null) =>
    numeric(await rpc<DailyTotal[]>('get_daily_totals', { p_employee: employee, p_from: from, p_to: to, ...projectQuery(project) }),
      ['active_seconds', 'idle_seconds', 'away_seconds', 'paused_seconds', 'meeting_seconds', 'call_seconds',
        'break_seconds', 'other_seconds', 'productive_offline_seconds']),

  appTotals: async (employee: string, from: Ymd, to: Ymd, project?: string | null) =>
    numeric(await rpc<AppTotal[]>('get_app_totals', { p_employee: employee, p_from: from, p_to: to, ...projectQuery(project) }),
      ['active_seconds', 'idle_seconds']),

  domainTotals: async (employee: string, from: Ymd, to: Ymd, project?: string | null) =>
    numeric(await rpc<DomainTotal[]>('get_domain_totals', { p_employee: employee, p_from: from, p_to: to, ...projectQuery(project) }),
      ['active_seconds', 'idle_seconds']),

  projectTotals: async (employee: string, from: Ymd, to: Ymd) =>
    numeric(await rpc<ProjectTotal[]>('get_project_totals', { p_employee: employee, p_from: from, p_to: to }),
      ['active_seconds', 'idle_seconds']),

  timeline: (employee: string, day: Ymd, project?: string | null) =>
    rpc<TimelineRow[]>('get_timeline', { p_employee: employee, p_day: day, ...projectQuery(project) }),

  projects: async () => {
    const { data, error } = await supabase.from('projects').select('id,name,is_active').order('name');
    if (error) throw error;
    return (data ?? []) as Project[];
  },

  complianceSettings: async (organizationId: string): Promise<ComplianceSettings> => {
    const [settings, org] = await Promise.all([
      supabase.from('organization_settings').select(SETTINGS_COLUMNS).eq('organization_id', organizationId).single(),
      supabase.from('organizations').select('information_officer_name,information_officer_email').eq('id', organizationId).single(),
    ]);
    if (settings.error) throw settings.error;
    if (org.error) throw org.error;
    return { ...(settings.data as unknown as Record<string, unknown>), ...org.data } as ComplianceSettings;
  },

  /** Saves settings and Information Officer together; returns the current notice version. */
  saveComplianceSettings: (s: Omit<ComplianceSettings, 'updated_at'>) => {
    const { information_officer_name, information_officer_email, ...settings } = s;
    return rpc<Policy>('save_compliance_settings', {
      p_settings: settings,
      p_information_officer_name: information_officer_name,
      p_information_officer_email: information_officer_email,
    });
  },

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
      .select('id,name,email,employee_code,role,is_active,auth_user_id,created_at,team_id')
      .order('name');
    if (error) throw error;
    return (data ?? []) as EmployeeRow[];
  },

  employee: async (id: string) => {
    const { data, error } = await supabase
      .from('employees')
      .select('id,name,email,employee_code,role,is_active,auth_user_id,created_at,team_id')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data as EmployeeRow | null;
  },

  createEmployee: async (name: string, email: string, role: Role, code?: string, teamId?: string | null) =>
    (await rpc<ActivationResult[]>('create_employee', {
      p_name: name, p_email: email, p_role: role, p_employee_code: code || null, p_team_id: teamId || null,
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
    if (filter.project === NO_PROJECT) q = q.is('project_id', null);
    else if (filter.project) q = q.eq('project_id', filter.project);
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

  // ---- subscription and billing ----------------------------------------
  serviceStatus: async () => {
    const rows = await rpc<ServiceStatus[]>('get_my_service_status');
    return rows[0] ?? null;
  },

  payments: async () => {
    const { data, error } = await supabase.from('payments')
      .select('reference,amount_cents,currency,seats,months,paid_at').order('paid_at', { ascending: false }).limit(50);
    if (error) throw error;
    return (data ?? []) as Payment[];
  },

  /** Preview of a plan change. Nothing is charged and no downgrade is scheduled. */
  quotePlan: (plan: string, seats?: number) => rpc<PlanQuote>('quote_plan_change', {
    p_plan: plan, p_commit: false, p_seats: seats ?? null,
  }),
  purchasedSeats: () => rpc<PurchasedSeat[]>('list_subscription_seats'),
  scheduleSeatRemoval: (seat: string) => rpc<void>('schedule_seat_removal', { p_seat: seat }),
  keepSeat: (seat: string) => rpc<void>('keep_subscription_seat', { p_seat: seat }),

  /** Schedules a downgrade or cancellation for the end of the paid year. */
  commitPlanChange: (plan: string) => rpc<PlanQuote>('quote_plan_change', { p_plan: plan, p_commit: true }),

  cancelPlanChange: () => rpc<void>('cancel_pending_plan_change'),

  invoices: () => rpc<Invoice[]>('get_my_invoices'),

  /** Starts a Yoco payment for one plan. The webhook, not the return page, confirms it. */
  startCheckout: async (plan: string, urls: { success: string; cancel?: string; failure?: string }) => {
    const { data, error } = await supabase.functions.invoke('yoco-checkout', {
      body: { plan, return_url: urls.success, cancel_url: urls.cancel, failure_url: urls.failure },
    });
    if (error) {
      const ctx = (error as { context?: Response }).context;
      let message = 'Online payment is not available yet.';
      try {
        const body = ctx ? await ctx.json() : null;
        if (body?.error) message = body.error;
      } catch { /* keep the generic message */ }
      throw new Error(message);
    }
    return data as { redirect_url: string | null; reference?: string; amount_cents: number; kind?: string; message?: string };
  },

  supportGrants: async () => {
    const { data, error } = await supabase.from('support_access_grants')
      .select('id,reason,expires_at,revoked_at,created_at').order('created_at', { ascending: false }).limit(20);
    if (error) throw error;
    return (data ?? []) as SupportGrant[];
  },
  grantSupportAccess: (hours: number, reason: string) => rpc('grant_support_access', { p_hours: hours, p_reason: reason }),
  revokeSupportAccess: () => rpc<void>('revoke_support_access'),

  notificationPreferences: async () =>
    (await rpc<{ weekly_digest: boolean; alert_emails: boolean }[]>('get_my_notification_preferences'))[0]
      ?? { weekly_digest: true, alert_emails: true },
  setNotificationPreferences: (weeklyDigest: boolean, alertEmails: boolean) =>
    rpc<void>('set_my_notification_preferences', { p_weekly_digest: weeklyDigest, p_alert_emails: alertEmails }),

  // ---- teams -------------------------------------------------------------
  teams: async () => {
    const [teams, managers] = await Promise.all([
      supabase.from('teams').select('id,name,office_days_per_week').order('name'),
      supabase.from('team_managers').select('team_id,employee_id'),
    ]);
    if (teams.error) throw teams.error;
    if (managers.error) throw managers.error;
    return { teams: (teams.data ?? []) as Team[], managers: (managers.data ?? []) as TeamManager[] };
  },
  saveTeam: (id: string | null, name: string) => rpc<Team>('save_team', { p_team: id, p_name: name }),
  setTeamOfficeDays: (team: string, days: number | null) =>
    rpc<void>('set_team_office_days', { p_team: team, p_days: days }),
  officeNetworks: async () => {
    const { data, error } = await supabase.from('office_networks').select('id,name,cidrs,wifi_names').order('name');
    if (error) throw error;
    return (data ?? []) as OfficeNetwork[];
  },
  saveOfficeNetwork: (name: string, cidrs: string[], wifi: string[]) =>
    rpc<OfficeNetwork>('save_office_network', { p_id: null, p_name: name, p_cidrs: cidrs, p_wifi: wifi }),
  deleteOfficeNetwork: (id: string) => rpc<void>('delete_office_network', { p_id: id }),
  workLocations: (employee: string, from: Ymd, to: Ymd) =>
    rpc<WorkLocationDay[]>('get_work_locations', { p_employee: employee, p_from: from, p_to: to }),
  officeAdherence: async (from: Ymd, to: Ymd, team?: string | null) =>
    nullableNumeric(
      numeric(await rpc<OfficeAdherence[]>('get_office_adherence', { p_from: from, p_to: to, p_team: team ?? null }),
        ['office_days', 'remote_days', 'mixed_days', 'weeks_judged']),
      ['target_per_week', 'weeks_met']),
  aiCatalog: () => rpc<AiCatalogTool[]>('get_ai_catalog'),
  setAiToolApproval: (tool: string, status: 'approved' | 'unapproved' | 'unset') =>
    rpc<void>('set_ai_tool_approval', { p_tool: tool, p_status: status }),
  aiAdoption: async (from: Ymd, to: Ymd, team?: string | null) =>
    numeric(await rpc<AiAdoptionRow[]>('get_ai_adoption', { p_from: from, p_to: to, p_team: team ?? null }),
      ['people_using', 'people']),
  aiPersonUsage: async (from: Ymd, to: Ymd, team?: string | null) =>
    nullableNumeric(
      numeric(await rpc<AiPersonUsage[]>('get_ai_person_usage', { p_from: from, p_to: to, p_team: team ?? null }),
        ['days_used', 'days_per_week']),
      ['before_hours', 'after_hours', 'before_days', 'after_days']),
  advisorQuestions: () => rpc<AdvisorQuestion[]>('list_advisor_questions'),
  coachingNotes: () => rpc<CoachingNote[]>('list_coaching_notes'),
  askAdvisor: async (
    template: 'week' | 'workload' | 'software' | 'capacity' | 'trend',
    from: Ymd, to: Ymd, team?: string | null, scope?: string,
  ) => {
    const { data, error } = await supabase.functions.invoke('work-advisor', {
      body: { template, from, to, team: team ?? null, scope: scope ?? null },
    });
    if (error) throw new Error(await functionError(error));
    if (!data?.answer) throw new Error(data?.error ?? 'No answer was returned.');
    return String(data.answer);
  },
  /** Every written report for the period, for one PDF. Nothing is saved in the report list. */
  advisorPdf: async (from: Ymd, to: Ymd, team?: string | null, scope?: string) => {
    const { data, error } = await supabase.functions.invoke('work-advisor', {
      body: { template: 'all', from, to, team: team ?? null, scope: scope ?? null },
    });
    if (error) throw new Error(await functionError(error));
    const sections = data?.sections;
    if (!Array.isArray(sections) || sections.length === 0) {
      throw new Error(data?.error ?? 'No report was returned.');
    }
    return sections.map((section: { title?: unknown; answer?: unknown }) => ({
      title: String(section.title ?? 'Report'),
      answer: String(section.answer ?? ''),
    }));
  },
  deleteTeam: (id: string) => rpc<void>('delete_team', { p_team: id }),
  setEmployeeTeam: (employee: string, team: string | null) => rpc<void>('set_employee_team', { p_employee: employee, p_team: team }),
  setTeamManagers: (team: string, managers: string[]) => rpc<void>('set_team_managers', { p_team: team, p_managers: managers }),

  // ---- productivity categories ------------------------------------------
  categoryRules: async () => {
    const { data, error } = await supabase.from('app_categories').select('id,kind,pattern,category,team_id').order('pattern');
    if (error) throw error;
    return (data ?? []) as CategoryRule[];
  },
  /** team null = a rule for the whole company. */
  setCategory: (kind: 'app' | 'domain', pattern: string, category: Category, team: string | null = null) =>
    rpc<CategoryRule>('set_app_category', { p_kind: kind, p_pattern: pattern, p_category: category, p_team: team }),
  deleteCategory: (id: string) => rpc<void>('delete_app_category', { p_id: id }),
  /**
   * Apps and websites for one day, split by project.
   * Built from the existing totals functions. Work with no project is what remains after every named project.
   */
  dayBreakdown: async (employee: string, day: Ymd) => {
    const projects = await api.projectTotals(employee, day, day);
    const unassigned = projects.find((project) => !project.project_id);
    const named = projects.filter((project) => project.project_id);
    const [allApps, allDomains, slices] = await Promise.all([
      unassigned ? api.appTotals(employee, day, day) : Promise.resolve([]),
      unassigned ? api.domainTotals(employee, day, day) : Promise.resolve([]),
      Promise.all(named.map(async (project) => {
        const [apps, domains] = await Promise.all([
          api.appTotals(employee, day, day, project.project_id),
          api.domainTotals(employee, day, day, project.project_id),
        ]);
        return {
          project_id: project.project_id as string,
          project_name: project.project_name,
          apps: apps.map((app) => ({ label: app.app_name, active_seconds: app.active_seconds, idle_seconds: app.idle_seconds })),
          domains: domains.map((site) => ({
            label: site.domain, active_seconds: site.active_seconds, idle_seconds: site.idle_seconds, sample_title: site.sample_title,
          })),
        };
      })),
    ]);
    return assembleDayBreakdown({
      unassignedName: unassigned?.project_name ?? null,
      allApps: allApps.map((app) => ({ label: app.app_name, active_seconds: app.active_seconds, idle_seconds: app.idle_seconds })),
      allDomains: allDomains.map((site) => ({
        label: site.domain, active_seconds: site.active_seconds, idle_seconds: site.idle_seconds, sample_title: site.sample_title,
      })),
      named: slices,
    });
  },

  categoryTotals: async (employee: string, from: Ymd, to: Ymd, project?: string | null) =>
    numeric(await rpc<CategoryTotal[]>('get_category_totals', { p_employee: employee, p_from: from, p_to: to, ...projectQuery(project) }),
      ['active_seconds', 'idle_seconds']),

  // ---- POPIA requests ------------------------------------------------------
  dataRequests: async () => {
    const { data, error } = await supabase.from('data_requests')
      .select('id,employee_id,kind,message,status,response,created_at,updated_at').order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as DataRequest[];
  },
  submitDataRequest: (kind: DataRequestKind, message: string) =>
    rpc<DataRequest>('submit_data_request', { p_kind: kind, p_message: message }),
  respondDataRequest: (id: string, status: Exclude<DataRequestStatus, 'open'>, response: string) =>
    rpc<DataRequest>('respond_data_request', { p_request: id, p_status: status, p_response: response }),

  // ---- alerts ----------------------------------------------------------------
  integrityAlerts: (sinceIso: string) => rpc<IntegrityAlert[]>('get_integrity_alerts', { p_since: sinceIso }),

  // ---- agent install key -----------------------------------------------------
  installKey: () => rpc<string>('get_install_key'),
  rotateInstallKey: () => rpc<string>('rotate_install_key'),

  // ---- plan features ---------------------------------------------------------
  features: async () => (await rpc<string[] | null>('get_my_features')) ?? [],
  planCatalogue: () => rpc<PlanCatalogueEntry[]>('get_plan_catalogue'),

  // ---- working hours per team or person --------------------------------------
  workSchedules: async () => {
    const { data, error } = await supabase.from('work_schedules')
      .select('id,team_id,employee_id,work_days,work_start,work_end');
    if (error) throw error;
    return (data ?? []) as WorkSchedule[];
  },
  /** Exactly one of team / employee. Returns the current notice (a new version when the hours are in force). */
  saveWorkSchedule: (target: { team?: string; employee?: string }, days: number[], start: string, end: string) =>
    rpc<Policy>('save_work_schedule', {
      p_team: target.team ?? null, p_employee: target.employee ?? null, p_work_days: days, p_work_start: start, p_work_end: end,
    }),
  deleteWorkSchedule: (target: { team?: string; employee?: string }) =>
    rpc<Policy>('delete_work_schedule', { p_team: target.team ?? null, p_employee: target.employee ?? null }),

  // ---- productivity goals ----------------------------------------------------
  goals: async () => {
    const { data, error } = await supabase.from('productivity_goals')
      .select('id,team_id,productive_hours,under_percent,over_percent');
    if (error) throw error;
    return numeric((data ?? []) as Goal[], ['productive_hours']);
  },
  /** team null = the company-wide goal. */
  saveGoal: (team: string | null, productiveHours: number, underPercent: number, overPercent: number) =>
    rpc<Goal>('save_goal', {
      p_team: team, p_productive_hours: productiveHours, p_under_percent: underPercent, p_over_percent: overPercent,
    }),
  deleteGoal: (team: string | null) => rpc<void>('delete_goal', { p_team: team }),

  // ---- workforce analytics (at most 400 days per request) ----------------------
  trend: async (from: Ymd, to: Ymd, granularity: Granularity, team: string | null = null, employee: string | null = null) =>
    numeric(
      await rpc<TrendPoint[]>('get_trend', { p_from: from, p_to: to, p_granularity: granularity, p_team: team, p_employee: employee }),
      ['active_seconds', 'idle_seconds', 'productive_seconds', 'unproductive_seconds',
        'offline_seconds', 'productive_offline_seconds'],
    ),
  softwareUsage: async (from: Ymd, to: Ymd, kind: 'app' | 'domain', team: string | null = null) =>
    nullableNumeric(
      numeric(await rpc<SoftwareUsage[]>('get_software_usage', { p_from: from, p_to: to, p_kind: kind, p_team: team }),
        ['active_seconds']),
      ['monthly_cost_per_seat'],
    ),
  /** Managers not limited to teams. The name is matched case-insensitively. */
  setLicence: (kind: 'app' | 'domain', name: string, seats: number, monthlyCostPerSeat: number | null) =>
    rpc<void>('set_software_licence', { p_kind: kind, p_name: name, p_seats: seats, p_monthly_cost_per_seat: monthlyCostPerSeat }),
  deleteLicence: (id: string) => rpc<void>('delete_software_licence', { p_id: id }),
  workload: async (from: Ymd, to: Ymd, team: string | null = null) =>
    nullableNumeric(
      numeric(await rpc<WorkloadRow[]>('get_workload', { p_from: from, p_to: to, p_team: team }),
        ['active_seconds', 'productive_seconds', 'offline_seconds']),
      ['goal_hours', 'utilisation'],
    ),
  capacity: async (from: Ymd, to: Ymd) =>
    nullableNumeric(
      numeric(await rpc<CapacityRow[]>('get_capacity', { p_from: from, p_to: to }),
        ['productive_seconds', 'avg_productive_hours']),
      ['goal_hours', 'gap_hours', 'fte_gap', 'annual_salary', 'annual_cost', 'monthly_cost'],
    ),
  workforceCosts: async () =>
    numeric(await rpc<WorkforceCost[]>('get_workforce_costs'), ['annual_salary']),
  /** team null = the company average. A null salary removes it. */
  setWorkforceCost: (team: string | null, annualSalary: number | null) =>
    rpc<void>('set_workforce_cost', { p_team: team, p_annual_salary: annualSalary }),

  // ---- alert rules (managers not limited to teams change them) -----
  alertRules: async () => {
    const { data, error } = await supabase.from('alert_rules')
      .select('id,name,kind,pattern,severity,action,work_hours_only,enabled,pack').order('name');
    if (error) throw error;
    return (data ?? []) as AlertRule[];
  },
  saveAlertRule: (r: Omit<AlertRule, 'id' | 'pack'> & { id: string | null }) =>
    rpc<AlertRule>('save_alert_rule', {
      p_id: r.id, p_name: r.name, p_kind: r.kind, p_pattern: r.pattern, p_severity: r.severity,
      p_work_hours_only: r.work_hours_only, p_enabled: r.enabled, p_action: r.action,
    }),
  deleteAlertRule: (id: string) => rpc<void>('delete_alert_rule', { p_id: id }),
  /** Returns how many rules were added (ones already there are kept as they are). */
  addAlertRulePack: (pack: RulePack) => rpc<number>('add_alert_rule_pack', { p_pack: pack }),

  // ---- Slack / Teams / webhook channels (the address is never sent back) -------
  channels: () => rpc<NotificationChannel[]>('list_notification_channels'),
  /** The signing secret (webhooks only) is shown once. */
  addChannel: async (kind: ChannelKind, name: string, url: string, minSeverity: Severity) =>
    (await rpc<{ id: string; signing_secret: string | null }[]>('add_notification_channel', {
      p_kind: kind, p_name: name, p_url: url, p_min_severity: minSeverity,
    }))[0],
  updateChannel: (id: string, name: string, minSeverity: Severity, enabled: boolean) =>
    rpc<void>('update_notification_channel', { p_id: id, p_name: name, p_min_severity: minSeverity, p_enabled: enabled }),
  deleteChannel: (id: string) => rpc<void>('delete_notification_channel', { p_id: id }),
  /** Sends a test message; throws with the reason when the channel did not accept it. */
  testChannel: async (id: string): Promise<void> => {
    const { error } = await supabase.functions.invoke('channel-test', { body: { channel_id: id } });
    if (error) {
      const ctx = (error as { context?: Response }).context;
      let message = 'The test could not be sent. Try again later.';
      try {
        const body = ctx ? await ctx.json() : null;
        if (body?.error) message = body.error;
      } catch { /* keep the generic message */ }
      throw new Error(message);
    }
  },

  // ---- read-only API keys -------------------------------------------------------
  apiKeys: () => rpc<ApiKey[]>('list_api_keys'),
  /** The key itself is shown once. */
  createApiKey: async (name: string) => (await rpc<{ id: string; api_key: string }[]>('create_api_key', { p_name: name }))[0],
  revokeApiKey: (id: string) => rpc<void>('revoke_api_key', { p_id: id }),

  // ---- file activity (every view by someone other than the person is audited) ---
  offlineEntries: (employee: string, fromIso: string, toIso: string) =>
    rpc<OfflineEntry[]>('get_offline_entries', { p_employee: employee, p_from: fromIso, p_to: toIso }),

  fileActivity: async (employee: string, fromIso: string, toIso: string) =>
    nullableNumeric(
      numeric(await rpc<FileEvent[]>('get_file_activity', { p_employee: employee, p_from: fromIso, p_to: toIso }), ['file_count']),
      ['size_bytes'],
    ),
};

/** Functions only platform operators (the SaaS provider, signed in with two-factor) may call. */
export const operatorApi = {
  isOperator: () => rpc<boolean>('am_i_platform_admin'),
  organizations: () => rpc<OperatorOrg[]>('op_organizations'),
  seats: (org: string) => rpc<PurchasedSeat[]>('op_subscription_seats', { p_org: org }),
  health: async () => (await rpc<SystemHealth[]>('op_system_health'))[0],
  audit: (limit = 200) => rpc<OperatorAuditEntry[]>('op_operator_audit', { p_limit: limit }),
  updateSubscription: (org: string, changes: {
    plan?: string | null; status?: string | null; seats?: number | null;
    current_period_end?: string | null;
  }, note: string) => rpc('op_update_subscription', {
    p_org: org, p_plan: changes.plan ?? null, p_status: changes.status ?? null, p_seats: changes.seats ?? null,
    p_current_period_end: changes.current_period_end ?? null, p_note: note,
  }),
  supportSnapshot: (org: string) => rpc<SupportSnapshotRow[]>('op_support_snapshot', { p_org: org }),
  deleteOrganization: (org: string, confirmName: string) =>
    rpc<void>('op_delete_organization', { p_org: org, p_confirm_name: confirmName }),
  aiTools: () => rpc<OperatorAiTool[]>('op_ai_tools'),
  saveAiTool: (id: string | null, name: string, domains: string[], apps: string[], enabled: boolean) =>
    rpc<OperatorAiTool>('op_save_ai_tool', { p_id: id, p_name: name, p_domains: domains, p_apps: apps, p_enabled: enabled }),
  deleteAiTool: (id: string) => rpc<void>('op_delete_ai_tool', { p_id: id }),
};
