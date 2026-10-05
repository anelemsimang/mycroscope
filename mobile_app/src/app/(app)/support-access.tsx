import { useState } from 'react';
import { Text } from 'react-native';

import { Button, Card, Empty, ErrorBanner, Field, Loading, Pill, Screen, Segmented, colors, styles } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { formatDateTime } from '@/lib/format';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

const HOURS = ['4', '24', '72'] as const;

export default function SupportAccess() {
  const profile = useProfile();
  const { data, error, loading, refresh } = useAsync(() => api.supportGrants(), []);
  const [hours, setHours] = useState<(typeof HOURS)[number]>('24');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (profile.role !== 'owner') return <Screen><Card><Text style={styles.hint}>Only the owner can manage support access.</Text></Card></Screen>;
  if (loading && !data) return <Loading />;

  const now = Date.now();
  const active = (data ?? []).find((g) => !g.revoked_at && Date.parse(g.expires_at) > now);

  async function grant() {
    setFormError(null);
    if (reason.trim().length < 3) return setFormError('Describe the problem support should look at.');
    if (!(await confirmAction('Grant support access?',
      `For ${hours} hours Mycroscope support can see technical status: employee names, agent versions, last-seen times, ` +
      'PC names and recent agent errors. They cannot see activity, apps, websites or reports. Every view is recorded in your audit log.',
      'Grant access'))) return;
    setBusy(true);
    try {
      await api.grantSupportAccess(Number(hours), reason.trim());
      setReason('');
      notify('Support access granted', 'Tell Mycroscope support that access is ready.');
      refresh();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      await api.revokeSupportAccess();
      refresh();
    } catch (e) {
      notify('Could not revoke', errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      <Card title="Support access">
        <Text style={styles.hint}>
          Mycroscope staff have no access to your organisation's data. When you need help, you can let support see
          technical status (who has the agent installed, versions, last-seen times and recent errors) for a limited time.
          Activity, apps, websites and reports are never included.
        </Text>
        {active ? (
          <>
            <Pill text={`Granted until ${formatDateTime(active.expires_at, profile.timezone)}`} color={colors.warning} />
            <Text style={styles.hint}>Reason: {active.reason}</Text>
            <Button title="Revoke now" variant="danger" onPress={revoke} loading={busy} />
          </>
        ) : (
          <>
            {formError ? <ErrorBanner message={formError} /> : null}
            <Text style={styles.label}>For</Text>
            <Segmented options={HOURS.map((h) => ({ value: h, label: `${h} hours` }))} value={hours} onChange={setHours} />
            <Field label="What should support look at?" value={reason} onChangeText={setReason} multiline
              style={{ minHeight: 70, textAlignVertical: 'top' }} />
            <Button title="Grant access" onPress={grant} loading={busy} />
          </>
        )}
      </Card>
      <Card title="History">
        {(data ?? []).length === 0 ? <Empty text="Support access has never been granted." /> : (data ?? []).map((g) => (
          <Text key={g.id} style={styles.hint}>
            {formatDateTime(g.created_at, profile.timezone)} – {g.revoked_at ? `revoked ${formatDateTime(g.revoked_at, profile.timezone)}`
              : `until ${formatDateTime(g.expires_at, profile.timezone)}`} · {g.reason}
          </Text>
        ))}
      </Card>
    </Screen>
  );
}
