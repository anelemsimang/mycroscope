import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';

import {
  Button, Card, Empty, ErrorBanner, Field, InfoGrid, Loading, Pill, Screen, Segmented, colors, styles,
} from '@/components/ui';
import { inCaseStudy, operatorApi, type OperatorOrg } from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { formatDate, formatDateTime, formatRelative } from '@/lib/format';
import { CASE_STUDY_MONTHS, statusLine } from '@/lib/operator';
import { useAsync } from '@/lib/useAsync';

const ZONE = 'Africa/Johannesburg';
const PLANS = ['trial', 'standard', 'business', 'enterprise'] as const;
const STATUSES = ['trialing', 'active', 'past_due', 'suspended', 'cancelled'] as const;
const STATUS_LABEL: Record<(typeof STATUSES)[number], string> = {
  trialing: 'Trial', active: 'Active', past_due: 'Overdue', suspended: 'Suspended', cancelled: 'Cancelled',
};

const toYmd = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: ZONE }) : '');
/** End of the given day in South African time (no daylight saving, so a fixed offset is exact). */
const fromYmd = (ymd: string) => `${ymd}T23:59:59+02:00`;
const validYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(fromYmd(s)));

export default function OperatorOrgScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, loading, refreshing, refresh } = useAsync(async () => {
    const orgs = await operatorApi.organizations();
    const org = orgs.find((o) => o.organization_id === id) ?? null;
    const supportOpen = !!org?.support_access_until && new Date(org.support_access_until) > new Date();
    const snapshot = supportOpen ? await operatorApi.supportSnapshot(id) : null;
    return { org, snapshot, supportOpen };
  }, [id]);

  if (loading && !data) return <Loading />;
  const org = data?.org;
  if (!org) {
    return (
      <Screen>
        {error ? <ErrorBanner message={error} onRetry={refresh} /> : <Empty text="Customer not found." />}
      </Screen>
    );
  }

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      <Card title={org.name}>
        <Text style={styles.rowText}>{statusLine(org)}</Text>
        <InfoGrid items={[
          { label: 'Owner', value: `${org.owner_name ?? '–'}${org.owner_email ? ` (${org.owner_email})` : ''}` },
          { label: 'Signed up', value: formatDate(org.created_at) },
          { label: 'Seats used', value: `${org.active_employees} of ${org.seats ?? '–'}` },
          { label: 'Activated', value: String(org.activated_employees) },
          { label: 'Agents online', value: String(org.agents_online) },
          { label: 'Last activity', value: org.last_activity_at ? formatRelative(org.last_activity_at) : 'never' },
        ]} />
      </Card>
      <CaseStudyCard org={org} onSaved={refresh} />
      <SubscriptionEditor org={org} onSaved={refresh} />
      <SupportCard org={org} snapshot={data?.snapshot ?? null} open={!!data?.supportOpen} />
      {org.status === 'cancelled' ? <DeleteCard org={org} /> : null}
    </Screen>
  );
}

