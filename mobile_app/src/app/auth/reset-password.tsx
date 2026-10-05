import type { SupabaseClient } from '@supabase/supabase-js';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';

import { Button, Card, ErrorBanner, Field, Loading, Screen, styles } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { initialAuthLink, linkClient, scrubAddressBar, sessionFromLink } from '@/lib/authLink';
import { useSession } from '@/lib/session';

type State = { kind: 'checking' } | { kind: 'ready'; email: string } | { kind: 'done' } | { kind: 'failed'; message: string };

export default function ResetPassword() {
  const { session } = useSession();
  const client = useRef<SupabaseClient | null>(null);
  const [state, setState] = useState<State>({ kind: 'checking' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const link = initialAuthLink();
    scrubAddressBar();
    if (!link.accessToken && !link.tokenHash && !link.error) {
      return setState({ kind: 'failed', message: 'Open the password reset link from your email to choose a new password.' });
    }
    const c = linkClient();
    client.current = c;
    sessionFromLink(c, link, 'recovery').then(async (failure) => {
      if (failure) return setState({ kind: 'failed', message: failure });
      const { data } = await c.auth.getUser();
      setState({ kind: 'ready', email: data.user?.email ?? '' });
    });
    return () => {
      c.auth.signOut({ scope: 'local' });
    };
  }, []);

  async function submit() {
    setError(null);
    if (password.length < 8) return setError('The password must be at least 8 characters.');
    if (password !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    try {
      const { error: e } = await client.current!.auth.updateUser({ password });
      if (e) throw e;
      await client.current!.auth.signOut({ scope: 'local' });
      setState({ kind: 'done' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === 'checking') return <Loading />;

  const exit = (
    <Button title={session ? 'Continue to Mycroscope' : 'Sign in'} variant={state.kind === 'ready' ? 'ghost' : 'primary'}
      onPress={() => router.replace(session ? '/' : '/sign-in')} />
  );

  if (state.kind === 'failed') {
    return (
      <Screen>
        <Card title="This link didn't work">
          <Text style={styles.rowText}>{state.message}</Text>
          <Text style={styles.hint}>Reset links expire and can only be used once. Request a new one and use the latest email.</Text>
        </Card>
        {!session ? <Button title="Request a new link" variant="secondary" onPress={() => router.replace('/forgot-password')} /> : null}
        {exit}
      </Screen>
    );
  }

  if (state.kind === 'done') {
    return (
      <Screen>
        <Card title="Password changed">
          <Text style={styles.rowText}>
            Sign in with your new password, in the Mycroscope desktop app or here.
          </Text>
        </Card>
        {exit}
      </Screen>
    );
  }

  return (
    <Screen>
      <Card title="Choose a new password">
        {state.email ? <Text style={styles.hint}>For {state.email}</Text> : null}
        {error ? <ErrorBanner message={error} /> : null}
        <Field label="New password" value={password} onChangeText={setPassword} secureTextEntry
          textContentType="newPassword" hint="At least 8 characters." />
        <Field label="Confirm new password" value={confirm} onChangeText={setConfirm} secureTextEntry />
        <Button title="Save new password" onPress={submit} loading={busy} disabled={!password} />
      </Card>
      {exit}
    </Screen>
  );
}
