import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';

import { Button, Card, Loading, Screen, styles } from '@/components/ui';
import { initialAuthLink, linkClient, scrubAddressBar, sessionFromLink } from '@/lib/authLink';
import { useSession } from '@/lib/session';

type State = { kind: 'checking' } | { kind: 'confirmed' } | { kind: 'failed'; message: string };

export default function ConfirmEmail() {
  const { session } = useSession();
  const [state, setState] = useState<State>({ kind: 'checking' });

  useEffect(() => {
    const link = initialAuthLink();
    scrubAddressBar();
    if (link.error) return setState({ kind: 'failed', message: link.error });
    if (link.accessToken) return setState({ kind: 'confirmed' });
    if (!link.tokenHash) {
      return setState({ kind: 'failed', message: 'Open the confirmation link from your email to confirm your address.' });
    }
    const client = linkClient();
    sessionFromLink(client, link, 'email').then((error) => {
      setState(error ? { kind: 'failed', message: error } : { kind: 'confirmed' });
      client.auth.signOut({ scope: 'local' });
    });
  }, []);

  if (state.kind === 'checking') return <Loading />;

  return (
    <Screen>
      {state.kind === 'confirmed' ? (
        <Card title="Email confirmed">
          <Text style={styles.rowText}>Your email address is confirmed. You can now sign in to Mycroscope.</Text>
        </Card>
      ) : (
        <Card title="This link didn't work">
          <Text style={styles.rowText}>{state.message}</Text>
          <Text style={styles.hint}>
            Links expire and can only be used once. If you already confirmed your address, just sign in. Otherwise
            register again or ask for a new link.
          </Text>
        </Card>
      )}
      <Button title={session ? 'Continue to Mycroscope' : 'Sign in'} onPress={() => router.replace(session ? '/' : '/sign-in')} />
    </Screen>
  );
}
