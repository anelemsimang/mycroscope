import { Stack, router } from 'expo-router';
import { Text } from 'react-native';

import { EmployeeActivity } from '@/components/EmployeeActivity';
import { colors, styles } from '@/components/ui';
import { useProfile } from '@/lib/session';

/** Employees (non-managers) see only their own recorded activity. */
export default function Me() {
  const profile = useProfile();
  return (
    <>
      <Stack.Screen options={{
        headerRight: () => (
          <Text style={{ color: colors.primary, fontWeight: '600' }} onPress={() => router.push('/account')}>Account</Text>
        ),
      }} />
      <EmployeeActivity
        employeeId={profile.employeeId}
        employeeName={profile.name}
        timezone={profile.timezone}
        isSelf
        header={<Text style={styles.hint}>This is everything Mycroscope has recorded about you for each day.</Text>}
      />
    </>
  );
}
