import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';

import {
  Button, Card, Empty, ErrorBanner, Field, InfoGrid, Loading, Pill, Screen, Segmented, colors, styles,
} from '@/components/ui';
import { api, errorMessage, operatorApi, type OperatorOrg, type PlanCatalogueEntry, type PurchasedSeat } from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { formatDate, formatDateTime, formatRelative } from '@/lib/format';
import { planName, statusLine, statusName, supportOpen } from '@/lib/operator';
import { useAsync } from '@/lib/useAsync';

const ZONE = 'Africa/Johannesburg';
const STATUSES = ['active', 'past_due', 'lapsed', 'suspended', 'cancelled'] as const;
const STATUS_LABEL: Record<(typeof STATUSES)[number], string> = {
  active: 'Active', past_due: 'Overdue', lapsed: 'Moved to Free', suspended: 'Suspended', cancelled: 'Cancelled',
};

export default function OperatorOrgScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, loading, refreshing, refresh, reload } = useAsync(async () => {
    const [orgs, plans, seats] = await Promise.all([
      operatorApi.organizations(), api.planCatalogue(), operatorApi.seats(id).catch(() => [] as PurchasedSeat[]),
    ]);
    const org = orgs.find((o) => o.organization_id === id) ?? null;
    const open = !!org && supportOpen(org);
    const snapshot = open ? await operatorApi.supportSnapshot(id) : null;
    return { org, snapshot, supportOpen: open, plans, seats };
  }, [id]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const timer = setInterval(() => reloadRef.current(), 20_000);
    return () => clearInterval(timer);
  }, []);

  if (loading && !data) return <Loading />;
  const org = data?.org;
  const cap = data?.plans.find((p) => p.key === org?.plan)?.seat_cap ?? null;
  if (!org) {
    return (
      <Screen>
        {error ? <ErrorBanner message={error} onRetry={refresh} /> : <Empty text="Customer not found." />}
      </Screen>
    );
  }

  return (
    <Screen refreshing={refreshing} onRefresh={refresh} maxWidth={980}>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      <Card title={org.name} right={<Pill text={statusName(org.status)} color={org.level === 'read_only' || org.status === 'past_due' ? colors.danger : colors.primary} />}>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Pill text={planName(org.plan)} />
          {org.level === 'read_only' ? <Pill text="Read only" color={colors.danger} /> : null}
          {data?.supportOpen ? <Pill text="Support access open" color={colors.warning} /> : null}
        </View>
        <Text style={styles.hint}>{statusLine(org)}</Text>
        <InfoGrid items={[
          { label: 'Manager', value: `${org.owner_name ?? '–'}${org.owner_email ? ` · ${org.owner_email}` : ''}` },
          { label: 'Signed up', value: formatDate(org.created_at) },
          { label: 'People', value: org.plan === 'free'
            ? `${org.active_employees} of ${cap ?? 3}`
            : `${org.active_employees} of ${org.seats ?? 0} purchased seats` },
          { label: 'Installed agents', value: String(org.activated_employees) },
          { label: 'Seen in 2 min', value: String(org.agents_online) },
          { label: 'Last check-in', value: org.last_activity_at ? formatRelative(org.last_activity_at) : 'never' },
        ]} />
        <Text style={styles.hint}>
          {org.activated_employees === 0
            ? 'No desktop app has been activated.'
            : `${org.agents_online} of ${org.activated_employees} installed agents checked in during the last 2 minutes.`}
        </Text>
      </Card>
      <SeatCard seats={data?.seats ?? []} />
      <SubscriptionEditor org={org} plans={data?.plans ?? []} onSaved={refresh} />
      <SupportCard org={org} snapshot={data?.snapshot ?? null} open={!!data?.supportOpen} />
      {org.status === 'cancelled' ? <DeleteCard org={org} /> : null}
    </Screen>
  );
}

