import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { ChooseDay } from '@/components/DayPicker';
import {
  Button, Card, ColumnChart, Empty, ErrorBanner, Loading, Screen, Segmented, StackedBar, StatGrid, colors, stateColor, styles,
} from '@/components/ui';
import { buildActivityReport } from '@/lib/activityReport';
import { api, errorMessage, type DailyTotal, type EmployeeRow } from '@/lib/api';
import { notify } from '@/lib/dialog';
import { activityChart } from '@/lib/charts';
import { sharePdf, shareCsv } from '@/lib/export';
import {
  PERIOD_LABELS, formatDay, formatDuration, formatTime, offlineSeconds, periodRange, toCsv, todayIn,
  type PeriodKey,
} from '@/lib/format';
import { ALL_PROJECTS, isProjectFilter, projectChoicesForDay, projectScopeName, projectScopePhrase } from '@/lib/projects';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

interface Line {
  employee: EmployeeRow;
  days: DailyTotal[];
  active: number;
  idle: number;
  away: number;
  paused: number;
  offline: number;
  productiveOffline: number;
  daysWorked: number;
}

function activityPoints(lines: Line[], single: Line | undefined): { label: string; activeSeconds: number }[] {
  if (single) {
    const many = single.days.length > 16;
    return single.days.map((day) => ({
      label: many ? String(Number(day.day.slice(8, 10))) : formatDay(day.day).replace(/ \d{4}$/, ''),
      activeSeconds: day.active_seconds,
    }));
  }
  return lines.map((line) => ({ label: line.employee.name, activeSeconds: line.active }));
}

const ALL = 'all';
const PERIODS = (Object.keys(PERIOD_LABELS) as PeriodKey[]).map((value) => ({ value, label: PERIOD_LABELS[value] }));