function CaseStudyCard({ org, onSaved }: { org: OperatorOrg; onSaved: () => void }) {
  const running = inCaseStudy(org);
  const paying = (org.status === 'active' || org.status === 'past_due') && org.plan !== 'trial';
  const [months, setMonths] = useState<(typeof CASE_STUDY_MONTHS)[number]>('12');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function apply(m: number) {
    setErr(null);
    if (!note.trim()) return setErr('Add a note, e.g. the agreement or contact person.');
    const question = m === 0
      ? [`End ${org.name}'s case study now?`, 'Their 14-day trial starts today; after it they need to subscribe.', 'End case study']
      : [`Give ${org.name} ${m} months free?`, `Starts today${running ? ', replacing the current case study' : ''}. The normal 14-day trial follows.`, 'Start case study'];
    if (!(await confirmAction(question[0], question[1], question[2]))) return;
    setBusy(true);
    try {
      await operatorApi.setCaseStudy(org.organization_id, m, note.trim());
      setNote('');
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Case study">
      <Text style={styles.hint}>
        {running
          ? `Free until ${formatDate(org.case_study_until)}, then a 14-day trial until ${formatDate(org.trial_ends_at)}.`
          : paying
            ? 'This is a paying customer, so a case study cannot be started.'
            : 'Give this organisation a free period. The normal 14-day trial starts when it ends.'}
      </Text>
      {!paying ? (
        <>
          <Segmented options={CASE_STUDY_MONTHS.map((m) => ({ value: m, label: `${m} months` }))} value={months} onChange={setMonths} />
          <Field label="Note (required)" value={note} onChangeText={setNote} placeholder="e.g. 2027 case study agreement" multiline />
          {err ? <ErrorBanner message={err} /> : null}
          <Button title={running ? `Restart: ${months} months from today` : `Start ${months}-month case study`}
            onPress={() => apply(Number(months))} loading={busy} />
          {running ? <Button title="End case study now" variant="danger" onPress={() => apply(0)} disabled={busy} /> : null}
        </>
      ) : null}
    </Card>
  );
}

function SubscriptionEditor({ org, onSaved }: { org: OperatorOrg; onSaved: () => void }) {
  const [plan, setPlan] = useState(org.plan ?? 'trial');
  const [status, setStatus] = useState<string>(org.status ?? 'trialing');
  const [seats, setSeats] = useState(org.seats === null ? '' : String(org.seats));
  const [trialEnd, setTrialEnd] = useState(toYmd(org.trial_ends_at));
  const [periodEnd, setPeriodEnd] = useState(toYmd(org.current_period_end));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setPlan(org.plan ?? 'trial');
    setStatus(org.status ?? 'trialing');
    setSeats(org.seats === null ? '' : String(org.seats));
    setTrialEnd(toYmd(org.trial_ends_at));
    setPeriodEnd(toYmd(org.current_period_end));
  }, [org]);

  const changes = {
    plan: plan !== org.plan ? plan : null,
    status: status !== org.status ? status : null,
    seats: seats.trim() !== (org.seats === null ? '' : String(org.seats)) ? Number(seats) : null,
    trial_ends_at: trialEnd !== toYmd(org.trial_ends_at) ? trialEnd : null,
    current_period_end: periodEnd !== toYmd(org.current_period_end) ? periodEnd : null,
  };
  const changed = Object.values(changes).some((v) => v !== null);

  async function save() {
    setErr(null);
    if (changes.seats !== null && (!Number.isInteger(changes.seats) || changes.seats < 1 || changes.seats > 10000)) {
      return setErr('Seats must be a whole number between 1 and 10000.');
    }
    if (changes.trial_ends_at !== null && !validYmd(changes.trial_ends_at)) return setErr('Trial end must be YYYY-MM-DD.');
    if (changes.current_period_end !== null && !validYmd(changes.current_period_end)) {
      return setErr('Paid-until date must be YYYY-MM-DD.');
    }
    if (!note.trim()) return setErr('Write a note explaining the change. It is shown to the customer in their audit log.');
    if (changes.status === 'suspended' || changes.status === 'cancelled') {
      const ok = await confirmAction(
        `Mark ${org.name} as ${STATUS_LABEL[changes.status]}?`,
        'Their dashboard becomes read-only and agents stop recording until the status is changed back.',
        'Confirm');
      if (!ok) return;
    }
    setSaving(true);
    try {
      await operatorApi.updateSubscription(org.organization_id, {
        ...changes,
        trial_ends_at: changes.trial_ends_at ? fromYmd(changes.trial_ends_at) : null,
        current_period_end: changes.current_period_end ? fromYmd(changes.current_period_end) : null,
      }, note.trim());
      setNote('');
      notify('Subscription updated', 'The change is recorded in the operator audit log and the customer\'s audit log.');
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Subscription">
      <Text style={styles.label}>Plan</Text>
      <Segmented options={PLANS.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))} value={plan as never}
        onChange={setPlan} />
      <Text style={styles.label}>Status</Text>
      <Segmented options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))} value={status as never}
        onChange={setStatus} />
      <Field label="Seats" value={seats} onChangeText={setSeats} keyboardType="number-pad" />
      <Field label="Trial ends (YYYY-MM-DD)" value={trialEnd} onChangeText={setTrialEnd} autoCapitalize="none" />
      <Field label="Paid until (YYYY-MM-DD)" value={periodEnd} onChangeText={setPeriodEnd} autoCapitalize="none"
        hint="Payments made through Paystack extend this automatically. Only change it for manual payments or corrections." />
      <Field label="Note (required)" value={note} onChangeText={setNote} placeholder="e.g. EFT received, invoice INV-104"
        multiline />
      {err ? <ErrorBanner message={err} /> : null}
      <Button title="Save changes" onPress={save} disabled={!changed} loading={saving} />
      <Text style={styles.hint}>Blank fields keep their current value. Dates are end of day, South African time.</Text>
    </Card>
  );
}

