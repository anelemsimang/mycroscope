import { useState } from 'react';
import { Text } from 'react-native';

import { Button, Card, ErrorBanner, Loading, Screen, styles } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

export default function InstallKey() {
  const profile = useProfile();
  const { data, error, loading, refresh } = useAsync(() => api.installKey(), []);
  const [busy, setBusy] = useState(false);

  if (loading && !data) return <Loading />;

  async function rotate() {
    if (!(await confirmAction('Create a new install key?',
      'The current key stops working for new installs straight away. PCs that already have Mycroscope keep running. ' +
      'You will need to share the new key with anyone who still has to install the agent.',
      'Create new key'))) return;
    setBusy(true);
    try {
      await api.rotateInstallKey();
      notify('New install key created', 'Share it only with people who install Mycroscope.');
      refresh();
    } catch (e) {
      notify('Could not create a new key', errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      <Card title="Agent install key">
        <Text style={styles.hint}>
          Whoever installs Mycroscope on a PC must enter this key. Keep it with management: an employee who removes the
          agent cannot reinstall it without the key. Everyone in {profile.organizationName} shares the same key.
        </Text>
        <Text selectable style={{ fontSize: 22, fontWeight: '700', letterSpacing: 1, marginVertical: 12, color: '#1e3a8a' }}>
          {data ?? '—'}
        </Text>
        <Text style={styles.hint}>Tap and hold the key to copy it.</Text>
      </Card>
      <Card title="How it is used">
        <Text style={styles.hint}>
          Company PCs: the administrator installs with install-machine.ps1 and passes this key. Personal PCs: give the
          employee the key to enter when they run install.ps1. If a PC stops reporting or the agent is uninstalled, you
          are alerted under Alerts.
        </Text>
      </Card>
      {profile.role === 'owner' ? (
        <Card title="Replace the key">
          <Text style={styles.hint}>
            If the key has been shared too widely, create a new one. Installed agents are not affected.
          </Text>
          <Button title="Create a new install key" variant="danger" onPress={rotate} loading={busy} />
        </Card>
      ) : null}
    </Screen>
  );
}
