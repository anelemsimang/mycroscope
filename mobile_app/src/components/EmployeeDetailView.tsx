import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Timeline } from '@/components/Timeline';
import {
  BarRow, Button, Card, Empty, ErrorBanner, InfoGrid, InnerTabs, LinkRow, Loading, Screen, SectionTitle, Segmented,
  StatGrid, colors, stateColor, stateLabel, styles,
} from '@/components/ui';
import { api, errorMessage, type EmployeeRow } from '@/lib/api';
import { notify } from '@/lib/dialog';
import { shareCsv } from '@/lib/export';
import {
  PERIOD_LABELS, addDays, formatDay, formatDuration, formatRelative, formatTime, periodRange, toCsv, todayIn,
  type PeriodKey,
} from '@/lib/format';
import { useAsync } from '@/lib/useAsync';

type Tab = 'overview' | 'activity' | 'apps' | 'history';
const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'activity', label: 'Activity' },
  { value: 'apps', label: 'Apps & Web' },
  { value: 'history', label: 'History' },
];
const PERIODS = (Object.keys(PERIOD_LABELS) as PeriodKey[]).map((value) => ({ value, label: PERIOD_LABELS[value] }));
const HISTORY_DAYS = 30;
const roleLabel = { owner: 'Owner', manager: 'Manager', employee: 'Employee' } as const;

interface Props {
  employee: EmployeeRow;
  timezone: string;
  /** True when the signed-in user is looking at their own record. */
  isSelf: boolean;
  canManage: boolean;
  intro?: ReactNode;
}

