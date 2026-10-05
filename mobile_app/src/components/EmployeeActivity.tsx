import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import {
  BarRow, Button, Card, Empty, ErrorBanner, Loading, Screen, StackedBar, Stat, colors, stateColor, stateLabel, styles,
} from '@/components/ui';
import { api, errorMessage, type TimelineRow } from '@/lib/api';
import { shareCsv } from '@/lib/export';
import { addDays, formatDay, formatDuration, formatTime, toCsv, todayIn, type Ymd } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';

interface Props {
  employeeId: string;
  employeeName: string;
  timezone: string;
  isSelf: boolean;
  header?: React.ReactNode;
}

interface Block {
  key: string;
  state: TimelineRow['state'];
  start: string;
  end: string;
  seconds: number;
  label: string;
  detail: string | null;
}

/** Merges consecutive segments with the same state and app/site into readable blocks. */
function toBlocks(rows: TimelineRow[]): Block[] {
  const blocks: Block[] = [];
  for (const r of rows) {
    const label = r.state === 'active' ? (r.app_name ?? 'Unknown app') : stateLabel[r.state];
    const detail = r.state === 'active' ? (r.domain ?? r.window_title) : null;
    const last = blocks[blocks.length - 1];
    if (last && last.state === r.state && last.label === label && last.end === r.started_at &&
        (r.state !== 'active' || last.detail === detail)) {
      last.end = r.ended_at;
      last.seconds += r.duration_seconds;
    } else {
      blocks.push({ key: r.id, state: r.state, start: r.started_at, end: r.ended_at, seconds: r.duration_seconds, label, detail });
    }
  }
  return blocks;
}

