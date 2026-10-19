import { type OperatorOrg } from './api';
import { formatDate } from './format';

export const PLAN_NAME: Record<string, string> = {
  free: 'Free',
  work_activity: 'Work Activity',
  workforce: 'Workforce',
  productivity: 'Productivity',
};

export const STATUS_NAME: Record<string, string> = {
  active: 'Active',
  past_due: 'Overdue',
  lapsed: 'Moved to Free',
  suspended: 'Suspended',
  cancelled: 'Cancelled',
};

export function planName(plan: string | null): string {
  if (!plan) return 'No plan';
  return PLAN_NAME[plan] ?? plan;
}

export function statusName(status: string | null): string {
  if (!status) return 'No subscription';
  return STATUS_NAME[status] ?? status;
}

export interface Attention {
  code: 'past_due' | 'read_only' | 'seats' | 'silent';
  label: string;
}

/** Reasons an operator should look at this account. `cap` is the plan limit. Null means the plan does not limit people. */
export function attentionReasons(o: OperatorOrg, now = Date.now(), cap: number | null = null): Attention[] {
  const reasons: Attention[] = [];
  if (o.status === 'past_due') reasons.push({ code: 'past_due', label: 'Payment overdue' });
  if (o.level === 'read_only') reasons.push({ code: 'read_only', label: 'Recording stopped' });
  if (cap !== null && o.active_employees > cap) reasons.push({ code: 'seats', label: 'More people than the seats allow' });
  const quiet = o.activated_employees > 0 && o.agents_online === 0
    && (!o.last_activity_at || now - Date.parse(o.last_activity_at) > 24 * 3_600_000);
  if (quiet && o.status !== 'cancelled' && o.level !== 'read_only') {
    reasons.push({ code: 'silent', label: 'No agent check-in in 24 hours' });
  }
  return reasons;
}

export function needsAttention(o: OperatorOrg, now = Date.now(), cap: number | null = null): boolean {
  return attentionReasons(o, now, cap).length > 0;
}

/** Active people, with the plan limit only when the plan has one. */
export function peopleLabel(active: number, cap: number | null): string {
  return cap === null ? String(active) : `${active} / ${cap}`;
}

/** Seats with an active person, and seats still empty. The two numbers add up to the seats on the account. */
export function seatOccupancy(active: number, capacity: number): { registered: number; vacant: number } {
  const pool = Math.max(0, capacity);
  const registered = Math.min(Math.max(0, active), pool);
  return { registered, vacant: pool - registered };
}

/** A downgrade, cancellation, or upgrade that has not started yet. */
export function planChangeSummary(
  o: OperatorOrg,
  plans: { key: string; name: string; rank: number }[] = [],
): string | null {
  const date = o.current_period_end ? formatDate(o.current_period_end) : 'the end of the current term';
  const nameOf = (key: string | null | undefined) => plans.find((p) => p.key === key)?.name ?? planName(key ?? null);
  if (o.prepaid_plan) return `${nameOf(o.prepaid_plan)} is paid and starts on ${date}`;
  if (o.pending_plan) {
    const current = plans.find((p) => p.key === o.plan);
    const next = plans.find((p) => p.key === o.pending_plan);
    const down = o.pending_plan === 'free' || (!!current && !!next && next.rank < current.rank);
    if (down) return `Downgrade to ${nameOf(o.pending_plan)} on ${date}`;
    return `Upgrade to ${nameOf(o.pending_plan)} is scheduled for ${date} and is not paid yet`;
  }
  if (o.cancel_at_period_end) return `Moves to Free on ${date}`;
  return null;
}

export function supportOpen(o: OperatorOrg, now = Date.now()): boolean {
  return !!o.support_access_until && Date.parse(o.support_access_until) > now;
}

/** Nightly maintenance should have run within the last day and a half. */
export function maintenanceLate(at: string | null, now = Date.now()): boolean {
  if (!at) return true;
  return now - Date.parse(at) > 36 * 3_600_000;
}

export function statusLine(o: OperatorOrg): string {
  const status = o.status === 'cancelled' || o.status === 'suspended'
    ? statusName(o.status)
    : o.plan === 'free'
      ? 'Free plan'
      : o.status === 'active' || o.status === 'past_due'
        ? `${o.status === 'past_due' ? 'Overdue, ' : ''}paid until ${formatDate(o.current_period_end)}`
        : statusName(o.status);
  return `${planName(o.plan)} · ${status}${o.level === 'read_only' ? ' · read only' : ''}`;
}
