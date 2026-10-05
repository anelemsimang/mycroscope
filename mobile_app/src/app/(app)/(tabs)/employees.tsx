import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Button, Card, Empty, ErrorBanner, Loading, Pill, Screen, colors, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';

const roleLabel = { owner: 'Owner', manager: 'Manager', employee: 'Employee' } as const;

export default function Employees() {
  const { data, error, loading, refreshing, refresh } = useAsync(() => api.employees(), []);
  const active = (data ?? []).filter((e) => e.is_active);
  const inactive = (data ?? []).filter((e) => !e.is_active);

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Button title="+ Add employee" onPress={() => router.push('/add-employee')} />
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {loading && !data ? <Loading /> : null}
      {data && data.length === 0 ? <Empty text="No employees yet." /> : null}
      {[...active, ...inactive].map((e) => (
        <Pressable key={e.id} onPress={() => router.push({ pathname: '/manage/[id]', params: { id: e.id } })}>
          <Card style={!e.is_active ? { opacity: 0.6 } : undefined}>
            <View style={[styles.row, { justifyContent: 'space-between' }]}>
              <Text style={[styles.cardTitle, { flex: 1 }]} numberOfLines={1}>{e.name}</Text>
              <Pill text={roleLabel[e.role]} color={e.role === 'employee' ? colors.muted : colors.primary} />
            </View>
            <Text style={styles.hint}>{e.employee_code} · {e.email}</Text>
            <View style={[styles.row, { gap: 6 }]}>
              {!e.auth_user_id ? <Pill text="Waiting for activation" color={colors.warning} /> : null}
              {!e.is_active ? <Pill text="Deactivated" color={colors.danger} /> : null}
            </View>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