export function EmployeeActivity({ employeeId, employeeName, timezone, isSelf, header }: Props) {
  const today = todayIn(timezone);
  const [day, setDay] = useState<Ymd>(today);
  const [showAllTimeline, setShowAllTimeline] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!isSelf) api.logAccess(employeeId, 'viewed_employee', { day });
    // Logged once per screen visit, not per day change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, isSelf]);

  const { data, error, loading, refreshing, refresh } = useAsync(async () => {
    const [week, timeline, apps, domains, projects] = await Promise.all([
      api.dailyTotals(employeeId, addDays(day, -6), day),
      api.timeline(employeeId, day),
      api.appTotals(employeeId, day, day),
      api.domainTotals(employeeId, day, day),
      api.projectTotals(employeeId, day, day),
    ]);
    return { week, timeline, apps, domains, projects };
  }, [employeeId, day]);

  const totals = data?.week.find((d) => d.day === day);
  const blocks = useMemo(() => toBlocks(data?.timeline ?? []), [data]);
  const shownBlocks = showAllTimeline ? blocks : blocks.slice(-25);
  const weekMax = Math.max(1, ...(data?.week ?? []).map((d) => d.active_seconds + d.idle_seconds + d.paused_seconds));
  const appMax = data?.apps[0]?.active_seconds ?? 0;
  const domainMax = data?.domains[0]?.active_seconds ?? 0;
  const projectMax = Math.max(0, ...(data?.projects ?? []).map((p) => p.active_seconds));

  async function exportDay() {
    if (!data) return;
    setExporting(true);
    try {
      const rows = data.timeline.map((r) => [
        day, formatTime(r.started_at, timezone), formatTime(r.ended_at, timezone), r.duration_seconds, r.state,
        r.app_name, r.window_title, r.domain, r.url, r.project_name,
      ]);
      const csv = toCsv(['date', 'start', 'end', 'seconds', 'state', 'app', 'window_title', 'domain', 'url', 'project'], rows);
      if (!isSelf) await api.logAccess(employeeId, 'exported_data', { day, format: 'csv' });
      await shareCsv(`mycroscope_${employeeName}_${day}`, csv);
    } catch (e) {
      Alert.alert('Export failed', errorMessage(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      {header}
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Button small variant="secondary" title="‹ Prev" onPress={() => setDay(addDays(day, -1))} />
        <Pressable onPress={() => setDay(today)}>
          <Text style={styles.cardTitle}>{day === today ? 'Today' : formatDay(day, { weekday: true })}</Text>
        </Pressable>
        <Button small variant="secondary" title="Next ›" disabled={day >= today} onPress={() => setDay(addDays(day, 1))} />
      </View>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {loading && !data ? <Loading /> : null}
      {data ? (
        <>
          <Card>
            <View style={{ flexDirection: 'row' }}>
              <Stat label="Active" value={formatDuration(totals?.active_seconds)} color={stateColor.active} />
              <Stat label="Idle" value={formatDuration(totals?.idle_seconds)} color={stateColor.idle} />
              <Stat label="Paused" value={formatDuration(totals?.paused_seconds)} color={stateColor.paused} />
              <Stat label="Away" value={formatDuration(totals?.away_seconds)} color={colors.muted} />
            </View>
            <Text style={[styles.hint, { textAlign: 'center' }]}>
              {totals?.first_activity_at
                ? `First activity ${formatTime(totals.first_activity_at, timezone)} · last ${formatTime(totals.last_activity_at, timezone)}`
                : 'No activity recorded'}
            </Text>
          </Card>

          <Card title="Last 7 days">
            {data.week.map((d) => (
              <Pressable key={d.day} onPress={() => setDay(d.day)} style={{ gap: 3, paddingVertical: 3 }}>
                <View style={[styles.row, { justifyContent: 'space-between' }]}>
                  <Text style={[styles.rowText, d.day === day && { fontWeight: '700' }]}>{formatDay(d.day, { weekday: true })}</Text>
                  <Text style={styles.rowText}>{formatDuration(d.active_seconds)}</Text>
                </View>
                <View style={{ width: `${((d.active_seconds + d.idle_seconds + d.paused_seconds) / weekMax) * 100}%`, minWidth: 2 }}>
                  <StackedBar height={8} parts={[
                    { value: d.active_seconds, color: stateColor.active },
                    { value: d.idle_seconds, color: stateColor.idle },
                    { value: d.paused_seconds, color: stateColor.paused },
                  ]} />
                </View>
              </Pressable>
            ))}
          </Card>

          <Card title="Applications">
            {data.apps.length === 0 ? <Empty text="No application data for this day." /> : null}
            {data.apps.slice(0, 10).map((a) => (
              <BarRow key={a.app_name} label={a.app_name} value={a.active_seconds} max={appMax}
                right={formatDuration(a.active_seconds)} />
            ))}
          </Card>

          <Card title="Websites">
            {data.domains.length === 0 ? <Empty text="No website data for this day." /> : null}
            {data.domains.slice(0, 10).map((d) => (
              <BarRow key={d.domain} label={d.domain} sub={d.sample_title ?? undefined} value={d.active_seconds}
                max={domainMax} right={formatDuration(d.active_seconds)} color="#2563eb" />
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

          <Card title="Timeline" right={blocks.length > 25 ? (
            <Text style={{ color: colors.primary }} onPress={() => setShowAllTimeline(!showAllTimeline)}>
              {showAllTimeline ? 'Latest only' : `Show all ${blocks.length}`}
            </Text>
          ) : undefined}>
            {blocks.length === 0 ? <Empty text="Nothing recorded." /> : null}
            {shownBlocks.map((b) => (
              <View key={b.key} style={[styles.row, { alignItems: 'flex-start', paddingVertical: 4 }]}>
                <View style={[styles.dot, { backgroundColor: stateColor[b.state], marginTop: 6 }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowText} numberOfLines={1}>{b.label}</Text>
                  {b.detail ? <Text style={styles.hint} numberOfLines={1}>{b.detail}</Text> : null}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.hint}>{formatTime(b.start, timezone)}–{formatTime(b.end, timezone)}</Text>
                  <Text style={styles.hint}>{formatDuration(b.seconds)}</Text>
                </View>
              </View>
            ))}
          </Card>

          <Button title="Export this day (CSV)" variant="secondary" onPress={exportDay} loading={exporting}
            disabled={data.timeline.length === 0} />
          <Text style={[styles.hint, { textAlign: 'center' }]}>
            Times shown in {timezone}.{!isSelf ? ' Viewing and exporting is recorded in the audit log.' : ''}
          </Text>
        </>
      ) : null}
    </Screen>
  );
}
