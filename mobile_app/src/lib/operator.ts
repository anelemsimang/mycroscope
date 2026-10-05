import { inCaseStudy, type OperatorOrg } from './api';
import { formatDate } from './format';

export const CASE_STUDY_MONTHS = ['3', '6', '12', '24'] as const;

export function needsAttention(o: OperatorOrg): boolean {
  return o.level === 'read_only' || o.status === 'past_due' || (o.seats !== null && o.active_employees > o.seats);
}

export function statusLine(o: OperatorOrg): string {
  const status = inCaseStudy(o) ? `case study until ${formatDate(o.case_study_until)}`
    : o.status === 'trialing' ? `trial until ${formatDate(o.trial_ends_at)}`
    : o.status === 'active' || o.status === 'past_due' ? `${o.status === 'past_due' ? 'overdue, ' : ''}paid until ${formatDate(o.current_period_end)}`
    : o.status ?? 'no subscription';
  return `${o.plan ?? '–'} · ${status}${o.level === 'read_only' ? ' · READ-ONLY' : ''}`;
}
