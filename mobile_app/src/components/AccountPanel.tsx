import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';

import { Button, Card, ErrorBanner, Field, LinkRow, Screen, styles } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { useProfile, useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';

const roleLabel = { owner: 'Owner', manager: 'Manager', employee: 'Employee' } as const;

export function AccountPanel() {
  const profile = useProfile();
  const { signOut, isManager } = useSession();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changePassword() {
    setError(null);
    if (password.length < 8) return setError('The password must be at least 8 characters.');
    if (password !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    try {
      const { error: e } = await supabase.auth.updateUser({ password });
      if (e) throw e;
      setPassword('');
      setConfirm('');
      notify('Password changed');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Card title={profile.name}>
        <Text style={styles.rowText}>{profile.email}</Text>
        <Text style={styles.hint}>{roleLabel[profile.role]} · {profile.organizationName}</Text>
        <Text style={styles.hint}>Employee code {profile.employeeCode} · timezone {profile.timezone}</Text>
      </Card>
      {isManager ? (
        <Card title="Compliance (POPIA / RICA)">
          <LinkRow title="Monitoring & privacy" subtitle="What is recorded, retention, Information Officer, notice text"
            onPress={() => router.push('/monitoring')} />
          <LinkRow title="Notice acknowledgements" subtitle="Who has acknowledged the current monitoring notice"
            onPress={() => router.push('/acknowledgements')} />
          <LinkRow title="Notice history" subtitle="Every published version of the notice"
            onPress={() => router.push('/notice-history')} />
          <LinkRow title="Audit log" subtitle="Views, exports, deletions and setting changes"
            onPress={() => router.push('/audit-log')} />
        </Card>
      ) : null}
      <Card title="Change password">
        {error ? <ErrorBanner message={error} /> : null}
        <Field label="New password" value={password} onChangeText={setPassword} secureTextEntry textContentType="newPassword" />
        <Field label="Confirm new password" value={confirm} onChangeText={setConfirm} secureTextEntry />
        <Button title="Change password" variant="secondary" onPress={changePassword} loading={busy} disabled={!password} />
      </Card>
      <Button title="Sign out" variant="danger" onPress={async () => {
        if (await confirmAction('Sign out?', undefined, 'Sign out')) signOut();
      }} />
      <Text style={[styles.hint, { textAlign: 'center' }]}>Mycroscope mobile v{Constants.expoConfig?.version ?? '?'}</Text>
    </Screen>
  );
}
