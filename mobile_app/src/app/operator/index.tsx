import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Button, Card, Empty, ErrorBanner, Field, LinkRow, Loading, Screen, colors, styles } from '@/components/ui';
import { api, operatorApi, type OperatorDesk, type OperatorOrg } from '@/lib/api';
import { confirmAction } from '@/lib/dialog';
import { formatDate, formatDateTime, formatMoney, formatRelative } from '@/lib/format';
import {
  attentionReasons, maintenanceLate, needsAttention, peopleLabel, planChangeSummary, planName, statusName, supportOpen,
} from '@/lib/operator';
import { useSession } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

type Filter = 'all' | 'attention' | 'changes' | 'covered' | 'paying' | 'free' | 'support' | 'cancelled';

const REQUEST_KIND: Record<string, string> = {
  access: 'Access', correction: 'Correction', objection: 'Objection', deletion: 'Deletion', other: 'Other',
};
const CHECKOUT_KIND: Record<string, string> = {
  new: 'New plan', renewal: 'Renewal', upgrade: 'Upgrade', upgrade_later: 'Upgrade for the next term', seats: 'Extra seats',
};
const EMPTY_DESK: OperatorDesk = { collected_cents: 0, due_cents: 0, renewals: [], requests: [], checkouts: [], agents: [] };

function changeWhen(o: OperatorOrg): number {
  return o.current_period_end ? Date.parse(o.current_period_end) : Number.POSITIVE_INFINITY;
}

const ZONE = 'Africa/Johannesburg';

