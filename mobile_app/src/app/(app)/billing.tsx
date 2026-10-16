import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ServiceBanner } from '@/components/ServiceBanner';
import { Button, Card, Empty, ErrorBanner, Loading, Pill, Screen, colors, styles } from '@/components/ui';
import { api, type Feature, type Invoice, type PlanCatalogueEntry, errorMessage } from '@/lib/api';
import { confirmAction, shareText } from '@/lib/dialog';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { useProfile, useSession } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';
import { openWebsiteCheckout } from '@/lib/websiteCheckout';

const STATUS_LABEL = {
  active: 'Active', past_due: 'Payment overdue', lapsed: 'Moved to Free', cancelled: 'Cancelled', suspended: 'Suspended',
} as const;

const BASICS = [
  'Automatic time tracking',
  'Activity summary by user & team',
  'Daily work metrics',
  'Personal insights for employees',
  'Title bar & full URL visibility (optional)',
  'Configurable work schedules',
  'Offline meeting time tracking',
  'Break time identification & measurement',
  'Automatic activity classification',
  'Custom classifications & rules',
  'Potential false activity detection',
  'Mouse-jiggler detection',
  'Report export',
  'Report subscriptions via email',
  'Role-based access controls',
  'User identity management',
  'Automatic agent updates',
  'Activity logs for data validation',
];

const FEATURES: { key: Feature; label: string }[] = [
  { key: 'real_time_visibility', label: 'Real-time visibility' },
  { key: 'schedule_adherence', label: 'Schedule adherence' },
  { key: 'schedule_adherence', label: 'Schedule adherence exceptions' },
  { key: 'time_tracking', label: 'Schedule tracking (fixed & flexible hours)' },
  { key: 'website_tracking', label: 'Website blocking' },
  { key: 'website_tracking', label: 'Compliance alarms' },
  { key: 'software_usage', label: 'Website & application usage' },
  { key: 'software_usage', label: 'Technology category usage' },
  { key: 'software_usage', label: 'Technology license optimization' },
  { key: 'channels', label: 'Alarm notifications via email, MS Teams, Slack & webhooks' },
  { key: 'teams', label: 'User groups in reporting' },
  { key: 'work_location_insights', label: 'Productivity insights by work location' },
  { key: 'work_location_insights', label: 'Work location policy validation' },
  { key: 'productivity_goals', label: 'Org-wide goal setting' },
  { key: 'productivity_goals', label: 'Productivity achievement vs goal' },
  { key: 'productivity_goals', label: 'Goal setting and benchmarks by team' },
  { key: 'workload_planning', label: 'Workload balance' },
  { key: 'file_activity', label: 'USB device & file transfer detection' },
  { key: 'ai_tools', label: 'AI Adoption' },
  { key: 'ai_tools', label: 'AI Compliance' },
  { key: 'ai_tools', label: 'AI Impact on Utilization & Productivity' },
  { key: 'trends', label: 'Productivity trends' },
  { key: 'trends', label: 'Org utilization & productivity overview' },
  { key: 'capacity_planning', label: 'Capacity planning' },
  { key: 'financial_estimates', label: 'Workforce utilization & financial loss' },
  { key: 'coaching', label: 'Coaching opportunities' },
  { key: 'coaching', label: 'In-app insights via Work Advisor' },
  { key: 'api', label: 'API access' },
];

function rands(cents: number): string {
  const amount = Number(cents) / 100;
  return Number.isInteger(amount) ? `R${amount}` : formatMoney(cents);
}

function includedLines(plan: PlanCatalogueEntry): string[] {
  const granted = new Set(plan.features);
  return [...BASICS, ...FEATURES.filter((feature) => granted.has(feature.key)).map((feature) => feature.label)];
}

function invoiceText(invoice: Invoice, timezone: string): string {
  const lines = [
    `Invoice ${invoice.number}`,
    formatDate(invoice.issued_at, timezone),
    '',
    invoice.business_name,
    invoice.business_address,
    invoice.vat_enabled
      ? `VAT number: ${invoice.business_vat_number || 'not set'}`
      : '',
    '',
    `Bill to: ${invoice.organization_name}`,
    invoice.description,
    `${invoice.seats} people`,
    `Net ${formatMoney(invoice.net_cents)}`,
  ];
  if (invoice.vat_enabled) lines.push(`VAT ${formatMoney(invoice.vat_cents)}`);
  lines.push(`Total ${formatMoney(invoice.gross_cents)}`);
  return lines.filter((line) => line !== '').join('\n');
}

