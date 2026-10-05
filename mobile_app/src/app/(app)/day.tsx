import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { Timeline } from '@/components/Timeline';
import {
  BarRow, Button, Card, Empty, ErrorBanner, LinkRow, Loading, Screen, StatGrid, colors, stateColor, styles,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { notify } from '@/lib/dialog';
import { shareCsv } from '@/lib/export';
import { addDays, formatDay, formatDuration, formatTime, toCsv, todayIn } from '@/lib/format';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

export default function DayDetail() {
  const profile = useProfile();
  const tz = profile.timezone;
  const params = useLocalSearchParams<{ id: string; day?: string }>();
  const id = params.id;
  const today = todayIn(tz);
  const day = params.day ?? today;
  const isSelf = id === profile.employeeId;
  const [exporting, setExporting] = useState(false);

  const { data, error, loading, refreshing, refresh } = useAsync(async () => {
    const [employee, totals, timeline, apps, domains, projects] = await Promise.all([
      api.employee(id),
      api.dailyTotals(id, day, day),
      api.timeline(id, day),
      api.appTotals(id, day, day),
      api.domainTotals(id, day, day),
      api.projectTotals(id, day, day),
    ]);
    return { employee, totals: totals[0], timeline, apps, domains, projects };
  }, [id, day]);

  const go = (d: string) => router.setParams({ day: d });
  const name = data?.employee?.name ?? '';
  const t = data?.totals;
  const projectMax = Math.max(0, ...(data?.projects ?? []).map((p) => p.active_seconds));
  const drill = { id, from: day, to: day, label: formatDay(day, { weekday: true }), name };

  async function exportDay() {
    if (!data) return;
    setExporting(true);
    try {
      const rows = data.timeline.map((r) => [
        day, formatTime(r.started_at, tz), formatTime(r.ended_at, tz), r.duration_seconds, r.state,
        r.app_name, r.window_title, r.domain, r.url, r.project_name,
      ]);
      if (!isSelf) await api.logAccess(id, 'exported_data', { day, format: 'csv' });
      await shareCsv(`mycroscope_${name}_${day}`, toCsv(
        ['date', 'start', 'end', 'seconds', 'state', 'app', 'window_title', 'domain', 'url', 'project'], rows));
    } catch (e) {
      notify('Export failed', errorMessage(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Stack.Screen options={{ title: formatDay(day, { weekday: true }) }} />
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Button small variant="secondary" title="‹ Previous day" onPress={() => go(addDays(day, -1))} />
        <Button small variant="secondary" title="Next day ›" disabled={day >= today} onPress={() => go(addDays(day, 1))} />
      </View>
      {name ? <Text style={styles.cardTitle}>{name}</Text> : null}
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {loading && !data ? <Loading /> : null}
      {data ? (
        <>
          <StatGrid items={[
            { label: 'Active', value: formatDuration(t?.active_seconds), color: stateColor.active },
            { label: 'Idle', value: formatDuration(t?.idle_seconds), color: stateColor.idle },
            { label: 'Paused', value: formatDuration(t?.paused_seconds), color: stateColor.paused },
            { label: 'Away', value: formatDuration(t?.away_seconds), color: colors.muted },
          ]} />
          <Text style={[styles.hint, { textAlign: 'center' }]}>
            {t?.first_activity_at
              ? `First activity ${formatTime(t.first_activity_at, tz)} · last ${formatTime(t.last_activity_at, tz)}`
              : 'No activity recorded'}
          </Text>

          <Card title={`Application Summary (${data.apps.length})`}>
            {data.apps.length === 0 ? <Empty text="No applications recorded." /> : null}
            {data.apps.map((a) => (
              <LinkRow key={a.app_name} title={a.app_name} subtitle={`${formatDuration(a.idle_seconds)} idle`}
                right={formatDuration(a.active_seconds)}
                onPress={() => router.push({ pathname: '/app-usage', params: { ...drill, app: a.app_name } })} />
            ))}
          </Card>
          <Card title={`Web Activity Summary (${data.domains.length})`}>
            {data.domains.length === 0 ? <Empty text="No websites recorded." /> : null}
            {data.domains.map((d) => (
              <LinkRow key={d.domain} title={d.domain} subtitle={d.sample_title} right={formatDuration(d.active_seconds)}
                onPress={() => router.push({ pathname: '/website', params: { ...drill, domain: d.domain } })} />
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
          <Timeline rows={data.timeline} timezone={tz} />
          <Button title="Export this day (CSV)" variant="secondary" onPress={exportDay} loading={exporting}
            disabled={data.timeline.length === 0} />
          <Text style={[styles.hint, { textAlign: 'center' }]}>Times shown in {tz}.</Text>
        </>
      ) : null}
    </Screen>
  );
}
