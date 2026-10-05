import { useState } from 'react';
import { Text, View } from 'react-native';

import { Button, Card, Empty, ErrorBanner, Loading, Screen, Segmented, styles } from '@/components/ui';
import { AUDIT_PAGE, api, errorMessage, type AuditEntry } from '@/lib/api';
import { AUDIT_FILTERS, describeAudit, type AuditFilter } from '@/lib/audit';
import { formatDateTime } from '@/lib/format';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

export default function AuditLog() {
  const profile = useProfile();
  const [filter, setFilter] = useState<AuditFilter>('all');
  const actions = AUDIT_FILTERS.find((f) => f.value === filter)?.actions;
  const [more, setMore] = useState<{ filter: AuditFilter; rows: AuditEntry[]; done: boolean }>({ filter, rows: [], done: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const { data, error, loading, refreshing, refresh } = useAsync(async () => {
    const [entries, employees] = await Promise.all([api.auditLog({ actions }), api.employees()]);
    setMore({ filter, rows: [], done: entries.length < AUDIT_PAGE });
    return { entries, names: new Map(employees.map((e) => [e.id, e.name])) };
  }, [filter]);

  const extra = more.filter === filter ? more.rows : [];
  const entries = [...(data?.entries ?? []), ...extra];

  async function loadMore() {
    const last = entries[entries.length - 1];
    if (!last) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await api.auditLog({ beforeId: last.id, actions });
      setMore({ filter, rows: [...extra, ...next], done: next.length < AUDIT_PAGE });
    } catch (e) {
      setMoreError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Card>
        <Text style={styles.hint}>
          A permanent record of who viewed, exported or deleted monitoring data, every change to monitoring settings and
          the notice, account changes, and automatic retention clean-ups. Entries cannot be edited or removed.
        </Text>
      </Card>
      <Segmented options={AUDIT_FILTERS} value={filter} onChange={setFilter} />
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {loading && !data ? <Loading /> : (
        <Card>
          {entries.length === 0 ? <Empty text="Nothing recorded yet." /> : null}
          {data && entries.map((e) => {
            const d = describeAudit(e, data.names, profile.timezone);
            return (
              <View key={e.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', gap: 2 }}>
                <Text style={[styles.rowText, { fontWeight: '600' }]}>{d.title}</Text>
                {d.detail ? <Text style={styles.rowText} selectable>{d.detail}</Text> : null}
                <Text style={styles.hint}>{d.actor} · {formatDateTime(e.created_at, profile.timezone)}</Text>
              </View>
            );
          })}
          {moreError ? <ErrorBanner message={moreError} /> : null}
          {data && entries.length > 0 && !(more.filter === filter && more.done) ? (
            <Button title="Load older entries" variant="secondary" onPress={loadMore} loading={loadingMore} />
          ) : null}
        </Card>
      )}
    </Screen>
  );
}