export function EmployeeDetailView({ employee, timezone, isSelf, canManage, intro }: Props) {
  const id = employee.id;
  const today = todayIn(timezone);
  const [tab, setTab] = useState<Tab>('overview');
  const [period, setPeriod] = useState<PeriodKey>('today');

  useEffect(() => {
    if (!isSelf) api.logAccess(id, 'viewed_employee', {});
  }, [id, isSelf]);

  const status = useAsync(() => api.agentStatus(id), [id]);
  useEffect(() => {
    const t = setInterval(() => status.reload(), 20_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const s = status.data;
  const online = !!s?.is_online;

  return (
    <Screen refreshing={status.refreshing} onRefresh={status.refresh} padded={false}>
      <View style={local.header}>
        <Text style={local.name}>{employee.name}</Text>
        <View style={[styles.row, { gap: 6 }]}>
          <View style={[styles.dot, { backgroundColor: online && s ? stateColor[s.state] : colors.danger }]} />
          <Text style={[local.status, { color: online && s ? stateColor[s.state] : colors.danger }]}>
            {online && s ? `Online · ${stateLabel[s.state]}` : 'Offline'}
          </Text>
        </View>
        {s ? <Text style={styles.hint}>Last activity: {formatRelative(s.last_seen_at)}</Text> : null}
      </View>

      <View style={local.body}>
        {intro}
        {canManage && !isSelf ? (
          <Card title="Employee Information">
            <InfoGrid items={[
              { label: 'Employee code', value: employee.employee_code },
              { label: 'Email', value: employee.email },
              { label: 'Role', value: roleLabel[employee.role] },
              { label: 'Account', value: employee.is_active ? 'Active' : 'Deactivated' },
            ]} />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
              <View style={{ flex: 1 }}>
                <Button small title="Manage" variant="secondary"
                  onPress={() => router.push({ pathname: '/manage/[id]', params: { id } })} />
              </View>
              <View style={{ flex: 1 }}>
                <Button small title="Delete activity…" variant="danger"
                  onPress={() => router.push({ pathname: '/delete-activity', params: { id } })} />
              </View>
            </View>
          </Card>
        ) : null}

        <InnerTabs tabs={TABS} value={tab} onChange={setTab} />

        {tab === 'overview' ? <Overview id={id} timezone={timezone} today={today} status={status} /> : null}
        {tab === 'activity' ? <ActivityTab id={id} timezone={timezone} today={today} status={status} /> : null}
        {tab === 'apps' ? (
          <AppsWeb id={id} name={employee.name} timezone={timezone} today={today} period={period} setPeriod={setPeriod} />
        ) : null}
        {tab === 'history' ? <History id={id} name={employee.name} timezone={timezone} today={today} isSelf={isSelf} /> : null}

        <Text style={[styles.hint, { textAlign: 'center' }]}>
          Times shown in {timezone}.{!isSelf ? ' Viewing and exporting is recorded in the audit log.' : ''}
        </Text>
      </View>
    </Screen>
  );
}

type StatusState = ReturnType<typeof useAsync<Awaited<ReturnType<typeof api.agentStatus>>>>;

function LiveStatus({ status }: { status: StatusState }) {
  const s = status.data;
  const online = !!s?.is_online;
  return (
    <Card title="Live Status" right={<View style={[styles.dot, { backgroundColor: online ? colors.success : colors.danger }]} />}>
      {status.error ? <ErrorBanner message={status.error} onRetry={status.refresh} /> : null}
      {!s ? <Text style={styles.hint}>The desktop app hasn't reported yet.</Text> : null}
      {s && !online ? <Text style={styles.rowText}>Currently offline · last seen {formatRelative(s.last_seen_at)}</Text> : null}
      {s && online ? (
        <View style={{ gap: 4 }}>
          <Text style={[styles.rowText, { fontWeight: '600', color: stateColor[s.state] }]}>Currently {stateLabel[s.state].toLowerCase()}</Text>
          {s.state === 'paused' ? <Text style={styles.hint}>The employee has paused tracking.</Text> : null}
          {s.app_name ? <Detail label="Application" value={s.app_name} /> : null}
          {s.window_title ? <Detail label="Window" value={s.window_title} /> : null}
          {s.domain ? <Detail label="Website" value={s.url ?? s.domain} /> : null}
          {s.project_name ? <Detail label="Project" value={s.project_name} /> : null}
        </View>
      ) : null}
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Text style={[styles.hint, { width: 80 }]}>{label}</Text>
      <Text style={[styles.rowText, { flex: 1 }]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

function Overview({ id, timezone, today, status }: { id: string; timezone: string; today: string; status: StatusState }) {
  const week = periodRange('this_week', today);
  const { data, error, loading, refresh } = useAsync(async () => {
    const [todayRows, weekRows] = await Promise.all([
      api.dailyTotals(id, today, today),
      api.dailyTotals(id, week.from, week.to),
    ]);
    return { day: todayRows[0], week: weekRows };
  }, [id, today, week.from]);

  const sum = (k: 'active_seconds' | 'idle_seconds' | 'paused_seconds') => (data?.week ?? []).reduce((a, d) => a + d[k], 0);
  const d = data?.day;
  return (
    <>
      <LiveStatus status={status} />
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {loading && !data ? <Loading /> : null}
      {data ? (
        <>
          <SectionTitle>Today's Activity</SectionTitle>
          <StatGrid items={[
            { label: 'Active', value: formatDuration(d?.active_seconds), color: stateColor.active },
            { label: 'Idle', value: formatDuration(d?.idle_seconds), color: stateColor.idle },
            { label: 'Paused', value: formatDuration(d?.paused_seconds), color: stateColor.paused },
            { label: 'Away', value: formatDuration(d?.away_seconds), color: colors.muted },
          ]} />
          <Text style={[styles.hint, { textAlign: 'center' }]}>
            {d?.first_activity_at
              ? `First activity ${formatTime(d.first_activity_at, timezone)} · last ${formatTime(d.last_activity_at, timezone)}`
              : 'No activity recorded today'}
          </Text>
          <SectionTitle>This Week</SectionTitle>
          <StatGrid items={[
            { label: 'Active', value: formatDuration(sum('active_seconds')), color: stateColor.active },
            { label: 'Idle', value: formatDuration(sum('idle_seconds')), color: stateColor.idle },
            { label: 'Paused', value: formatDuration(sum('paused_seconds')), color: stateColor.paused },
            { label: 'Days active', value: String(data.week.filter((x) => x.active_seconds > 0).length) },
          ]} />
        </>
      ) : null}
    </>
  );
}

function ActivityTab({ id, timezone, today, status }: { id: string; timezone: string; today: string; status: StatusState }) {
  const { data, error, loading, refresh } = useAsync(() => api.timeline(id, today), [id, today]);
  return (
    <>
      <LiveStatus status={status} />
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {loading && !data ? <Loading /> : null}
      {data ? <Timeline rows={data} timezone={timezone} title="Today's timeline" /> : null}
      <Button small variant="secondary" title="Open today's details"
        onPress={() => router.push({ pathname: '/day', params: { id, day: today } })} />
    </>
  );
}

function AppsWeb({ id, name, timezone, today, period, setPeriod }: {
  id: string; name: string; timezone: string; today: string; period: PeriodKey; setPeriod: (p: PeriodKey) => void;
}) {
  const range = periodRange(period, today);
  const { data, error, loading, refresh } = useAsync(async () => {
    const [apps, domains, projects] = await Promise.all([
      api.appTotals(id, range.from, range.to),
      api.domainTotals(id, range.from, range.to),
      api.projectTotals(id, range.from, range.to),
    ]);
    return { apps, domains, projects };
  }, [id, range.from, range.to]);
  const projectMax = Math.max(0, ...(data?.projects ?? []).map((p) => p.active_seconds));
  const params = { id, from: range.from, to: range.to, label: PERIOD_LABELS[period], name };

  return (
    <>
      <Segmented options={PERIODS} value={period} onChange={setPeriod} />
      <Text style={styles.hint}>{range.from === range.to ? formatDay(range.from) : `${formatDay(range.from)} – ${formatDay(range.to)}`}</Text>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {loading && !data ? <Loading /> : null}
      {data ? (
        <>
          <Card title={`Application Summary (${data.apps.length})`}>
            {data.apps.length === 0 ? <Empty text="No applications recorded for this period." /> : null}
            {data.apps.map((a) => (
              <LinkRow key={a.app_name} title={a.app_name}
                subtitle={`${formatDuration(a.idle_seconds)} idle · last used ${formatRelative(a.last_used_at)}`}
                right={formatDuration(a.active_seconds)}
                onPress={() => router.push({ pathname: '/app-usage', params: { ...params, app: a.app_name } })} />
            ))}
          </Card>
          <Card title={`Web Activity Summary (${data.domains.length})`}>
            {data.domains.length === 0 ? <Empty text="No websites recorded for this period." /> : null}
            {data.domains.map((d) => (
              <LinkRow key={d.domain} title={d.domain} subtitle={d.sample_title} right={formatDuration(d.active_seconds)}
                onPress={() => router.push({ pathname: '/website', params: { ...params, domain: d.domain } })} />
            ))}
          </Card>
          {data.projects.length > 0 ? (
            <Card title="Projects">
              {data.projects.map((p) => (
                <BarRow key={p.project_id ?? 'none'} label={p.project_name} value={p.active_seconds} max={projectMax}
                  right={formatDuration(p.active_seconds)} color="#7c3aed" />
              ))}
            </Card>
          ) : null}
          <Text style={[styles.hint, { textAlign: 'center' }]}>Times shown are active time. Tap a row for details.</Text>
          <Text style={[styles.hint, { textAlign: 'center' }]}>Day boundaries use {timezone}.</Text>
        </>
      ) : null}
    </>
  );
}

function History({ id, name, timezone, today, isSelf }: { id: string; name: string; timezone: string; today: string; isSelf: boolean }) {
  const from = addDays(today, -(HISTORY_DAYS - 1));
  const [exporting, setExporting] = useState(false);
  const { data, error, loading, refresh } = useAsync(() => api.dailyTotals(id, from, today), [id, from, today]);
  const days = [...(data ?? [])].reverse();

  async function exportCsv() {
    if (!data) return;
    setExporting(true);
    try {
      const rows = data.map((d) => [
        d.day, d.active_seconds, d.idle_seconds, d.paused_seconds, d.away_seconds,
        formatTime(d.first_activity_at, timezone), formatTime(d.last_activity_at, timezone),
      ]);
      if (!isSelf) await api.logAccess(id, 'exported_data', { from, to: today, format: 'csv', scope: 'daily' });
      await shareCsv(`mycroscope_${name}_${from}_${today}`, toCsv(
        ['date', 'active_seconds', 'idle_seconds', 'paused_seconds', 'away_seconds', 'first_activity', 'last_activity'], rows));
    } catch (e) {
      notify('Export failed', errorMessage(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {loading && !data ? <Loading /> : null}
      {data ? (
        <Card title={`Daily Summaries (last ${HISTORY_DAYS} days)`}>
          {days.map((d) => (
            <LinkRow key={d.day} title={formatDay(d.day, { weekday: true })}
              subtitle={d.first_activity_at
                ? `${formatTime(d.first_activity_at, timezone)}–${formatTime(d.last_activity_at, timezone)} · ${formatDuration(d.idle_seconds)} idle`
                : 'No activity'}
              right={formatDuration(d.active_seconds)}
              onPress={() => router.push({ pathname: '/day', params: { id, day: d.day } })} />
          ))}
        </Card>
      ) : null}
      <Button title="Export daily summaries (CSV)" variant="secondary" onPress={exportCsv} loading={exporting} disabled={!data} />
    </>
  );
}

const local = StyleSheet.create({
  header: { backgroundColor: colors.card, padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 3 },
  name: { fontSize: 18, fontWeight: 'bold', color: colors.text },
  status: { fontSize: 13, fontWeight: '600' },
  body: { padding: 12, gap: 12, paddingBottom: 40 },
});
