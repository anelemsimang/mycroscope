import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { Card, Empty, ErrorBanner, Field, Loading, Screen, styles } from '@/components/ui';
import { operatorApi, type OperatorAuditEntry } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';

const ACTION_LABEL: Record<string, string> = {
  operator_created: 'Operator account created',
  subscription_updated: 'Subscription changed',
  support_snapshot_viewed: 'Support view opened',
  organization_deleted: 'Customer deleted',
  case_study_started: 'Case study started',
  case_study_ended: 'Case study ended',
  case_study_invited: 'Case study invite saved',
  case_study_invite_cancelled: 'Case study invite cancelled',
};

function describe(e: OperatorAuditEntry, orgNames: Map<string, string>): string {
  const d = e.details ?? {};
  const org = e.organization_id ? orgNames.get(e.organization_id) ?? (typeof d.name === 'string' ? d.name : undefined) ?? e.organization_id : null;
  const parts = [org ? `Customer: ${org}` : null];
  if (typeof d.note === 'string') parts.push(`Note: ${d.note}`);
  if (e.action === 'subscription_updated' && d.before && d.after) {
    const before = d.before as Record<string, unknown>;
    const after = d.after as Record<string, unknown>;
    const changed = ['plan', 'status', 'seats', 'trial_ends_at', 'current_period_end']
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map((k) => `${k}: ${String(before[k] ?? '–')} → ${String(after[k] ?? '–')}`);
    if (changed.length) parts.push(changed.join('; '));
  }
  if (typeof d.accounts === 'number') parts.push(`Logins removed: ${d.accounts}`);
  if (typeof d.email === 'string') parts.push(`Email: ${d.email}`);
  if (typeof d.months === 'number' && d.months > 0) parts.push(`Free period: ${d.months} months`);
  return parts.filter(Boolean).join('\n');
}

export default function OperatorAudit() {
  const [query, setQuery] = useState('');
  const { data, error, loading, refreshing, refresh } = useAsync(async () => {
    const [entries, orgs] = await Promise.all([operatorApi.audit(500), operatorApi.organizations()]);
    return { entries, orgNames: new Map(orgs.map((o) => [o.organization_id, o.name])) };
  }, []);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.entries ?? []).map((e) => ({ e, text: describe(e, data!.orgNames) }))
      .filter(({ e, text }) => !q || `${e.action} ${e.operator_email ?? ''} ${text}`.toLowerCase().includes(q));
  }, [data, query]);

  if (loading && !data) return <Loading />;
  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      <Card title={`Operator actions (${rows.length})`}>
        <Text style={styles.hint}>
          Every operator action is recorded here and cannot be edited or deleted. Actions affecting a customer also appear
          in that customer's own audit log.
        </Text>
        <Field label="Search" value={query} onChangeText={setQuery} placeholder="Action, operator or customer" autoCapitalize="none" />
        {rows.length === 0 ? <Empty text="Nothing recorded yet." /> : null}
        {rows.map(({ e, text }) => (
          <View key={e.id} style={{ paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#e5e7eb' }}>
            <Text style={[styles.rowText, { fontWeight: '600' }]}>{ACTION_LABEL[e.action] ?? e.action}</Text>
            <Text style={styles.hint}>
              {formatDateTime(e.created_at, 'Africa/Johannesburg')} · {e.operator_email ?? 'system'}
            </Text>
            {text ? <Text style={styles.rowText}>{text}</Text> : null}
          </View>
        ))}
      </Card>
    </Screen>
  );
}
