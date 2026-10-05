import { router } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';

import { ActivationCard } from '@/components/ActivationCard';
import { Button, Card, ErrorBanner, Field, Screen, Segmented, styles } from '@/components/ui';
import { api, errorMessage, type ActivationResult, type Role } from '@/lib/api';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

const NO_TEAM = 'none';

export default function RegisterEmployee() {
  const profile = useProfile();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [role, setRole] = useState<Role>('employee');
  const [team, setTeam] = useState<string>(NO_TEAM);
  const teams = useAsync(async () => (profile.role === 'owner' ? (await api.teams()).teams : []), [profile.role]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ActivationResult | null>(null);

  async function submit() {
    setError(null);
    if (!name.trim() || !email.trim()) return setError('Name and email are required.');
    if (code && !/^[A-Za-z0-9_-]{3,32}$/.test(code.trim())) {
      return setError('Employee code: 3-32 letters, digits, - or _.');
    }
    setBusy(true);
    try {
      setResult(await api.createEmployee(name.trim(), email.trim(), role, code.trim() || undefined,
        team === NO_TEAM ? null : team));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setResult(null);
    setName('');
    setEmail('');
    setCode('');
    setRole('employee');
    setTeam(NO_TEAM);
  }

  if (result) {
    return (
      <Screen>
        <ActivationCard name={name.trim()} org={profile.organizationName} result={result} timezone={profile.timezone} />
        <Button title="Register another employee" variant="secondary" onPress={reset} />
        <Button title="Back to Dashboard" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Card title="Employee Details">
        {error ? <ErrorBanner message={error} /> : null}
        <Field label="Full name" value={name} onChangeText={setName} />
        <Field label="Work email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address"
          hint="They sign in with this email or their employee code." />
        <Field label="Employee code (optional)" value={code} onChangeText={setCode} autoCapitalize="characters"
          hint="Leave blank to generate one." />
        {profile.role === 'owner' ? (
          <>
            <Text style={styles.label}>Role</Text>
            <Segmented value={role} onChange={setRole} options={[
              { value: 'employee', label: 'Employee' }, { value: 'manager', label: 'Manager' },
            ]} />
            <Text style={styles.hint}>Managers can see activity and manage employees (only their teams' people if you assign them teams).</Text>
          </>
        ) : null}
        {(teams.data?.length ?? 0) > 0 ? (
          <>
            <Text style={styles.label}>Team</Text>
            <Segmented value={team} onChange={setTeam} options={[
              { value: NO_TEAM, label: 'No team' }, ...(teams.data ?? []).map((t) => ({ value: t.id, label: t.name })),
            ]} />
          </>
        ) : null}
      </Card>
      <Button title="Register Employee" onPress={submit} loading={busy} />
      <Text style={styles.hint}>
        You'll get an activation code for the employee to enter in the Mycroscope desktop app on their work PC.
      </Text>
    </Screen>
  );
}
