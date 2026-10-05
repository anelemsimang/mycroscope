import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';

import { ActivationCard } from '@/components/ActivationCard';
import {
  Button, Card, ErrorBanner, Field, Loading, Screen, Segmented, ToggleRow, colors, styles,
} from '@/components/ui';
import { api, errorMessage, type ActivationResult, type Role } from '@/lib/api';
import { confirmAction } from '@/lib/dialog';
import { formatDateTime } from '@/lib/format';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

export default function ManageEmployee() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const profile = useProfile();
  const { data: emp, error: loadError, reload } = useAsync(() => api.employee(id), [id]);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('employee');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activation, setActivation] = useState<ActivationResult | null>(null);
  const [deleteReason, setDeleteReason] = useState('');

  useEffect(() => {
    if (emp) {
      setName(emp.name);
      setRole(emp.role);
      setActive(emp.is_active);
    }
  }, [emp]);

  if (loadError) return <Screen><ErrorBanner message={loadError} onRetry={reload} /></Screen>;
  if (!emp) return <Loading />;

  const isSelf = emp.id === profile.employeeId;
  const isOwnerAccount = emp.role === 'owner';
  const canEdit = profile.role === 'owner' || !isOwnerAccount;
  const changed = name.trim() !== emp.name || role !== emp.role || active !== emp.is_active;

  async function run(label: string, fn: () => Promise<unknown>, after?: () => void) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      after?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  function save() {
    run('save', () => api.updateEmployee(emp!.id, {
      name: name.trim() !== emp!.name ? name.trim() : undefined,
      role: role !== emp!.role ? role : undefined,
      is_active: active !== emp!.is_active ? active : undefined,
    }), reload);
  }

  async function confirmDelete() {
    if (!deleteReason.trim()) return setError('Enter a reason for deleting (kept in the audit log).');
    const ok = await confirmAction(
      `Delete ${emp!.name}?`,
      'This permanently deletes the employee and ALL of their recorded activity. It cannot be undone.',
      'Delete',
    );
    if (ok) run('delete', () => api.deleteEmployee(emp!.id, deleteReason.trim()), () => router.dismissTo('/employees'));
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: emp.name }} />
      {error ? <ErrorBanner message={error} /> : null}

      <Card title="Details">
        <Text style={styles.hint}>{emp.employee_code} · {emp.email}</Text>
        <Text style={styles.hint}>Added {formatDateTime(emp.created_at, profile.timezone)}</Text>
        <Field label="Name" value={name} onChangeText={setName} editable={canEdit} />
        {profile.role === 'owner' && !isSelf && !isOwnerAccount ? (
          <>
            <Text style={styles.label}>Role</Text>
            <Segmented value={role} onChange={setRole} options={[
              { value: 'employee', label: 'Employee' }, { value: 'manager', label: 'Manager' },
            ]} />
          </>
        ) : null}
        {!isSelf && canEdit ? (
          <ToggleRow label="Account active" value={active} onChange={setActive}
            hint="Deactivated employees cannot sign in and their agent stops uploading." />
        ) : null}
        {canEdit ? <Button title="Save changes" onPress={save} disabled={!changed} loading={busy === 'save'} /> : null}
      </Card>

      {!emp.auth_user_id ? (
        activation ? (
          <ActivationCard name={emp.name} org={profile.organizationName} result={activation} timezone={profile.timezone} />
        ) : (
          <Card title="Not activated yet">
            <Text style={styles.hint}>Lost the activation code or it expired? Issue a new one; the old one stops working.</Text>
            <Button title="Issue new activation code" variant="secondary" loading={busy === 'code'}
              onPress={() => run('code', async () => setActivation(await api.issueActivationCode(emp.id)))} />
          </Card>
        )
      ) : (
        <Button title="View activity" variant="secondary"
          onPress={() => router.push({ pathname: '/employee/[id]', params: { id: emp.id } })} />
      )}

      {!isOwnerAccount && canEdit ? (
        <Card title="Delete employee">
          <Text style={styles.hint}>
            For leavers or a POPIA deletion request. Removes the employee and all their activity data. Deactivate instead
            if you need to keep their history.
          </Text>
          <Field label="Reason (required)" value={deleteReason} onChangeText={setDeleteReason} />
          <Button title="Delete employee and data" variant="danger" onPress={confirmDelete} loading={busy === 'delete'} />
        </Card>
      ) : null}
      {isOwnerAccount ? <Text style={[styles.hint, { color: colors.muted }]}>The owner account cannot be deleted.</Text> : null}
    </Screen>
  );
}
