import { useCallback, useEffect, useState } from 'react';
import { Image, Linking, Platform, Text, View } from 'react-native';

import { Button, ErrorBanner, Field, Loading, styles } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { formatDate } from '@/lib/format';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';

interface Factor { id: string; friendly_name?: string | null; created_at: string }
interface Enrolment { id: string; qr: string; secret: string; uri: string }

/** Turns authenticator-app (TOTP) two-factor login on or off for the signed-in account. */
export function MfaSetup({ required = false }: { required?: boolean }) {
  const { reloadProfile, profile } = useSession();
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.auth.mfa.listFactors();
    if (e) return setError(errorMessage(e));
    setFactors((data?.totp ?? []) as Factor[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function start() {
    setError(null);
    setBusy(true);
    try {
      // An abandoned set-up leaves an unverified factor behind; clear it first.
      const { data: list } = await supabase.auth.mfa.listFactors();
      for (const f of list?.all ?? []) {
        if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error: e } = await supabase.auth.mfa.enroll({
        factorType: 'totp', friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}`,
      });
      if (e) throw e;
      setEnrolment({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!enrolment) return;
    setError(null);
    setBusy(true);
    try {
      const { error: e } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrolment.id, code: code.trim() });
      if (e) throw e;
      setEnrolment(null);
      setCode('');
      await load();
      notify('Two-factor login is on', 'From now on you will enter a code from your authenticator app when you sign in.');
      await reloadProfile();
    } catch (e) {
      setError(/invalid|expired/i.test(errorMessage(e)) ? 'That code is wrong or expired. Enter the current 6-digit code.' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff(factor: Factor) {
    const warning = required
      ? 'Your organisation requires two-factor login for managers. Without it you will not see employee data.'
      : 'Your account will be protected by your password only.';
    if (!(await confirmAction('Turn off two-factor login?', warning, 'Turn off'))) return;
    setBusy(true);
    try {
      const { error: e } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
      if (e) throw e;
      await supabase.auth.refreshSession();
      await load();
      await reloadProfile();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (factors === null) return error ? <ErrorBanner message={error} onRetry={load} /> : <Loading />;

  return (
    <View style={{ gap: 10 }}>
      {error ? <ErrorBanner message={error} /> : null}
      {factors.length > 0 ? (
        <>
          <Text style={styles.rowText}>Two-factor login is on.</Text>
          {factors.map((f) => (
            <View key={f.id} style={[styles.row, { justifyContent: 'space-between' }]}>
              <Text style={styles.hint}>Authenticator app · added {formatDate(f.created_at, profile?.timezone)}</Text>
              <Button title="Turn off" variant="ghost" small onPress={() => turnOff(f)} disabled={busy} />
            </View>
          ))}
        </>
      ) : enrolment ? (
        <>
          <Text style={styles.rowText}>
            1. Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) and add an account
            {Platform.OS === 'web' ? ' by scanning this code:' : ' with the key below:'}
          </Text>
          {Platform.OS === 'web' ? (
            <Image source={{ uri: enrolment.qr }} style={{ width: 180, height: 180, alignSelf: 'center' }}
              accessibilityLabel="QR code for your authenticator app" />
          ) : (
            <Button title="Open authenticator app" variant="secondary" small
              onPress={() => Linking.openURL(enrolment.uri).catch(() => notify('No authenticator app found', 'Enter the key by hand.'))} />
          )}
          <Text style={styles.hint}>Key (if you cannot scan): </Text>
          <Text style={[styles.rowText, { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) }]} selectable>
            {enrolment.secret}
          </Text>
          <Field label="2. Enter the 6-digit code it shows" value={code} onChangeText={setCode}
            keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" textContentType="oneTimeCode" />
          <Button title="Verify and turn on" onPress={verify} loading={busy} disabled={code.trim().length !== 6} />
          <Button title="Cancel" variant="ghost" small onPress={() => { setEnrolment(null); setCode(''); }} />
        </>
      ) : (
        <>
          <Text style={styles.hint}>
            Protect your account with a code from an authenticator app in addition to your password.
            {required ? ' Your organisation requires this for managers.' : ''}
          </Text>
          <Button title="Set up two-factor login" variant={required ? 'primary' : 'secondary'} onPress={start} loading={busy} />
        </>
      )}
    </View>
  );
}
