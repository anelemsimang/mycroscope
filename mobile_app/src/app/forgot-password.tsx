import { useState } from 'react';
import { Text } from 'react-native';

import { Button, Card, ErrorBanner, Field, Screen, styles } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { supabase } from '@/lib/supabase';

const resetUrl = process.env.EXPO_PUBLIC_PASSWORD_RESET_URL || undefined;

export default function ForgotPassword() {
  const [identifier, setIdentifier] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    if (!identifier.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const email = await api.resolveLoginEmail(identifier.trim());
      if (email) {
        const { error: e } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: resetUrl });
        if (e) throw e;
      }
      setDone(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Screen>
        <Card title="Check your email">
          <Text style={styles.rowText}>If that account exists, we have sent a link to choose a new password.</Text>
        </Card>
      </Screen>
    );
  }
  return (
    <Screen>
      {error ? <ErrorBanner message={error} /> : null}
      <Field label="Email or employee code" value={identifier} onChangeText={setIdentifier}
        autoCapitalize="none" keyboardType="email-address" />
      <Button title="Send reset link" onPress={submit} loading={busy} />
    </Screen>
  );
}