function ago(at: number | null): string {
  if (at === null) return 'not yet';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

export default function OperatorHome() {
  const { signOut } = useSession();
  const { width } = useWindowDimensions();
  const wide = width >= 980;
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());
  const { data, error, loading, refreshing, refresh, reload } = useAsync(async () => {
    const [health, orgs, plans, desk] = await Promise.all([
      operatorApi.health(), operatorApi.organizations(), api.planCatalogue(),
      operatorApi.desk().catch(() => EMPTY_DESK),
    ]);
    setUpdatedAt(Date.now());
    return { health, orgs, plans, desk };
  }, []);

  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const refreshTimer = setInterval(() => reloadRef.current(), 20_000);
    const clockTimer = setInterval(() => setClock(Date.now()), 5_000);
    return () => {
      clearInterval(refreshTimer);
      clearInterval(clockTimer);
    };
  }, []);

  const all = data?.orgs ?? [];
  const plans = data?.plans ?? [];
  const capOf = (o: OperatorOrg) => o.granted ? null
    : o.plan === 'free' || !o.plan
      ? plans.find((p) => p.key === (o.plan ?? 'free'))?.seat_cap ?? 3
      : o.seats ?? 0;
  const counts = useMemo(() => ({
    all: all.length,
    attention: all.filter((o) => needsAttention(o, clock, capOf(o))).length,
    paying: all.filter((o) => o.status === 'active' && o.plan !== 'free').length,
    free: all.filter((o) => o.plan === 'free').length,
    support: all.filter((o) => supportOpen(o, clock)).length,
    changes: all.filter((o) => planChangeSummary(o, plans)).length,
    covered: all.filter((o) => o.granted).length,
    cancelled: all.filter((o) => o.status === 'cancelled').length,
  }), [all, clock, plans]);

  const orgs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((o) => {
      if (q && !`${o.name} ${o.owner_email ?? ''} ${o.owner_name ?? ''}`.toLowerCase().includes(q)) return false;
      if (filter === 'attention') return needsAttention(o, clock, capOf(o));
      if (filter === 'paying') return o.status === 'active' && o.plan !== 'free';
      if (filter === 'free') return o.plan === 'free';
      if (filter === 'support') return supportOpen(o, clock);
      if (filter === 'changes') return !!planChangeSummary(o, plans);
      if (filter === 'covered') return !!o.granted;
      if (filter === 'cancelled') return o.status === 'cancelled';
      return true;
    }).sort((a, b) => {
      const rank = (o: OperatorOrg) => (needsAttention(o, clock, capOf(o)) ? 0 : 1);
      const seen = (o: OperatorOrg) => (o.last_activity_at ? Date.parse(o.last_activity_at) : 0);
      return rank(a) - rank(b) || seen(b) - seen(a) || a.name.localeCompare(b.name);
    });
  }, [all, filter, query, clock, plans]);

  const attention = useMemo(
    () => all.filter((o) => needsAttention(o, clock, capOf(o))).sort((a, b) => a.name.localeCompare(b.name)),
    [all, clock, plans],
  );

  if (loading && !data) return <Loading />;
  const h = data?.health;
  const fresh = updatedAt !== null && clock - updatedAt < 45_000 && !error;

  return (
    <Screen refreshing={refreshing} onRefresh={refresh} maxWidth={1180}>
      <View style={local.top}>
        <View style={{ flex: 1 }}>
          <Text style={local.title}>Accounts</Text>
          <Text style={styles.hint}>Fleet health for every customer. Activity contents stay in the customer account.</Text>
        </View>
        <View style={local.live}>
          <View style={[local.dot, { backgroundColor: fresh ? colors.success : colors.warning }]} />
          <Text style={styles.hint}>{fresh ? 'Live' : 'Stale'} · updated {ago(updatedAt)}</Text>
        </View>
      </View>

      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}

      {h ? (
        <View style={local.metrics}>
          <Metric label="Customers" value={String(h.organizations)} />
          <Metric label="Paying" value={String(h.paying_organizations)} />
          <Metric label="Collected this month" value={formatMoney(data?.desk.collected_cents ?? 0)} />
          <Metric label="Due in 14 days" value={formatMoney(data?.desk.due_cents ?? 0)} hint="Seats that end, excluding covered accounts" />
          <Metric label="Free" value={String(h.free_organizations)} />
          <Metric label="Active people" value={String(h.active_employees)} />
          <Metric label="Agents in 2 min" value={String(h.agents_online)} hint="Checked in, not signed out" />
          <Metric label="Segments, 24 h" value={Number(h.segments_last_24h).toLocaleString()} />
        </View>
      ) : null}

      {h && maintenanceLate(h.last_maintenance_at, clock) ? (
        <View style={local.alert}>
          <Text style={local.alertTitle}>Nightly maintenance</Text>
          <Text style={styles.hint}>
            {h.last_maintenance_at
              ? `Last run ${formatDateTime(h.last_maintenance_at, ZONE)} (${formatRelative(h.last_maintenance_at)}). It should run every night.`
              : 'It has never run. Check the scheduled job.'}
          </Text>
        </View>
      ) : null}
      {(data?.desk.requests.length ?? 0) > 0 ? (
        <Card title={`Privacy requests (${data?.desk.requests.length})`}>
          {data?.desk.requests.map((request) => (
            <Pressable key={request.id} onPress={() => openOrg(request.organization_id)}
              style={({ pressed }) => [local.attention, pressed && { opacity: 0.7 }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={local.orgName}>{request.name}</Text>
                <Text style={styles.hint}>
                  {REQUEST_KIND[request.kind] ?? request.kind} · {request.status === 'in_progress' ? 'In progress' : 'Open'} · {formatRelative(request.created_at)}
                </Text>
                <Text style={styles.rowText}>{request.message}</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </Card>
      ) : null}

      {(data?.desk.renewals.length ?? 0) > 0 ? (
        <Card title={`Seats ending in 14 days (${data?.desk.renewals.length})`}>
          {data?.desk.renewals.map((renewal) => (
            <Pressable key={`${renewal.organization_id}-${renewal.ends_on}`} onPress={() => openOrg(renewal.organization_id)}
              style={({ pressed }) => [local.attention, pressed && { opacity: 0.7 }]}>
              <View style={{ flex: 1 }}>
                <Text style={local.orgName}>{renewal.name}</Text>
                <Text style={styles.hint}>
                  {renewal.seats} {renewal.seats === 1 ? 'seat ends' : 'seats end'} {formatDate(renewal.ends_on, ZONE)}
                  {renewal.covered ? ' · covered, no invoice' : ''}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </Card>
      ) : null}

      {(data?.desk.checkouts.length ?? 0) > 0 ? (
        <Card title={`Checkouts not finished (${data?.desk.checkouts.length})`}>
          {data?.desk.checkouts.map((checkout, index) => (
            <Pressable key={`${checkout.organization_id}-${checkout.created_at}-${index}`} onPress={() => openOrg(checkout.organization_id)}
              style={({ pressed }) => [local.attention, pressed && { opacity: 0.7 }]}>
              <View style={{ flex: 1 }}>
                <Text style={local.orgName}>{checkout.name}</Text>
                <Text style={styles.hint}>
                  {CHECKOUT_KIND[checkout.kind] ?? checkout.kind} · {planName(checkout.plan_key)} · {checkout.seats} seats · {formatMoney(checkout.gross_cents)} · started {formatRelative(checkout.created_at)}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </Card>
      ) : null}

      {(data?.desk.agents.length ?? 0) > 0 ? (
        <Card title={`Agents needing attention (${data?.desk.agents.length})`}>
          {data?.desk.agents.map((agent, index) => (
            <Pressable key={`${agent.organization_id}-${index}`} onPress={() => openOrg(agent.organization_id)}
              style={({ pressed }) => [local.attention, pressed && { opacity: 0.7 }]}>
              <View style={{ flex: 1 }}>
                <Text style={local.orgName}>{agent.name}</Text>
                <Text style={styles.hint}>{agent.detail}</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </Card>
      ) : null}

      {counts.changes > 0 ? (
        <Card title={`Plan changes waiting (${counts.changes})`}>
          {all.filter((o) => planChangeSummary(o, plans)).sort((a, b) => changeWhen(a) - changeWhen(b) || a.name.localeCompare(b.name)).map((o) => (
            <Pressable key={o.organization_id} onPress={() => openOrg(o.organization_id)}
              style={({ pressed }) => [local.attention, pressed && { opacity: 0.7 }]}>
              <View style={{ flex: 1 }}>
                <Text style={local.orgName}>{o.name}</Text>
                <Text style={styles.hint}>{planChangeSummary(o, plans)}</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </Card>
      ) : null}

      {attention.length > 0 ? (
        <Card title={`Needs a look (${attention.length})`}>
          {attention.map((o) => (
            <Pressable key={o.organization_id} onPress={() => openOrg(o.organization_id)}
              style={({ pressed }) => [local.attention, pressed && { opacity: 0.7 }]}>
              <View style={{ flex: 1 }}>
                <Text style={local.orgName}>{o.name}</Text>
                <Text style={styles.hint}>{attentionReasons(o, clock, capOf(o)).map((r) => r.label).join(' · ')}</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </Card>
      ) : null}

      <Card title={`Directory (${orgs.length})`}>
        <Field label="Search" value={query} onChangeText={setQuery} placeholder="Customer or manager" autoCapitalize="none" />
        <View style={local.filters}>
          <FilterChip label="All" count={counts.all} on={filter === 'all'} onPress={() => setFilter('all')} />
          <FilterChip label="Needs a look" count={counts.attention} on={filter === 'attention'} onPress={() => setFilter('attention')} />
          <FilterChip label="Paying" count={counts.paying} on={filter === 'paying'} onPress={() => setFilter('paying')} />
          <FilterChip label="Free" count={counts.free} on={filter === 'free'} onPress={() => setFilter('free')} />
          <FilterChip label="Plan changes" count={counts.changes} on={filter === 'changes'} onPress={() => setFilter('changes')} />
          <FilterChip label="Covered" count={counts.covered} on={filter === 'covered'} onPress={() => setFilter('covered')} />
          <FilterChip label="Support open" count={counts.support} on={filter === 'support'} onPress={() => setFilter('support')} />
          <FilterChip label="Cancelled" count={counts.cancelled} on={filter === 'cancelled'} onPress={() => setFilter('cancelled')} />
        </View>
        {wide ? (
          <View style={local.head}>
            <Text style={[local.col, local.cName, local.headText]}>Customer</Text>
            <Text style={[local.col, local.cPlan, local.headText]}>Plan</Text>
            <Text style={[local.col, local.cStatus, local.headText]}>Status</Text>
            <Text style={[local.col, local.cNum, local.headText]}>People / seats</Text>
            <Text style={[local.col, local.cNum, local.headText]}>Agents</Text>
            <Text style={[local.col, local.cSeen, local.headText]}>Last check-in</Text>
          </View>
        ) : null}
        {orgs.length === 0 ? <Empty text="No customers match." /> : null}
        {orgs.map((o) => {
          const people = peopleLabel(o.active_employees, capOf(o));
          return (
          <Pressable key={o.organization_id} onPress={() => openOrg(o.organization_id)}
            style={({ pressed }) => [wide ? local.row : local.stack, pressed && { backgroundColor: '#f8fafc' }]}>
            <View style={[local.col, wide ? local.cName : { flex: 1 }]}>
              <Text style={local.orgName} numberOfLines={1}>{o.name}</Text>
              <Text style={styles.hint} numberOfLines={1}>{o.owner_name ?? 'No manager'}{o.owner_email ? ` · ${o.owner_email}` : ''}</Text>
              {planChangeSummary(o, plans) ? <Text style={styles.hint} numberOfLines={2}>{planChangeSummary(o, plans)}</Text> : null}
              {o.granted && o.grant_until ? <Text style={styles.hint}>Cover until {formatDate(o.grant_until, ZONE)}</Text> : null}
              {(o.open_requests ?? 0) > 0 ? <Text style={styles.hint}>{o.open_requests} open privacy {o.open_requests === 1 ? 'request' : 'requests'}</Text> : null}
            </View>
            {wide ? (
              <>
                <Text style={[local.col, local.cPlan, local.cell]}>{planName(o.plan)}{o.granted ? ' · no payment' : ''}</Text>
                <Text style={[local.col, local.cStatus, local.cell, statusTone(o)]}>{statusName(o.status)}{o.level === 'read_only' ? ' · read only' : ''}</Text>
                <Text style={[local.col, local.cNum, local.cell]}>{people}</Text>
                <Text style={[local.col, local.cNum, local.cell]}>{o.agents_online} / {o.activated_employees}</Text>
                <Text style={[local.col, local.cSeen, local.cell]}>{o.last_activity_at ? formatRelative(o.last_activity_at) : 'never'}</Text>
              </>
            ) : (
              <Text style={styles.hint}>
                {planName(o.plan)}{o.granted ? ' · no payment' : ''} · {statusName(o.status)} · {people} people · {o.agents_online}/{o.activated_employees} agents · {o.last_activity_at ? formatRelative(o.last_activity_at) : 'never'}
              </Text>
            )}
          </Pressable>
          );
        })}
        <Text style={styles.hint}>Agents are computers that checked in during the last 2 minutes and were not signed out.</Text>
      </Card>

      <Card title="Platform">
        <LinkRow title="AI tools" subtitle="The shared list customers mark as approved or not" onPress={() => router.push('/operator/ai-tools')} />
        <LinkRow title="Operator audit log" subtitle="Every change made from this console" onPress={() => router.push('/operator/audit')} />
        {h?.last_maintenance_at ? (
          <Text style={styles.hint}>Nightly maintenance last ran {formatRelative(h.last_maintenance_at)}.</Text>
        ) : null}
      </Card>
      <Button title="Sign out" variant="danger" onPress={async () => {
        if (await confirmAction('Sign out?', undefined, 'Sign out')) signOut();
      }} />
    </Screen>
  );
}

function openOrg(id: string) {
  router.push({ pathname: '/operator/org/[id]', params: { id } });
}

function statusTone(o: OperatorOrg) {
  if (o.status === 'past_due' || o.level === 'read_only' || o.status === 'suspended') return { color: colors.danger };
  if (o.status === 'cancelled' || o.status === 'lapsed') return { color: colors.warning };
  return null;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <View style={local.metric}>
      <Text style={local.metricValue}>{value}</Text>
      <Text style={local.metricLabel}>{label}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

function FilterChip({ label, count, on, onPress }: { label: string; count: number; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }}
      style={[local.chip, on && local.chipOn]}>
      <Text style={[local.chipText, on && { color: '#fff' }]}>{label} {count}</Text>
    </Pressable>
  );
}

const local = StyleSheet.create({
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  live: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metric: {
    flexGrow: 1, flexBasis: 140, backgroundColor: colors.card, borderRadius: 8, padding: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  metricValue: { fontSize: 22, fontWeight: '700', color: colors.text },
  metricLabel: { fontSize: 12, color: colors.muted, marginTop: 2 },
  alert: { padding: 12, borderRadius: 8, backgroundColor: '#fef3c7', borderLeftWidth: 4, borderLeftColor: colors.warning, gap: 2 },
  alertTitle: { fontWeight: '700', color: colors.text },
  notice: { padding: 12, borderRadius: 8, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  attention: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: '#f3f4f6',
  },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5 },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: '600', color: colors.text },
  head: { flexDirection: 'row', gap: 8, paddingTop: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  headText: { fontSize: 11, fontWeight: '700', color: colors.muted, textTransform: 'uppercase' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  stack: { paddingVertical: 10, gap: 2, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  col: { minWidth: 0 },
  cName: { flex: 1.4 },
  cPlan: { flex: 0.8 },
  cStatus: { flex: 0.9 },
  cNum: { width: 72 },
  cSeen: { width: 110 },
  orgName: { fontSize: 14, fontWeight: '600', color: colors.text },
  cell: { fontSize: 13, color: colors.text },
});