export default function Billing() {
  const profile = useProfile();
  const { reloadService } = useSession();
  const isOwner = profile.role === 'owner';
  const { data, error, loading, refreshing, refresh } = useAsync(async () => {
    const [service, payments, catalogue, invoices] = await Promise.all([
      api.serviceStatus(), api.payments(), api.planCatalogue(), isOwner ? api.invoices() : Promise.resolve([]),
    ]);
    await reloadService();
    return { service, payments, catalogue, invoices };
  }, [isOwner]);
  const [busy, setBusy] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (!data?.service) return <Screen><ErrorBanner message={error ?? 'Could not load the subscription.'} onRetry={refresh} /></Screen>;
  const s = data.service;
  const plan = data.catalogue.find((p) => p.key === s.plan) ?? null;
  const pending = data.catalogue.find((p) => p.key === s.pending_plan) ?? null;
  const people = Math.max(1, s.seats_used);

  function reviewPurchase(target: PlanCatalogueEntry) {
    openWebsiteCheckout(target.key);
  }

  async function scheduleChange(target: PlanCatalogueEntry) {
    setPayError(null);
    setBusy(target.key);
    try {
      const quote = await api.quotePlan(target.key);
      const ok = await confirmAction('Change plan', quote.message ?? 'This starts at the end of the year.', 'Schedule change');
      if (!ok) return;
      await api.commitPlanChange(target.key);
      await refresh();
    } catch (e) {
      setPayError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function keepCurrent() {
    setPayError(null);
    setBusy('keep');
    try {
      await api.cancelPlanChange();
      await refresh();
    } catch (e) {
      setPayError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen refreshing={refreshing} onRefresh={refresh} maxWidth={1120}>
      <ServiceBanner service={s} timezone={profile.timezone} />
      <Card>
        <View style={local.summary}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.hint}>Current plan</Text>
            <Text style={local.summaryName}>{plan?.name ?? s.plan}</Text>
            <Text style={styles.hint}>
              {STATUS_LABEL[s.status] ?? s.status}
              {' · '}
              {plan?.seat_cap == null ? `${s.seats_used} people` : `${s.seats_used} of ${plan.seat_cap} people`}
              {plan ? ` · ${plan.retention_label} of activity` : ''}
              {s.plan !== 'free' && s.current_period_end
                ? ` · ${s.status === 'past_due' ? 'was paid until' : 'paid until'} ${formatDate(s.current_period_end, profile.timezone)}`
                : ''}
              {pending ? ` · changes to ${pending.name}` : ''}
            </Text>
          </View>
          {plan && plan.net_price_cents > 0 ? (
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={local.summaryPrice}>{rands(Number(plan.gross_price_cents) * 12 * people)}</Text>
              <Text style={styles.hint}>per year for {people} {people === 1 ? 'person' : 'people'}{plan.vat_enabled ? ', with VAT' : ''}</Text>
            </View>
          ) : null}
        </View>
        {pending && isOwner ? <Button title="Keep the current plan" variant="secondary" onPress={keepCurrent} loading={busy === 'keep'} /> : null}
      </Card>

      {payError ? <ErrorBanner message={payError} /> : null}

      <View style={local.grid}>
        {data.catalogue.map((item) => {
          const current = item.key === s.plan;
          const higher = plan != null && Number(item.rank) > Number(plan.rank);
          const lower = plan != null && Number(item.rank) < Number(plan.rank);
          const scheduled = pending?.key === item.key;
          const price = item.net_price_cents === 0
            ? 'R0'
            : `${rands(item.net_price_cents)}`;
          return (
            <View key={item.key} style={[local.plan, current && local.planCurrent]}>
              <View style={local.badgeRow}>
                {current ? <Pill text="Current plan" color={colors.primary} /> : null}
                {scheduled ? <Pill text="Scheduled" color={colors.warning} /> : null}
              </View>
              <Text style={local.planName}>{item.name}</Text>
              <Text style={local.price}>{price}</Text>
              <Text style={styles.hint}>
                {item.net_price_cents === 0 ? 'No charge' : 'per person / month, before VAT'}
              </Text>
              {item.net_price_cents > 0 ? (
                <Text style={styles.hint}>
                  Billed once a year: {rands(item.net_price_cents * 12)} per person
                  {item.vat_enabled ? ` · ${rands(Number(item.gross_price_cents) * 12)} with VAT` : ''}
                </Text>
              ) : null}
              <Text style={local.meta}>
                {item.seat_cap == null ? 'Unlimited people' : `${item.seat_cap} people`} · {item.retention_label} of activity
              </Text>
              <View style={local.rule} />
              {includedLines(item).map((line) => (
                <View key={line} style={local.feature}>
                  <Text style={local.check}>✓</Text>
                  <Text style={local.featureText}>{line}</Text>
                </View>
              ))}
              <View style={{ flex: 1 }} />
              {isOwner && !current && higher ? (
                <Button title="Pay on the website" onPress={() => reviewPurchase(item)} />
              ) : null}
              {isOwner && !current && lower ? (
                <Button
                  title={item.key === 'free' ? 'Cancel at period end' : 'Downgrade at period end'}
                  variant="secondary"
                  onPress={() => scheduleChange(item)}
                  loading={busy === item.key}
                />
              ) : null}
              {isOwner && current && item.net_price_cents > 0 && (s.status === 'past_due' || s.status === 'lapsed') ? (
                <Button title="Pay on the website" onPress={() => reviewPurchase(item)} />
              ) : null}
            </View>
          );
        })}
      </View>
      <Text style={styles.hint}>
        You pay once a year on the website. The card form is on Yoco's page. The yearly amount is 12 times the monthly price, with VAT, for every active person, including managers. A person you deactivate is not billed on the next year.
        An upgrade starts as soon as the payment is confirmed. A downgrade or cancellation starts when this year ends, and extra people are paused rather than removed.
      </Text>
      {!isOwner ? <Text style={styles.hint}>Only the organisation owner can change the plan or pay.</Text> : null}

      <Card title="Invoices">
        {data.invoices.length === 0 ? <Empty text="No invoices yet." /> : data.invoices.map((invoice) => (
          <View key={invoice.number}>
            <Text style={styles.rowText}>
              {invoice.number} · {formatDate(invoice.issued_at, profile.timezone)} · {formatMoney(invoice.gross_cents)}
            </Text>
            <Text style={styles.hint}>
              {invoice.description}. Net {formatMoney(invoice.net_cents)}
              {invoice.vat_enabled ? `, VAT ${formatMoney(invoice.vat_cents)}` : ''}.
              {' '}{invoice.business_name}{invoice.vat_enabled ? `, VAT ${invoice.business_vat_number || 'number not set'}` : ''}.
            </Text>
            <Button small variant="ghost" title="Share invoice" onPress={() => shareText(invoiceText(invoice, profile.timezone))} />
          </View>
        ))}
      </Card>

      <Card title="Payments">
        {data.payments.length === 0 ? <Empty text="No payments yet." /> : data.payments.map((p) => (
          <Text key={p.reference} style={styles.rowText}>
            {formatDateTime(p.paid_at, profile.timezone)} · {formatMoney(p.amount_cents, p.currency)} · {p.seats} people
          </Text>
        ))}
      </Card>
    </Screen>
  );
}

const local = StyleSheet.create({
  summary: { flexDirection: 'row', gap: 16, alignItems: 'center', flexWrap: 'wrap' },
  summaryName: { fontSize: 20, fontWeight: '700', color: colors.text },
  summaryPrice: { fontSize: 22, fontWeight: '700', color: colors.primary },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'stretch' },
  plan: {
    flexGrow: 1, flexBasis: 240, gap: 6, padding: 16, borderRadius: 12, backgroundColor: colors.card,
    borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 2, elevation: 1,
  },
  planCurrent: { borderColor: colors.primary, borderWidth: 2 },
  badgeRow: { minHeight: 24, flexDirection: 'row', gap: 6 },
  planName: { fontSize: 16, fontWeight: '700', color: colors.text },
  price: { fontSize: 32, fontWeight: '700', color: colors.text, marginTop: 4 },
  meta: { fontSize: 13, color: colors.text, marginTop: 4 },
  rule: { height: 1, backgroundColor: colors.border, marginVertical: 8 },
  feature: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  check: { color: colors.success, fontWeight: '700', width: 14 },
  featureText: { flex: 1, fontSize: 13, color: colors.text, lineHeight: 18 },
});