export default function Reports() {
  const profile = useProfile();
  const [period, setPeriod] = useState<PeriodKey>('this_week');
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [who, setWho] = useState<string>(ALL);
  const [team, setTeam] = useState<string>(ALL);
  const [project, setProject] = useState<string>(ALL_PROJECTS);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | 'timesheet' | null>(null);
  const today = todayIn(profile.timezone);
  const range = pickedDay ? { from: pickedDay, to: pickedDay } : periodRange(period, today);
  const projectFilter = isProjectFilter(project) ? project : null;

  const employees = useAsync(async () => (await api.employees()).filter((e) => e.auth_user_id), []);
  const projects = useAsync(() => api.projects(who === ALL ? undefined : who), [who]);
  const features = useAsync(() => api.features(), []);
  const teamsAllowed = features.data?.includes('teams') ?? false;
  const teams = useAsync(async () => (teamsAllowed ? (await api.teams()).teams : []), [teamsAllowed]);
  const projectLabel = projectScopeName(project, projects.data);
  const projectPhrase = projectScopePhrase(project, projects.data);
  const teamName = teams.data?.find((t) => t.id === team)?.name;
  const people = (employees.data ?? []).filter((e) => !teamsAllowed || team === ALL || e.team_id === team);
  const selected = who === ALL ? people.filter((e) => e.is_active) : people.filter((e) => e.id === who);
  const selectedKey = selected.map((e) => e.id).join(',');
  const workedProjects = useAsync(async () => {
    const lists = await Promise.all(selected.map((employee) => api.projectTotals(employee.id, range.from, range.to)));
    return lists.flat();
  }, [range.from, range.to, selectedKey]);
  const ownedProjects = (projects.data ?? []).map((item) => ({
    ...item,
    owner: (employees.data ?? []).find((person) => person.id === item.employee_id)?.name,
  }));
  const projectOptions = workedProjects.data
    ? projectChoicesForDay(ownedProjects, workedProjects.data)
    : [];
  useEffect(() => {
    if (!workedProjects.data) return;
    if (!projectOptions.some((option) => option.value === project)) setProject(ALL_PROJECTS);
  }, [workedProjects.data, project, projectOptions]);

  const { data, error, loading, refreshing, refresh } = useAsync(async () => {
    const lines = await Promise.all(selected.map(async (employee): Promise<Line> => {
      const days = await api.dailyTotals(employee.id, range.from, range.to, projectFilter);
      const sum = (k: keyof DailyTotal) => days.reduce((a, d) => a + Number(d[k] ?? 0), 0);
      return {
        employee, days,
        active: sum('active_seconds'), idle: sum('idle_seconds'), away: sum('away_seconds'), paused: sum('paused_seconds'),
        offline: days.reduce((a, d) => a + offlineSeconds(d), 0),
        productiveOffline: sum('productive_offline_seconds'),
        daysWorked: days.filter((d) => d.active_seconds > 0).length,
      };
    }));
    return lines.sort((a, b) => b.active - a.active);
  }, [range.from, range.to, selectedKey, projectFilter]);

  const totals = useMemo(() => (data ?? []).reduce(
    (t, l) => ({
      active: t.active + l.active, idle: t.idle + l.idle, paused: t.paused + l.paused,
      offline: t.offline + l.offline, productiveOffline: t.productiveOffline + l.productiveOffline,
    }),
    { active: 0, idle: 0, paused: 0, offline: 0, productiveOffline: 0 }), [data]);
  const single = who !== ALL ? data?.[0] : undefined;
  const scopeName = single ? single.employee.name : teamName ?? 'Team';
  const periodLabel = pickedDay ? formatDay(pickedDay, { weekday: true }) : PERIOD_LABELS[period];
  const title = `${scopeName} activity · ${periodLabel}${projectPhrase ? ` · ${projectPhrase}` : ''}`;
  const subtitle = (range.from === range.to ? formatDay(range.from) : `${formatDay(range.from)} – ${formatDay(range.to)}`)
    + (projectPhrase ? ` · ${projectPhrase}` : '');

  async function logExport(format: string) {
    await Promise.all((data ?? []).map((l) =>
      api.logAccess(l.employee.id, 'exported_report', {
        from: range.from, to: range.to, format, scope: who === ALL ? 'team' : 'employee',
        ...(teamName ? { team: teamName } : {}),
        ...(projectLabel ? { project: projectLabel } : {}),
      })));
  }

  async function exportCsv() {
    if (!data) return;
    setExporting('csv');
    try {
      const rows = data.flatMap((l) => l.days.map((d) => [
        d.day, l.employee.name, l.employee.employee_code, projectLabel ?? 'All projects', d.active_seconds, d.idle_seconds, d.paused_seconds,
        d.away_seconds, d.meeting_seconds, d.call_seconds, d.break_seconds, d.other_seconds, d.productive_offline_seconds,
        (d.active_seconds / 3600).toFixed(2),
      ]));
      await logExport('csv');
      await shareCsv(`mycroscope_${scopeName}${projectLabel ? `_${projectLabel}` : ''}_${range.from}_${range.to}`, toCsv(
        ['date', 'employee', 'employee_code', 'project', 'active_seconds', 'idle_seconds', 'paused_seconds', 'away_seconds',
          'meeting_seconds', 'call_seconds', 'break_seconds', 'other_seconds', 'productive_offline_seconds', 'active_hours'],
        rows));
    } catch (e) {
      notify('Export failed', errorMessage(e));
    } finally {
      setExporting(null);
    }
  }

  /** One row per person per day with first/last activity, for payroll and time-and-attendance. */
  async function exportTimesheet() {
    if (!data) return;
    setExporting('timesheet');
    try {
      const hours = (s: number) => (s / 3600).toFixed(2);
      const rows = data.flatMap((l) => l.days.filter((d) => d.first_activity_at).map((d) => {
        const span = (Date.parse(d.last_activity_at!) - Date.parse(d.first_activity_at!)) / 1000;
        return [
          d.day, l.employee.name, l.employee.employee_code,
          formatTime(d.first_activity_at, profile.timezone), formatTime(d.last_activity_at, profile.timezone),
          hours(span), hours(d.active_seconds), hours(d.idle_seconds), hours(d.paused_seconds),
        ];
      }));
      await logExport('timesheet_csv');
      await shareCsv(`mycroscope_timesheet_${scopeName}${projectLabel ? `_${projectLabel}` : ''}_${range.from}_${range.to}`, toCsv(
        ['date', 'employee', 'employee_code', `first_activity (${profile.timezone})`, 'last_activity', 'span_hours',
          'active_hours', 'idle_hours', 'paused_hours'], rows));
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
      const granted = features.data ?? await api.features();
      const software = granted.includes('software_usage');
      const coaching = granted.includes('coaching');
      const packs = await Promise.all(data.map(async (line) => {
        const [apps, domains, categories, projects] = await Promise.all([
          software ? api.appTotals(line.employee.id, range.from, range.to, projectFilter) : Promise.resolve([]),
          software ? api.domainTotals(line.employee.id, range.from, range.to, projectFilter) : Promise.resolve([]),
          software
            ? api.categoryTotals(line.employee.id, range.from, range.to, projectFilter).catch(() => [])
            : Promise.resolve([]),
          projectFilter ? Promise.resolve([]) : api.projectTotals(line.employee.id, range.from, range.to),
        ]);
        return { apps, domains, categories, projects };
      }));
      const apps = new Map<string, { active: number; idle: number }>();
      const websites = new Map<string, number>();
      const categories = new Map<string, number>();
      const projects = new Map<string, number>();
      for (const [i, pack] of packs.entries()) {
        for (const app of pack.apps) {
          const prev = apps.get(app.app_name) ?? { active: 0, idle: 0 };
          apps.set(app.app_name, { active: prev.active + app.active_seconds, idle: prev.idle + app.idle_seconds });
        }
        for (const site of pack.domains) websites.set(site.domain, (websites.get(site.domain) ?? 0) + site.active_seconds);
        for (const row of pack.categories) categories.set(row.category, (categories.get(row.category) ?? 0) + row.active_seconds);
        for (const row of pack.projects) {
          const key = packs.length > 1 ? `${data[i].employee.name} · ${row.project_name}` : row.project_name;
          projects.set(key, (projects.get(key) ?? 0) + row.active_seconds);
        }
      }
      const report = buildActivityReport({
        organization: profile.organizationName,
        timezone: profile.timezone,
        scopeName,
        periodLabel,
        from: range.from,
        to: range.to,
        projectLabel,
        generatedBy: profile.name,
        people: data.map((line) => ({
          name: line.employee.name,
          days: line.days.map((day) => ({
            day: day.day, active: day.active_seconds, idle: day.idle_seconds, paused: day.paused_seconds,
            away: day.away_seconds, offline: offlineSeconds(day), productiveOffline: day.productive_offline_seconds,
          })),
        })),
        apps: [...apps].map(([name, time]) => ({ name, ...time })),
        websites: [...websites].map(([name, active]) => ({ name, active })),
        categories: [...categories].map(([category, active]) => ({ category, active })),
        projects: [...projects].map(([name, active]) => ({ name, active })),
        access: { software, coaching },
      });
      await logExport('pdf');
      const fileScope = projectLabel ? `_${projectLabel}` : '';
      await sharePdf(`mycroscope_activity_${scopeName}${fileScope}_${range.from}_${range.to}`, report);
    } catch (e) {
      notify('Export failed', errorMessage(e));
    } finally {
      setExporting(null);
    }
  }

  const chart = data ? activityChart(activityPoints(data, single), !single) : null;
  const max = Math.max(1, ...(data ?? []).map((l) => l.active + l.idle + l.paused));
  const dayMax = Math.max(1, ...(single?.days ?? []).map((d) => d.active_seconds + d.idle_seconds + d.paused_seconds));

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      {teamsAllowed && (teams.data?.length ?? 0) > 0 ? (
        <Card title="Select Team">
          <Segmented value={team} onChange={(v) => { setTeam(v); setWho(ALL); }} options={[
            { value: ALL, label: 'All teams' },
            ...(teams.data ?? []).map((t) => ({ value: t.id, label: t.name })),
          ]} />
        </Card>
      ) : null}
      <Card title="Select Employee">
        {employees.error ? <ErrorBanner message={employees.error} onRetry={employees.refresh} /> : null}
        <Segmented value={who} onChange={setWho} options={[
          { value: ALL, label: teamName ? `Everyone in ${teamName}` : 'All employees' },
          ...people.map((e) => ({ value: e.id, label: e.is_active ? e.name : `${e.name} (deactivated)` })),
        ]} />
      </Card>
      {projectOptions.length > 1 ? (
        <Card title="Select Project">
          <Segmented value={project} onChange={setProject} options={projectOptions} />
          <Text style={styles.hint}>
            No project is computer time recorded without a project selected. Time away stays on All projects.
          </Text>
        </Card>
      ) : null}
      <Card title="Select Period">
        <Segmented options={PERIODS} value={pickedDay ? null : period}
          onChange={(value) => { setPickedDay(null); setPeriod(value); }} />
        <ChooseDay day={pickedDay} today={today} onChange={setPickedDay} />
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
            { label: 'Time away', value: formatDuration(totals.offline) },
          ]} />
          {chart ? (
            <Card title={chart.title}>
              <ColumnChart points={chart.points} />
            </Card>
          ) : null}
          <Text style={styles.hint}>
            Time away is what people said an idle or away stretch was, so it also sits inside idle or away.
            {projectFilter
              ? ' A named project or No project leaves it out, because it is not tied to a project.'
              : ` ${formatDuration(totals.productiveOffline)} of it is counted as productive.`}
          </Text>
          {single ? (
            <Card title={`${single.employee.name} · by day`}>
              {single.days.map((d) => (
                <Pressable key={d.day} style={{ paddingVertical: 5, gap: 4 }}
                  onPress={() => router.push({
                    pathname: '/day',
                    params: { id: single.employee.id, day: d.day, ...(projectFilter ? { project: projectFilter } : {}) },
                  })}>
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
          <Button title="Export timesheet (CSV)" variant="secondary" onPress={exportTimesheet}
            loading={exporting === 'timesheet'} disabled={!data.length} />
          <Text style={[styles.hint, { textAlign: 'center' }]}>
            Timesheet: first and last activity per day plus active, idle and paused hours, for payroll.
          </Text>
          <Text style={[styles.hint, { color: colors.muted, textAlign: 'center' }]}>Exports are recorded in the audit log.</Text>
        </>
      ) : null}
    </Screen>
  );
}
