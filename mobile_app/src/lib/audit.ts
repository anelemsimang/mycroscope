// Plain-language descriptions of audit log entries.
import type { AuditEntry } from './api';
import { formatDateTime } from './format';

export type AuditFilter = 'all' | 'access' | 'deletions' | 'settings' | 'accounts' | 'retention';

export const AUDIT_FILTERS: { value: AuditFilter; label: string; actions?: string[] }[] = [
  { value: 'all', label: 'All' },
  { value: 'access', label: 'Data access', actions: ['viewed_employee', 'exported_report', 'exported_data'] },
  { value: 'deletions', label: 'Deletions', actions: ['activity_deleted', 'employee_deleted'] },
  { value: 'settings', label: 'Settings & notice', actions: ['settings_updated', 'organization_updated', 'policy_published'] },
  { value: 'accounts', label: 'Accounts', actions: ['organization_created', 'employee_created', 'employee_updated', 'activation_code_issued', 'employee_activated'] },
  { value: 'retention', label: 'Retention', actions: ['retention_purge'] },
];

const SETTING_LABELS: Record<string, string> = {
  track_apps: 'Applications',
  track_window_titles: 'Window titles',
  track_web_domains: 'Websites',
  track_full_urls: 'Full web addresses',
  idle_threshold_seconds: 'Idle after',
  allow_pause: 'Pausing allowed',
  retention_days: 'Detailed activity kept',
  summary_retention_days: 'Daily totals kept',
  notice_custom_text: 'Message to employees',
  name: 'Organisation name',
  timezone: 'Timezone',
  information_officer_name: 'Information Officer',
  information_officer_email: 'Information Officer email',
};

function settingValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (key === 'idle_threshold_seconds') return `${Number(value) / 60} min`;
  if (key.endsWith('retention_days')) return `${value} days`;
  if (key === 'notice_custom_text') return 'edited';
  return String(value);
}

/** "Websites: on → off; Detailed activity kept: 90 days → 60 days" for before/after snapshots. */
export function describeChanges(before: unknown, after: unknown): string {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  return Object.keys(SETTING_LABELS)
    .filter((k) => k in a && JSON.stringify(b[k] ?? null) !== JSON.stringify(a[k] ?? null))
    .map((k) => k === 'notice_custom_text'
      ? `${SETTING_LABELS[k]} edited`
      : `${SETTING_LABELS[k]}: ${settingValue(k, b[k])} → ${settingValue(k, a[k])}`)
    .join('; ');
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

const PROVIDER_ACTIONS = new Set([
  'payment_received', 'subscription_changed_by_provider', 'support_access_used', 'case_study_started', 'case_study_ended',
]);

export function describeAudit(
  e: AuditEntry, names: Map<string, string>, timeZone: string,
): { actor: string; title: string; detail: string } {
  const d = e.details ?? {};
  const target = (e.target_type === 'employee' && e.target_id && names.get(e.target_id))
    || str(d.name) || 'a deleted employee';
  const actor = e.actor_employee_id
    ? names.get(e.actor_employee_id) ?? 'A deleted user'
    : e.action === 'retention_purge' ? 'System'
    : PROVIDER_ACTIONS.has(e.action) ? 'Mycroscope' : 'Unknown';
  const range = d.from && d.to
    ? (String(d.from).includes('T')
      ? `${formatDateTime(str(d.from), timeZone)} to ${formatDateTime(str(d.to), timeZone)}`
      : `${str(d.from)} to ${str(d.to)}`)
    : str(d.day);

  switch (e.action) {
    case 'viewed_employee':
      return { actor, title: `Viewed ${target}'s activity`, detail: '' };
    case 'exported_report':
      return { actor, title: `Exported a report covering ${target}`, detail: [range, str(d.format).toUpperCase()].filter(Boolean).join(' · ') };
    case 'exported_data':
      return { actor, title: `Exported ${target}'s activity data`, detail: [range, str(d.format).toUpperCase()].filter(Boolean).join(' · ') };
    case 'activity_deleted':
      return { actor, title: `Deleted ${target}'s activity`, detail: `${str(d.segments)} record(s), ${range}. Reason: ${str(d.reason)}` };
    case 'employee_deleted':
      return { actor, title: `Deleted employee ${str(d.name) || target}`, detail: `Reason: ${str(d.reason)}` };
    case 'employee_created':
      return { actor, title: `Added ${target} as ${str(d.role) || 'employee'}`, detail: str(d.email) };
    case 'employee_updated': {
      const b = (d.before ?? {}) as Record<string, unknown>;
      const a = (d.after ?? {}) as Record<string, unknown>;
      const parts: string[] = [];
      if (b.name !== a.name) parts.push(`name ${str(b.name)} → ${str(a.name)}`);
      if (b.role !== a.role) parts.push(`role ${str(b.role)} → ${str(a.role)}`);
      if (b.is_active !== a.is_active) parts.push(a.is_active ? 'reactivated' : 'deactivated');
      return { actor, title: `Updated ${target}`, detail: parts.join('; ') || 'No visible changes' };
    }
    case 'activation_code_issued':
      return { actor, title: `Issued an activation code for ${target}`, detail: '' };
    case 'employee_activated':
      return { actor, title: `${target} activated their account`, detail: '' };
    case 'organization_created':
      return { actor, title: 'Registered the organisation', detail: '' };
    case 'organization_updated':
      return { actor, title: 'Changed organisation details', detail: describeChanges(d.before, d.after) };
    case 'settings_updated':
      return { actor, title: 'Changed monitoring settings', detail: describeChanges(d.before, d.after) };
    case 'policy_published':
      return { actor, title: `Published monitoring notice version ${str(d.version)}`, detail: '' };
    case 'retention_purge':
      return {
        actor, title: 'Nightly clean-up deleted expired data',
        detail: `${str(d.segments)} activity record(s), ${str(d.events)} event(s), ${str(d.sessions)} session(s), ${str(d.summaries)} daily total(s) older than the retention period`,
      };
    case 'payment_received':
      return { actor, title: 'Payment received', detail: `${str(d.seats)} seats × ${str(d.months)} month(s) · reference ${str(d.reference)}` };
    case 'subscription_changed_by_provider':
      return { actor, title: 'Subscription changed by Mycroscope', detail: [str(d.plan), str(d.status), d.seats ? `${str(d.seats)} seats` : '', str(d.note)].filter(Boolean).join(' · ') };
    case 'support_access_used':
      return { actor, title: 'Mycroscope support opened the technical status view', detail: '' };
    case 'case_study_started':
      return {
        actor, title: 'Free case study started',
        detail: `Free until ${formatDateTime(str(d.case_study_until), timeZone)}, then a trial until ${formatDateTime(str(d.trial_ends_at), timeZone)}`,
      };
    case 'case_study_ended':
      return { actor, title: 'Free case study ended', detail: `Trial until ${formatDateTime(str(d.trial_ends_at), timeZone)}` };
    default:
      return { actor, title: e.action.replace(/_/g, ' '), detail: '' };
  }
}
