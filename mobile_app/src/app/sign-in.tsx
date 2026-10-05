import { Link, router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';

import { Button, ErrorBanner, Field, Screen, colors, styles } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';

export default function SignIn() {
  const { notice } = useSession();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!identifier.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const email = await api.resolveLoginEmail(identifier.trim());
      if (!email) throw new Error('Unknown employee code. Check it, or sign in with your email address.');
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) {
        if (authError.code === 'invalid_credentials') throw new Error('Incorrect email/employee code or password.');
        if (authError.code === 'email_not_confirmed') {
          throw new Error('Please confirm your email address first. Check your inbox for the link.');
        }
        throw authError;
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <View style={{ marginTop: 60, marginBottom: 16, gap: 4 }}>
          <Text style={[styles.title, { fontSize: 30 }]}>Mycroscope</Text>
          <Text style={styles.hint}>Team activity, transparently.</Text>
        </View>
        {notice ? <ErrorBanner message={notice} /> : null}
        {error ? <ErrorBanner message={error} /> : null}
        <Field label="Email or employee code" value={identifier} onChangeText={setIdentifier}
          autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="username" />
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry
          textContentType="password" onSubmitEditing={submit} />
        <Button title="Sign in" onPress={submit} loading={busy} />
        <Link href="/forgot-password" style={{ color: colors.primary, textAlign: 'right' }}>Forgot password?</Link>
        <View style={[styles.divider, { marginVertical: 16 }]} />
        <Text style={styles.hint}>New to Mycroscope? Create an organisation and become its owner.</Text>
        <Button title="Create an organisation" variant="secondary" onPress={() => router.push('/sign-up')} />
        <Text style={[styles.hint, { marginTop: 12 }]}>
          Employees: install the Mycroscope desktop app on your PC and activate it with the codes from your manager.
        </Text>
      </Screen>
    </KeyboardAvoidingView>
  );
}
