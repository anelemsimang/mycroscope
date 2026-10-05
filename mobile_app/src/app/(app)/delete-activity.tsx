import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { Button, Card, ErrorBanner, Field, Loading, Screen, Segmented, colors, styles } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { addDays, dayStartUtc, formatDay, todayIn } from '@/lib/format';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

type Scope = 'today' | 'yesterday' | 'range' | 'all';
const SCOPES: { value: Scope; label: string }[] = [
  { value: 'today', label: "Today's data" },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'range', label: 'Date range' },
  { value: 'all', label: 'All history' },
];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export default function DeleteActivity() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const profile = useProfile();
  const tz = profile.timezone;
  const today = todayIn(tz);
  const { data: emp } = useAsync(() => api.employee(id), [id]);
  const [scope, setScope] = useState<Scope>('today');
  const [from, setFrom] = useState(addDays(today, -7));
  const [to, setTo] = useState(today);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!emp) return <Loading />;

  function bounds(): { fromIso: string; toIso: string; text: string } | string {
    switch (scope) {
      case 'today':
        return { fromIso: dayStartUtc(today, tz), toIso: dayStartUtc(addDays(today, 1), tz), text: `today (${formatDay(today)})` };
      case 'yesterday': {
        const y = addDays(today, -1);
        return { fromIso: dayStartUtc(y, tz), toIso: dayStartUtc(today, tz), text: `yesterday (${formatDay(y)})` };
      }
      case 'range':
        if (!YMD.test(from) || !YMD.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
          return 'Enter dates as YYYY-MM-DD.';
        }
        if (to < from) return 'The end date is before the start date.';
        return {
          fromIso: dayStartUtc(from, tz), toIso: dayStartUtc(addDays(to, 1), tz),
          text: from === to ? formatDay(from) : `${formatDay(from)} to ${formatDay(to)}`,
        };
      case 'all':
        return { fromIso: '2000-01-01T00:00:00.000Z', toIso: dayStartUtc(addDays(today, 2), tz), text: 'ALL recorded history' };
    }
  }

  async function submit() {
    setError(null);
    const b = bounds();
    if (typeof b === 'string') return setError(b);
    if (!reason.trim()) return setError('Enter a reason (kept in the audit log).');
    const ok = await confirmAction(
      `Delete ${emp!.name}'s activity?`,
      `This permanently deletes ${b.text} for ${emp!.name}. It cannot be undone.`,
      'Delete',
    );
    if (!ok) return;
    setBusy(true);
    try {
      const removed = await api.deleteActivity(id, b.fromIso, b.toIso, reason.trim());
      notify('Activity deleted', `${removed} record(s) removed. The deletion is recorded in the audit log.`);
      if (router.canGoBack()) router.back(); else router.replace({ pathname: '/employee/[id]', params: { id } });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Card title={`Delete activity for ${emp.name}`}>
        <Text style={styles.hint}>
          Use this for data recorded by mistake (for example while testing) or for a POPIA deletion request.
          Days are calendar days in {tz}.
        </Text>
      </Card>
      {error ? <ErrorBanner message={error} /> : null}
      <Segmented options={SCOPES} value={scope} onChange={setScope} />
      {scope === 'range' ? (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}><Field label="From (YYYY-MM-DD)" value={from} onChangeText={setFrom} autoCapitalize="none" /></View>
          <View style={{ flex: 1 }}><Field label="To (YYYY-MM-DD)" value={to} onChangeText={setTo} autoCapitalize="none" /></View>
        </View>
      ) : null}
      {scope === 'all' ? (
        <Text style={{ color: colors.danger }}>
          Everything recorded for {emp.name} will be removed. Their account stays; use Manage to delete the account too.
        </Text>
      ) : null}
      <Field label="Reason (required)" value={reason} onChangeText={setReason}
        hint="For example: test data, recorded while on leave, employee's deletion request." />
      <Button title="Delete activity" variant="danger" onPress={submit} loading={busy} />
    </Screen>
  );
}