function SupportCard({ org, snapshot, open }: {
  org: OperatorOrg; snapshot: Awaited<ReturnType<typeof operatorApi.supportSnapshot>> | null; open: boolean;
}) {
  if (!open) {
    return (
      <Card title="Support view">
        <Text style={styles.hint}>
          {org.support_access_until
            ? `The customer's support permission expired ${formatRelative(org.support_access_until)}.`
            : 'The customer has not granted support access.'}{' '}
          The owner can grant time-limited access from Account → Support access. Activity data is never visible here.
        </Text>
      </Card>
    );
  }
  return (
    <Card title="Support view" right={<Pill text={`until ${formatDateTime(org.support_access_until, ZONE)}`} color={colors.warning} />}>
      <Text style={styles.hint}>Agent and setup status only. Opening this view is recorded in the customer's audit log.</Text>
      {(snapshot ?? []).length === 0 ? <Empty text="No employees." /> : null}
      {(snapshot ?? []).map((r) => (
        <Text key={r.employee_id} style={styles.rowText}>
          <Text style={{ fontWeight: '600' }}>{r.name}</Text> ({r.role}{r.is_active ? '' : ', inactive'})
          {'\n'}{r.activated ? `Agent ${r.agent_version ?? '?'} on ${r.hostname ?? '?'} (${r.os_version ?? '?'}), ${r.agent_state ?? 'unknown'}, seen ${formatRelative(r.last_seen_at)}` : 'Not activated'}
          {r.needs_acknowledgement ? '\nHas not acknowledged the current notice' : ''}
          {(r.recent_problems ?? []).length ? `\nRecent: ${(r.recent_problems ?? []).map((p) => `${p.type} ${formatRelative(p.at)}`).join(', ')}` : ''}
        </Text>
      ))}
    </Card>
  );
}

function DeleteCard({ org }: { org: OperatorOrg }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function remove() {
    setErr(null);
    const ok = await confirmAction(`Permanently delete ${org.name}?`,
      'All employees, activity, policies and audit history for this customer are erased and their logins removed. This cannot be undone.',
      'Delete forever');
    if (!ok) return;
    setBusy(true);
    try {
      await operatorApi.deleteOrganization(org.organization_id, name);
      notify('Customer deleted', `${org.name} and all its data have been erased.`);
      router.replace('/operator');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Delete customer data">
      <Text style={styles.hint}>
        Use this when a cancelled customer asks for erasure or their retention period has passed. Type the organisation
        name exactly to confirm.
      </Text>
      <Field label="Organisation name" value={name} onChangeText={setName} placeholder={org.name} autoCapitalize="none" />
      {err ? <ErrorBanner message={err} /> : null}
      <Button title="Delete all data" variant="danger" onPress={remove} disabled={name !== org.name} loading={busy} />
    </Card>
  );
}
