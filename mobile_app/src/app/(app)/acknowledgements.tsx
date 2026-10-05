import { Text, View } from 'react-native';

import { Card, Empty, ErrorBanner, Loading, Pill, Screen, StatGrid, colors, styles } from '@/components/ui';
import { api, type EmployeeRow } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

type Status =
  | { kind: 'current'; at: string; agent: string | null }
  | { kind: 'outdated'; version: number; at: string }
  | { kind: 'never' }
  | { kind: 'not_activated' };

export default function Acknowledgements() {
  const profile = useProfile();
  const { data, error, loading, refreshing, refresh } = useAsync(async () => {
    const [policies, consents, employees] = await Promise.all([api.policies(), api.consents(), api.employees()]);
    const current = policies[0] ?? null;
    const versionOf = new Map(policies.map((p) => [p.id, p.version]));
    const rows = employees.filter((e) => e.is_active).map((e): { employee: EmployeeRow; status: Status } => {
      if (!e.auth_user_id) return { employee: e, status: { kind: 'not_activated' } };
      const mine = consents.filter((c) => c.employee_id === e.id);
      const cur = current ? mine.find((c) => c.policy_id === current.id) : undefined;
      if (cur) return { employee: e, status: { kind: 'current', at: cur.acknowledged_at, agent: cur.agent_version } };
      const latest = mine.sort((a, b) => (versionOf.get(b.policy_id) ?? 0) - (versionOf.get(a.policy_id) ?? 0))[0];
      return latest
        ? { employee: e, status: { kind: 'outdated', version: versionOf.get(latest.policy_id) ?? 0, at: latest.acknowledged_at } }
        : { employee: e, status: { kind: 'never' } };
    });
    const order: Status['kind'][] = ['never', 'outdated', 'not_activated', 'current'];
    rows.sort((a, b) => order.indexOf(a.status.kind) - order.indexOf(b.status.kind) || a.employee.name.localeCompare(b.employee.name));
    return { current, rows };
  }, []);

  if (loading && !data) return <Loading />;
  const count = (k: Status['kind']) => data?.rows.filter((r) => r.status.kind === k).length ?? 0;

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      <Card>
        <Text style={styles.hint}>
          {data?.current
            ? `Who has acknowledged the current monitoring notice (version ${data.current.version}). Employees are asked in the desktop app; their activity is only stored after they have acknowledged a notice.`
            : 'No monitoring notice has been published yet.'}
        </Text>
      </Card>
      {data ? (
        <StatGrid items={[
          { label: 'Acknowledged', value: String(count('current')), color: colors.success },
          { label: 'Earlier version only', value: String(count('outdated')), color: colors.warning },
          { label: 'Never acknowledged', value: String(count('never')), color: colors.danger },
        ]} />
      ) : null}
      <Card title="Employees">
        {data && data.rows.length === 0 ? <Empty text="No active employees." /> : null}
        {data?.rows.map(({ employee, status }) => (
          <View key={employee.id} style={[styles.row, { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowText, { fontWeight: '600' }]}>{employee.name}</Text>
              <Text style={styles.hint}>{describe(status, profile.timezone)}</Text>
            </View>
            <StatusPill status={status} />
          </View>
        ))}
      </Card>
    </Screen>
  );
}

function describe(s: Status, tz: string): string {
  switch (s.kind) {
    case 'current': return `Acknowledged ${formatDateTime(s.at, tz)}${s.agent ? ` · desktop app ${s.agent}` : ''}`;
    case 'outdated': return `Acknowledged version ${s.version} on ${formatDateTime(s.at, tz)}; will be asked again when they next use the desktop app`;
    case 'never': return 'Activated but has not acknowledged any notice yet';
    case 'not_activated': return 'Has not activated their account yet';
  }
}

function StatusPill({ status }: { status: Status }) {
  switch (status.kind) {
    case 'current': return <Pill text="Acknowledged" color={colors.success} />;
    case 'outdated': return <Pill text="Needs to re-acknowledge" color={colors.warning} />;
    case 'never': return <Pill text="Not acknowledged" color={colors.danger} />;
    case 'not_activated': return <Pill text="Not activated" />;
  }
}
