import { Stack, router } from 'expo-router';
import { Text } from 'react-native';

import { EmployeeDetailView } from '@/components/EmployeeDetailView';
import { Card, ErrorBanner, Loading, Screen, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

/** Employees (non-managers) see only their own recorded activity. */
export default function Me() {
  const profile = useProfile();
  const { data: me, error, loading, refresh } = useAsync(() => api.employee(profile.employeeId), [profile.employeeId]);

  return (
    <>
      <Stack.Screen options={{
        headerRight: () => (
          <Text style={{ color: '#fff', fontWeight: '600' }} onPress={() => router.push('/settings')}>Settings</Text>
        ),
      }} />
      {error ? <Screen><ErrorBanner message={error} onRetry={refresh} /></Screen> : null}
      {loading && !me ? <Loading /> : null}
      {me ? (
        <EmployeeDetailView employee={me} timezone={profile.timezone} isSelf canManage={false} intro={
          <Card><Text style={styles.hint}>This is everything Mycroscope has recorded about you.</Text></Card>
        } />
      ) : null}
    </>
  );
}