function SubscriptionEditor({ org, plans, onSaved }: { org: OperatorOrg; plans: PlanCatalogueEntry[]; onSaved: () => void }) {
  const [plan, setPlan] = useState(org.plan ?? 'free');
  const [status, setStatus] = useState<string>(org.status ?? 'active');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setPlan(org.plan ?? 'free');
    setStatus(org.status ?? 'active');
  }, [org]);

  const changes = {
    plan: plan !== org.plan ? plan : null,
    status: status !== org.status ? status : null,
  };
  const changed = Object.values(changes).some((v) => v !== null);

  async function save() {
    setErr(null);
    if (!note.trim()) return setErr('Write a note explaining the change. It is shown to the customer in their audit log.');
    if (changes.status === 'suspended' || changes.status === 'cancelled') {
      const stillPaid = !!org.current_period_end && Date.parse(org.current_period_end) > Date.now();
      const detail = changes.status === 'suspended'
        ? 'The dashboard stays open for old data. Nothing new is recorded until the status is set back to Active.'
        : stillPaid
          ? `Recording continues until ${formatDate(org.current_period_end)}. After that date the account is read-only.`
          : 'The paid period has already ended, so the account is read-only now. Old data stays visible.';
      const ok = await confirmAction(`Mark ${org.name} as ${STATUS_LABEL[changes.status]}?`, detail, 'Confirm');
      if (!ok) return;
    }
    setSaving(true);
    try {
      await operatorApi.updateSubscription(org.organization_id, changes, note.trim());
      setNote('');
      notify('Subscription updated', 'The change is recorded in the operator audit log and the customer\'s audit log.');
      onSaved();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Subscription">
      <Text style={styles.hint}>
        Seats are created when a payment is confirmed. Seats bought together share an end date. A seat added later has its own year.
        Changing the plan here does not add seats. Moving the account to Free ends the purchased seats.
      </Text>
      <Text style={styles.label}>Plan</Text>
      <Segmented options={(plans.length ? plans : [{ key: plan, name: plan }]).map((p) => ({ value: p.key, label: p.name }))} value={plan as never}
        onChange={setPlan} />
      <Text style={styles.label}>Status</Text>
      <Segmented options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))} value={status as never}
        onChange={setStatus} />
      <Field label="Note (required)" value={note} onChangeText={setNote} placeholder="Why this plan or status is changing"
        multiline />
      {err ? <ErrorBanner message={err} /> : null}
      <Button title="Save changes" onPress={save} disabled={!changed} loading={saving} />
    </Card>
  );
}

function SeatCard({ seats }: { seats: PurchasedSeat[] }) {
  const groups = new Map<string, { end: string; total: number; scheduled: number }>();
  for (const seat of seats) {
    const group = groups.get(seat.period_end) ?? { end: seat.period_end, total: 0, scheduled: 0 };
    group.total += 1;
    if (seat.cancel_at_period_end) group.scheduled += 1;
    groups.set(seat.period_end, group);
  }
  const rows = [...groups.values()];
  return (
    <Card title="Purchased seats">
      <Text style={styles.hint}>
        Each row is a group of seats that end on the same date. A scheduled seat stays until that date and is not billed again.
      </Text>
      {rows.length === 0 ? <Empty text="No seats are in their paid year." /> : rows.map((row) => (
        <Text key={row.end} style={styles.rowText}>
          {row.total} {row.total === 1 ? 'seat' : 'seats'} until {formatDate(row.end, ZONE)}
          {row.scheduled > 0 ? ` · ${row.scheduled} scheduled to end` : ''}
        </Text>
      ))}
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
          The manager can grant time-limited access from Account → Support access. Activity data is never visible here.
        </Text>
      </Card>
    );
  }
  return (
    <Card title="Support view" right={<Pill text={`until ${formatDateTime(org.support_access_until, ZONE)}`} color={colors.warning} />}>
      <Text style={styles.hint}>Agent and setup status only. Opening this view is recorded in the customer's audit log.</Text>
      {(snapshot ?? []).length === 0 ? <Empty text="No employees." /> : null}
      {(snapshot ?? []).map((r) => (
        <View key={r.employee_id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', gap: 2 }}>
          <Text style={styles.rowText}>
            <Text style={{ fontWeight: '600' }}>{r.name}</Text>
            {` · ${r.role}${r.is_active ? '' : ' · inactive'}`}
          </Text>
          <Text style={styles.hint}>
            {r.activated
              ? `${r.agent_state ?? 'unknown state'} · ${r.hostname ?? 'unknown computer'} · agent ${r.agent_version ?? '?'} · ${r.os_version ?? '?'} · seen ${r.last_seen_at ? formatRelative(r.last_seen_at) : 'never'}`
              : 'Desktop app not activated'}
          </Text>
          {r.needs_acknowledgement ? <Text style={[styles.hint, { color: colors.warning }]}>Has not acknowledged the current notice</Text> : null}
          {(r.recent_problems ?? []).length ? (
            <Text style={[styles.hint, { color: colors.danger }]}>
              Recent: {(r.recent_problems ?? []).map((p) => `${p.type} ${formatRelative(p.at)}`).join(', ')}
            </Text>
          ) : null}
        </View>
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
      setErr(errorMessage(e));
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
