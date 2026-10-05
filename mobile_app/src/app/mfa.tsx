import { useEffect, useState } from 'react';
import { Text } from 'react-native';

import { Button, Card, ErrorBanner, Field, Screen, styles } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';

/** Second sign-in step for accounts with two-factor login. */
export default function MfaChallenge() {
  const { signOut, reloadProfile } = useSession();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.mfa.listFactors().then(({ data, error: e }) => {
      if (e) setError(errorMessage(e));
      else setFactorId(data?.totp[0]?.id ?? null);
    });
  }, []);

  async function verify() {
    if (!factorId) return;
    setError(null);
    setBusy(true);
    try {
      const { error: e } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
      if (e) throw e;
      await reloadProfile();
    } catch (e) {
      setError(/invalid|expired/i.test(errorMessage(e)) ? 'That code is wrong or expired. Enter the current 6-digit code.' : errorMessage(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Card title="Two-factor login">
        <Text style={styles.hint}>Enter the 6-digit code from your authenticator app.</Text>
        {error ? <ErrorBanner message={error} /> : null}
        <Field label="Code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoFocus
          autoComplete="one-time-code" textContentType="oneTimeCode" onSubmitEditing={verify} />
        <Button title="Continue" onPress={verify} loading={busy} disabled={!factorId || code.trim().length !== 6} />
        <Text style={styles.hint}>
          Lost your phone? Contact Mycroscope support to reset two-factor login on your account after confirming who you are.
        </Text>
        <Button title="Sign out" variant="ghost" onPress={signOut} />
      </Card>
    </Screen>
  );
}
