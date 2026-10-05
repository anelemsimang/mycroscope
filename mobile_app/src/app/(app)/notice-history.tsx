import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Card, Empty, ErrorBanner, Loading, Pill, Screen, colors, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

export default function NoticeHistory() {
  const profile = useProfile();
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, refreshing, refresh } = useAsync(async () => {
    const [policies, consents, employees] = await Promise.all([api.policies(), api.consents(), api.employees()]);
    const names = new Map(employees.map((e) => [e.id, e.name]));
    const counts = new Map<string, number>();
    for (const c of consents) counts.set(c.policy_id, (counts.get(c.policy_id) ?? 0) + 1);
    return { policies, names, counts };
  }, []);

  if (loading && !data) return <Loading />;

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      <Card>
        <Text style={styles.hint}>
          Every version of the monitoring notice is kept so you can show exactly what employees were told and when.
          Tap a version to read it.
        </Text>
      </Card>
      {data && data.policies.length === 0 ? <Empty text="No notice published yet." /> : null}
      {data?.policies.map((p, i) => (
        <Card key={p.id}>
          <Pressable onPress={() => setOpen(open === p.id ? null : p.id)} accessibilityRole="button">
            <View style={[styles.row, { justifyContent: 'space-between' }]}>
              <Text style={[styles.rowText, { fontWeight: '700' }]}>Version {p.version}</Text>
              {i === 0 ? <Pill text="Current" color={colors.success} /> : null}
            </View>
            <Text style={styles.hint}>
              Published {formatDateTime(p.published_at, profile.timezone)}
              {p.published_by ? ` by ${data.names.get(p.published_by) ?? 'a deleted user'}` : ''}
              {' · '}{data.counts.get(p.id) ?? 0} acknowledgement(s)
            </Text>
          </Pressable>
          {open === p.id ? <Text style={[styles.rowText, { marginTop: 8 }]} selectable>{p.notice_text}</Text> : null}
        </Card>
      ))}
    </Screen>
  );
}
