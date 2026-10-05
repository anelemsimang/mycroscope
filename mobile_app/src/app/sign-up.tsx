import { router } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';

import { Button, Card, ErrorBanner, Field, Screen, ToggleRow, styles } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { supabase } from '@/lib/supabase';

export default function SignUp() {
  const [orgName, setOrgName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [authorised, setAuthorised] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!orgName.trim() || !fullName.trim() || !email.trim()) return setError('Please fill in every field.');
    if (password.length < 8) return setError('The password must be at least 8 characters.');
    if (password !== confirm) return setError("The passwords don't match.");
    if (!authorised) return setError('Please confirm that you may act for this organisation.');
    setBusy(true);
    try {
      const { data, error: authError } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: { data: { signup_type: 'owner', organization_name: orgName.trim(), full_name: fullName.trim() } },
      });
      if (authError) throw authError;
      if (!data.session) setSentTo(email.trim().toLowerCase());
      // With a session, the auth listener signs the owner straight in.
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <Screen>
        <Card title="Confirm your email">
          <Text style={styles.rowText}>
            We sent a confirmation link to {sentTo}. Open it, then come back and sign in.
          </Text>
        </Card>
        <Button title="Back to sign in" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen>
      {error ? <ErrorBanner message={error} /> : null}
      <Field label="Organisation name" value={orgName} onChangeText={setOrgName} />
      <Field label="Your full name" value={fullName} onChangeText={setFullName} textContentType="name" />
      <Field label="Work email" value={email} onChangeText={setEmail} autoCapitalize="none"
        keyboardType="email-address" textContentType="emailAddress" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry
        textContentType="newPassword" hint="At least 8 characters." />
      <Field label="Confirm password" value={confirm} onChangeText={setConfirm} secureTextEntry />
      <ToggleRow value={authorised} onChange={setAuthorised}
        label="I may act for this organisation"
        hint="As owner you are responsible for telling employees about monitoring (POPIA). Mycroscope shows them a notice before tracking starts." />
      <Button title="Create organisation" onPress={submit} loading={busy} />
    </Screen>
  );
}
