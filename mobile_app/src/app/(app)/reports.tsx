import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import {
  Button, Card, Empty, ErrorBanner, Loading, Screen, Segmented, StackedBar, StatGrid, colors, stateColor, styles,
} from '@/components/ui';
import { api, errorMessage, type DailyTotal, type EmployeeRow } from '@/lib/api';
import { notify } from '@/lib/dialog';
import { sharePdf, shareCsv } from '@/lib/export';
import {
  PERIOD_LABELS, formatDay, formatDuration, htmlEscape, percent, periodRange, toCsv, todayIn, type PeriodKey,
} from '@/lib/format';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

interface Line {
  employee: EmployeeRow;
  days: DailyTotal[];
  active: number;
  idle: number;
  away: number;
  paused: number;
  daysWorked: number;
}

const ALL = 'all';
const PERIODS = (Object.keys(PERIOD_LABELS) as PeriodKey[]).map((value) => ({ value, label: PERIOD_LABELS[value] }));

export default function Reports() {
  const profile = useProfile();
  const [period, setPeriod] = useState<PeriodKey>('this_week');
  const [who, setWho] = useState<string>(ALL);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);
  const range = periodRange(period, todayIn(profile.timezone));

  const employees = useAsync(async () => (await api.employees()).filter((e) => e.auth_user_id), []);
  const people = employees.data ?? [];
  const selected = who === ALL ? people.filter((e) => e.is_active) : people.filter((e) => e.id === who);
  const selectedKey = selected.map((e) => e.id).join(',');

  const { data, error, loading, refreshing, refresh } = useAsync(async () => {
    const lines = await Promise.all(selected.map(async (employee): Promise<Line> => {
      const days = await api.dailyTotals(employee.id, range.from, range.to);
      const sum = (k: keyof DailyTotal) => days.reduce((a, d) => a + Number(d[k] ?? 0), 0);
      return {
        employee, days,
        active: sum('active_seconds'), idle: sum('idle_seconds'), away: sum('away_seconds'), paused: sum('paused_seconds'),
        daysWorked: days.filter((d) => d.active_seconds > 0).length,
      };
    }));
    return lines.sort((a, b) => b.active - a.active);
  }, [range.from, range.to, selectedKey]);

  const totals = useMemo(() => (data ?? []).reduce(
    (t, l) => ({ active: t.active + l.active, idle: t.idle + l.idle, paused: t.paused + l.paused }),
    { active: 0, idle: 0, paused: 0 }), [data]);
  const single = who !== ALL ? data?.[0] : undefined;
  const scopeName = single ? single.employee.name : 'Team';
  const title = `${scopeName} activity · ${PERIOD_LABELS[period]}`;
  const subtitle = range.from === range.to ? formatDay(range.from) : `${formatDay(range.from)} – ${formatDay(range.to)}`;

  async function logExport(format: string) {
    await Promise.all((data ?? []).map((l) =>
      api.logAccess(l.employee.id, 'exported_report', { from: range.from, to: range.to, format, scope: who === ALL ? 'team' : 'employee' })));
  }

  async function exportCsv() {
    if (!data) return;
    setExporting('csv');
    try {
      const rows = data.flatMap((l) => l.days.map((d) => [
        d.day, l.employee.name, l.employee.employee_code, d.active_seconds, d.idle_seconds, d.paused_seconds,
        d.away_seconds, (d.active_seconds / 3600).toFixed(2),
      ]));
      await logExport('csv');
      await shareCsv(`mycroscope_${scopeName}_${range.from}_${range.to}`, toCsv(
        ['date', 'employee', 'employee_code', 'active_seconds', 'idle_seconds', 'paused_seconds', 'away_seconds', 'active_hours'],
        rows));
    } catch (e) {
      notify('Export failed', errorMessage(e));
    } finally {
      setExporting(null);
    }
  }

  async function exportPdf() {
    if (!data) return;
    setExporting('pdf');
    try {
      const table = single
        ? `<table><tr><th>Day</th><th class="num">Active</th><th class="num">Idle</th><th class="num">Paused</th><th class="num">Away</th></tr>
          ${single.days.map((d) => `<tr><td>${htmlEscape(formatDay(d.day, { weekday: true }))}</td>
            <td class="num">${formatDuration(d.active_seconds)}</td><td class="num">${formatDuration(d.idle_seconds)}</td>
            <td class="num">${formatDuration(d.paused_seconds)}</td><td class="num">${formatDuration(d.away_seconds)}</td></tr>`).join('')}
          </table>`
        : `<table><tr><th>Employee</th><th class="num">Active</th><th class="num">Idle</th><th class="num">Paused</th>
          <th class="num">Days active</th><th class="num">Active share</th></tr>
          ${data.map((l) => `<tr><td>${htmlEscape(l.employee.name)}</td><td class="num">${formatDuration(l.active)}</td>
            <td class="num">${formatDuration(l.idle)}</td><td class="num">${formatDuration(l.paused)}</td>
            <td class="num">${l.daysWorked}</td><td class="num">${percent(l.active, l.active + l.idle)}</td></tr>`).join('')}
          </table>`;
      const body = `<p class="muted">${htmlEscape(profile.organizationName)} · ${htmlEscape(subtitle)} · times in ${htmlEscape(profile.timezone)}</p>
        <p>Total: ${formatDuration(totals.active)} active · ${formatDuration(totals.idle)} idle · ${formatDuration(totals.paused)} paused</p>
        ${table}<p class="muted">Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by ${htmlEscape(profile.name)}.
        Active = keyboard/mouse input within the idle threshold. Contains personal information: handle under POPIA.</p>`;
      await logExport('pdf');
      await sharePdf(title, body);
    } catch (e) {
      notify('Export failed', errorMessage(e));
    } finally {
      setExporting(null);
    }
  }

  const max = Math.max(1, ...(data ?? []).map((l) => l.active + l.idle + l.paused));
  const dayMax = Math.max(1, ...(single?.days ?? []).map((d) => d.active_seconds + d.idle_seconds + d.paused_seconds));

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Card title="Select Employee">
        {employees.error ? <ErrorBanner message={employees.error} onRetry={employees.refresh} /> : null}
        <Segmented value={who} onChange={setWho} options={[
          { value: ALL, label: 'All employees' },
          ...people.map((e) => ({ value: e.id, label: e.is_active ? e.name : `${e.name} (deactivated)` })),
        ]} />
      </Card>
      <Card title="Select Period">
        <Segmented options={PERIODS} value={period} onChange={setPeriod} />
        <Text style={styles.hint}>{subtitle} · {profile.timezone}</Text>
      </Card>

      <Text style={styles.sectionTitle}>Report Preview</Text>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {(loading || employees.loading) && !data ? <Loading /> : null}
      {data ? (
        <>
          <StatGrid items={[
            { label: 'Active', value: formatDuration(totals.active), color: stateColor.active },
            { label: 'Idle', value: formatDuration(totals.idle), color: stateColor.idle },
            { label: 'Paused', value: formatDuration(totals.paused), color: stateColor.paused },
          ]} />
          {single ? (
            <Card title={`${single.employee.name} · by day`}>
              {single.days.map((d) => (
                <Pressable key={d.day} style={{ paddingVertical: 5, gap: 4 }}
                  onPress={() => router.push({ pathname: '/day', params: { id: single.employee.id, day: d.day } })}>
                  <View style={[styles.row, { justifyContent: 'space-between' }]}>
                    <Text style={styles.rowText}>{formatDay(d.day, { weekday: true })}</Text>
                    <Text style={styles.rowText}>{formatDuration(d.active_seconds)}</Text>
                  </View>
                  <View style={{ width: `${((d.active_seconds + d.idle_seconds + d.paused_seconds) / dayMax) * 100}%`, minWidth: 2 }}>
                    <StackedBar height={8} parts={[
                      { value: d.active_seconds, color: stateColor.active },
                      { value: d.idle_seconds, color: stateColor.idle },
                      { value: d.paused_seconds, color: stateColor.paused },
                    ]} />
                  </View>
                </Pressable>
              ))}
            </Card>
          ) : (
            <Card title="By employee">
              {data.length === 0 ? <Empty text="No activated employees yet." /> : null}
              {data.map((l) => (
                <Pressable key={l.employee.id} style={{ paddingVertical: 6, gap: 4 }}
                  onPress={() => router.push({ pathname: '/employee/[id]', params: { id: l.employee.id } })}>
                  <View style={[styles.row, { justifyContent: 'space-between' }]}>
                    <Text style={[styles.rowText, { flex: 1, fontWeight: '600' }]} numberOfLines={1}>{l.employee.name}</Text>
                    <Text style={styles.rowText}>{formatDuration(l.active)}</Text>
                  </View>
                  <View style={{ width: `${((l.active + l.idle + l.paused) / max) * 100}%`, minWidth: 2 }}>
                    <StackedBar parts={[
                      { value: l.active, color: stateColor.active },
                      { value: l.idle, color: stateColor.idle },
                      { value: l.paused, color: stateColor.paused },
                    ]} />
                  </View>
                  <Text style={styles.hint}>
                    {formatDuration(l.idle)} idle · {formatDuration(l.paused)} paused · active {l.daysWorked} day(s)
                  </Text>
                </Pressable>
              ))}
            </Card>
          )}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Button title="Export CSV" variant="secondary" onPress={exportCsv} loading={exporting === 'csv'} disabled={!data.length} />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Export PDF" onPress={exportPdf} loading={exporting === 'pdf'} disabled={!data.length} />
            </View>
          </View>
          <Text style={[styles.hint, { color: colors.muted, textAlign: 'center' }]}>Exports are recorded in the audit log.</Text>
        </>
      ) : null}
    </Screen>
  );
}
