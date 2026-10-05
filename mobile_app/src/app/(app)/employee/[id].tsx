import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import { EmployeeActivity } from '@/components/EmployeeActivity';
import { Loading, Pill, colors, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

export default function EmployeeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const profile = useProfile();
  const { data: employee } = useAsync(() => api.employee(id), [id]);

  if (!employee) return <Loading />;
  return (
    <>
      <Stack.Screen options={{
        title: employee.name,
        headerRight: () => (
          <Text style={{ color: colors.primary, fontWeight: '600' }}
            onPress={() => router.push({ pathname: '/manage/[id]', params: { id } })}>Manage</Text>
        ),
      }} />
      <EmployeeActivity
        employeeId={id}
        employeeName={employee.name}
        timezone={profile.timezone}
        isSelf={id === profile.employeeId}
        header={
          <View style={[styles.row, { flexWrap: 'wrap' }]}>
            <Text style={styles.hint}>{employee.employee_code} · {employee.email}</Text>
            {!employee.is_active ? <Pill text="Deactivated" color={colors.danger} /> : null}
          </View>
        }
      />
    </>
  );
}
