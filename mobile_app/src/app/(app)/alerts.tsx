import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Card, Empty, ErrorBanner, Loading, Pill, Screen, Segmented, colors, styles } from '@/components/ui';
import { ALERT_TITLES, describeAlert } from '@/lib/alerts';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

const PERIODS = { '1': 'Last 24 hours', '7': 'Last 7 days', '30': 'Last 30 days' } as const;
type Period = keyof typeof PERIODS;
const severityColor = { high: colors.danger, medium: colors.warning, low: colors.muted } as const;

export default function Alerts() {
  const profile = useProfile();
  const [days, setDays] = useState<Period>('7');
  const [kind, setKind] = useState<string>('all');
  const { data, error, loading, refreshing, refresh } = useAsync(
    () => api.integrityAlerts(new Date(Date.now() - Number(days) * 86_400_000).toISOString()), [days]);

  const kinds = [...new Set((data ?? []).map((a) => a.kind))];
  const rows = (data ?? []).filter((a) => kind === 'all' || a.kind === kind);

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Card>
        <Text style={styles.hint}>
          Signals that tracking may have been avoided or interfered with. They are indications, not proof: talk to the
          employee before drawing conclusions. Which checks run is set under Monitoring & privacy, and employees are told
          about them in the monitoring notice.
        </Text>
        <Segmented options={(Object.keys(PERIODS) as Period[]).map((p) => ({ value: p, label: PERIODS[p] }))} value={days} onChange={setDays} />
        {kinds.length > 1 ? (
          <Segmented options={[{ value: 'all', label: 'All' }, ...kinds.map((k) => ({ value: k, label: ALERT_TITLES[k] ?? k }))]}
            value={kind} onChange={setKind} />
        ) : null}
      </Card>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {loading && !data ? <Loading /> : null}
      <Card title={`${rows.length} alert${rows.length === 1 ? '' : 's'}`}>
        {data && rows.length === 0 ? <Empty text="Nothing to look at." /> : null}
        {rows.map((a, i) => (
          <Pressable key={`${a.employee_id}-${a.kind}-${a.occurred_at}-${i}`}
            onPress={() => router.push({ pathname: '/employee/[id]', params: { id: a.employee_id } })}
            style={({ pressed }) => [{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', gap: 4 }, pressed && { opacity: 0.6 }]}>
            <View style={[styles.row, { justifyContent: 'space-between' }]}>
              <Text style={[styles.rowText, { fontWeight: '600', flex: 1 }]} numberOfLines={1}>{a.employee_name}</Text>
              <Pill text={ALERT_TITLES[a.kind] ?? a.kind} color={severityColor[a.severity]} />
            </View>
            <Text style={styles.rowText}>{describeAlert(a)}</Text>
            <Text style={styles.hint}>{formatDateTime(a.occurred_at, profile.timezone)}</Text>
          </Pressable>
        ))}
      </Card>
    </Screen>
  );
}
