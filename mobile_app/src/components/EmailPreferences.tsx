import { useState } from 'react';
import { Text } from 'react-native';

import { ErrorBanner, Loading, ToggleRow, styles } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';

export function EmailPreferences() {
  const { data, error, loading, refresh } = useAsync(() => api.notificationPreferences(), []);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function update(weekly: boolean, alerts: boolean) {
    setSaving(true);
    setSaveError(null);
    try {
      await api.setNotificationPreferences(weekly, alerts);
      await refresh();
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBanner message={error ?? 'Could not load email settings.'} onRetry={refresh} />;
  return (
    <>
      {saveError ? <ErrorBanner message={saveError} /> : null}
      <ToggleRow label="Weekly summary (Monday morning)" value={data.weekly_digest} disabled={saving}
        onChange={(v) => update(v, data.alert_emails)} />
      <ToggleRow label="Integrity alerts (at most hourly)" value={data.alert_emails} disabled={saving}
        onChange={(v) => update(data.weekly_digest, v)} />
      <Text style={styles.hint}>
        Emails only contain counts, never names or activity details. Open the app to see who and what.
      </Text>
    </>
  );
}
