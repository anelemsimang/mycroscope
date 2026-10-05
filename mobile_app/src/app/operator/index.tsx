import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Text } from 'react-native';

import { Button, Card, Empty, ErrorBanner, Field, LinkRow, Loading, Screen, Segmented, StatGrid, styles } from '@/components/ui';
import { operatorApi } from '@/lib/api';
import { confirmAction } from '@/lib/dialog';
import { formatDateTime, formatRelative } from '@/lib/format';
import { needsAttention, statusLine } from '@/lib/operator';
import { useSession } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

type Filter = 'all' | 'trialing' | 'active' | 'attention' | 'cancelled';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'trialing', label: 'Trials' }, { value: 'active', label: 'Paying' },
  { value: 'attention', label: 'Needs attention' }, { value: 'cancelled', label: 'Cancelled' },
];

export default function OperatorHome() {
  const { signOut } = useSession();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const { data, error, loading, refreshing, refresh } = useAsync(async () => {
    const [health, orgs] = await Promise.all([operatorApi.health(), operatorApi.organizations()]);
    return { health, orgs };
  }, []);

  const orgs = useMemo(() => (data?.orgs ?? []).filter((o) => {
    const q = query.trim().toLowerCase();
    if (q && !`${o.name} ${o.owner_email ?? ''} ${o.owner_name ?? ''}`.toLowerCase().includes(q)) return false;
    if (filter === 'trialing') return o.status === 'trialing';
    if (filter === 'active') return o.status === 'active';
    if (filter === 'cancelled') return o.status === 'cancelled';
    if (filter === 'attention') return needsAttention(o);
    return true;
  }), [data, filter, query]);

  if (loading && !data) return <Loading />;
  const h = data?.health;

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {h ? (
        <>
          <StatGrid items={[
            { label: 'Customers', value: String(h.organizations) },
            { label: 'Paying', value: String(h.paying_organizations) },
            { label: 'Trials', value: String(h.trialing_organizations) },
          ]} />
          <StatGrid items={[
            { label: 'Active seats', value: String(h.active_employees) },
            { label: 'Agents online', value: String(h.agents_online) },
            { label: 'Segments (24 h)', value: Number(h.segments_last_24h).toLocaleString() },
          ]} />
          <Card title="System">
            <Text style={styles.rowText}>
              Nightly maintenance: {h.last_maintenance_at ? `${formatDateTime(h.last_maintenance_at, 'Africa/Johannesburg')} (${formatRelative(h.last_maintenance_at)})` : 'has never run. Check the pg_cron job'}
            </Text>
            <Text style={styles.rowText}>Open employee privacy requests (all customers): {h.open_data_requests}</Text>
          </Card>
        </>
      ) : null}
      <Card title={`Customers (${orgs.length})`}>
        <Field label="Search" value={query} onChangeText={setQuery} placeholder="Name or owner email" autoCapitalize="none" />
        <Segmented options={FILTERS} value={filter} onChange={setFilter} />
        {orgs.length === 0 ? <Empty text="No customers match." /> : null}
        {orgs.map((o) => (
          <LinkRow key={o.organization_id} title={o.name}
            subtitle={`${statusLine(o)} · ${o.active_employees}/${o.seats ?? '–'} seats · ${o.agents_online} online`}
            onPress={() => router.push({ pathname: '/operator/org/[id]', params: { id: o.organization_id } })} />
        ))}
      </Card>
      <Card>
        <LinkRow title="Operator audit log" subtitle="Everything operators have done" onPress={() => router.push('/operator/audit')} />
        <Text style={styles.hint}>
          Operators cannot see customers' activity data. Support views need the customer's time-limited permission and
          are recorded in both the customer's and this audit log.
        </Text>
      </Card>
      <Button title="Sign out" variant="danger" onPress={async () => {
        if (await confirmAction('Sign out?', undefined, 'Sign out')) signOut();
      }} />
    </Screen>
  );
}
