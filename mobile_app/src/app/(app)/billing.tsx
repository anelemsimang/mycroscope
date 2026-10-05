import { useState } from 'react';
import { Linking, Platform, Text } from 'react-native';

import { ServiceBanner } from '@/components/ServiceBanner';
import { Button, Card, Empty, ErrorBanner, Field, InfoGrid, Loading, Screen, Segmented, styles } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { webAppUrl } from '@/lib/authLink';
import { confirmAction } from '@/lib/dialog';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { useProfile, useSession } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

const STATUS_LABEL = {
  trialing: 'Free trial', active: 'Active', past_due: 'Payment overdue', cancelled: 'Cancelled', suspended: 'Suspended',
} as const;

export default function Billing() {
  const profile = useProfile();
  const { reloadService } = useSession();
  const isOwner = profile.role === 'owner';
  const { data, error, loading, refreshing, refresh } = useAsync(async () => {
    const [service, payments] = await Promise.all([api.serviceStatus(), api.payments()]);
    await reloadService();
    return { service, payments };
  }, []);
  const [seats, setSeats] = useState('');
  const [months, setMonths] = useState<'1' | '12'>('1');
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (!data?.service) return <Screen><ErrorBanner message={error ?? 'Could not load the subscription.'} onRetry={refresh} /></Screen>;
  const s = data.service;
  const seatText = seats || String(Math.max(s.seats, s.seats_used, 1));

  async function pay() {
    setPayError(null);
    const n = Number(seatText);
    if (!Number.isInteger(n) || n < Math.max(1, s.seats_used) || n > 10000) {
      return setPayError(`Seats must be a whole number from ${Math.max(1, s.seats_used)} (people currently active) to 10000.`);
    }
    const base = webAppUrl();
    setBusy(true);
    try {
      const checkout = await api.startCheckout(n, Number(months), base ? `${base}/billing` : '');
      const ok = await confirmAction('Continue to Paystack?',
        `${n} seat${n === 1 ? '' : 's'} for ${months === '12' ? '12 months' : '1 month'}: ${formatMoney(checkout.amount_cents, checkout.currency)}.\n\n` +
        'You will pay on Paystack\'s secure page. Your subscription updates as soon as the payment is confirmed.', 'Pay now');
      if (!ok) return;
      if (Platform.OS === 'web') window.location.assign(checkout.authorization_url);
      else await Linking.openURL(checkout.authorization_url);
    } catch (e) {
      setPayError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      <ServiceBanner service={s} timezone={profile.timezone} />
      <Card title="Subscription">
        <InfoGrid items={[
          { label: 'Status', value: STATUS_LABEL[s.status] ?? s.status },
          { label: 'Plan', value: s.plan === 'trial' ? 'Trial' : s.plan[0].toUpperCase() + s.plan.slice(1) },
          { label: 'Seats in use', value: `${s.seats_used} of ${s.seats}` },
          s.status === 'trialing'
            ? { label: 'Trial ends', value: formatDate(s.trial_ends_at, profile.timezone) }
            : { label: 'Paid until', value: formatDate(s.current_period_end, profile.timezone) },
        ]} />
        <Text style={styles.hint}>
          A seat is one active employee (including managers). Deactivated employees don't use a seat. If a subscription
          lapses, everything stays viewable and exportable, but the desktop app stops recording until it is renewed.
        </Text>
      </Card>

      {isOwner ? (
        <Card title={s.status === 'trialing' ? 'Subscribe' : 'Renew or change seats'}>
          {payError ? <ErrorBanner message={payError} /> : null}
          <Field label="Seats" value={seatText} onChangeText={setSeats} keyboardType="number-pad"
            hint={`At least ${Math.max(1, s.seats_used)}, the number of people currently active.`} />
          <Text style={styles.label}>Period</Text>
          <Segmented options={[{ value: '1', label: '1 month' }, { value: '12', label: '12 months' }]} value={months} onChange={setMonths} />
          <Text style={styles.hint}>
            Paying before your current period ends adds the new period to the end, so no paid time is lost.
          </Text>
          <Button title="Continue to payment" onPress={pay} loading={busy} />
        </Card>
      ) : (
        <Card><Text style={styles.hint}>Only the organisation owner can pay or change the number of seats.</Text></Card>
      )}

      <Card title="Payments">
        {data.payments.length === 0 ? <Empty text="No payments yet." /> : data.payments.map((p) => (
          <Text key={p.reference} style={styles.rowText}>
            {formatDateTime(p.paid_at, profile.timezone)} · {formatMoney(p.amount_cents, p.currency)} · {p.seats} seats × {p.months} month{p.months === 1 ? '' : 's'}
          </Text>
        ))}
      </Card>
    </Screen>
  );
}
