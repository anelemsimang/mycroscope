import { Stack, useLocalSearchParams } from 'expo-router';

import { EmployeeDetailView } from '@/components/EmployeeDetailView';
import { ErrorBanner, Loading, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

export default function EmployeeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const profile = useProfile();
  const { data: employee, error, loading, refresh } = useAsync(() => api.employee(id), [id]);

  if (error) return <Screen><ErrorBanner message={error} onRetry={refresh} /></Screen>;
  if (loading && !employee) return <Loading />;
  if (!employee) return <Screen><ErrorBanner message="This employee no longer exists." /></Screen>;
  return (
    <>
      <Stack.Screen options={{ title: employee.name }} />
      <EmployeeDetailView employee={employee} timezone={profile.timezone} isSelf={id === profile.employeeId} canManage />
    </>
  );
}
