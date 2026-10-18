import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { ProjectDayGroups } from '@/components/ProjectDayGroups';
import { Timeline } from '@/components/Timeline';
import {
  Button, Card, Empty, ErrorBanner, LinkRow, Loading, Screen, StatGrid, colors, stateColor, styles,
} from '@/components/ui';
import { api, errorMessage, type AppTotal, type DomainTotal } from '@/lib/api';
import { notify } from '@/lib/dialog';
import { shareCsv } from '@/lib/export';
import { addDays, formatDay, formatDuration, formatTime, offlineSeconds, offlineSummary, toCsv, todayIn } from '@/lib/format';
import { groupDayBreakdown } from '@/lib/dayBreakdown';
import { NO_PROJECT, isProjectFilter, projectScopeName, projectScopePhrase } from '@/lib/projects';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

export default function DayDetail() {
  const profile = useProfile();
  const tz = profile.timezone;
  const params = useLocalSearchParams<{ id: string; day?: string; project?: string }>();
  const id = params.id;
  const today = todayIn(tz);
  const day = params.day ?? today;
  const project = isProjectFilter(params.project) ? params.project : null;
  const isSelf = id === profile.employeeId;
  const [exporting, setExporting] = useState(false);
  const features = useAsync(() => api.features(), []);
  const software = features.data?.includes('software_usage') ?? false;
  const projectList = useAsync(
    () => (project && project !== NO_PROJECT ? api.projects(id) : Promise.resolve([])),
    [project, id]);
  const scope = projectScopePhrase(project, projectList.data);

  const { data, error, loading, refreshing, refresh } = useAsync(async () => {
    const [employee, totals, timeline, apps, domains, breakdown] = await Promise.all([
      api.employee(id),
      api.dailyTotals(id, day, day, project),
      api.timeline(id, day, project),
      software && project ? api.appTotals(id, day, day, project) : Promise.resolve([] as AppTotal[]),
      software && project ? api.domainTotals(id, day, day, project) : Promise.resolve([] as DomainTotal[]),
      software && !project ? api.dayBreakdown(id, day) : Promise.resolve([]),
    ]);
    return { employee, totals: totals[0], timeline, apps, domains, groups: groupDayBreakdown(breakdown) };
  }, [id, day, project, software]);

  const go = (d: string) => router.setParams({ day: d });
  const name = data?.employee?.name ?? '';
  const t = data?.totals;
  const drill = {
    id, from: day, to: day, label: `${formatDay(day, { weekday: true })}${scope ? ` · ${scope}` : ''}`, name,
    ...(project ? { project } : {}),
  };

  async function exportDay() {
    if (!data) return;
    setExporting(true);
    try {
      const rows = data.timeline.map((r) => [
        day, formatTime(r.started_at, tz), formatTime(r.ended_at, tz), r.duration_seconds, r.state,
        software ? r.app_name : '', software ? r.window_title : '', software ? r.domain : '', software ? r.url : '', r.project_name,
      ]);
      if (!isSelf) await api.logAccess(id, 'exported_data', {
        day, format: 'csv', ...(project ? { project: projectScopeName(project, projectList.data) ?? project } : {}),
      });
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
      {project ? (
        <Text style={[styles.hint, { textAlign: 'center' }]}>
          {project === NO_PROJECT
            ? 'Only activity recorded with no project selected.'
            : `Only the ${projectScopeName(project, projectList.data) ?? 'selected'} project.`}
          {' '}Time away is left out, because it is not tied to a project.
        </Text>
      ) : null}
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
          {offlineSeconds(t ?? {}) > 0 ? (
            <Text style={[styles.hint, { textAlign: 'center' }]}>
              Time away: {offlineSummary(t ?? {})}
              {(t?.productive_offline_seconds ?? 0) > 0
                ? ` · ${formatDuration(t?.productive_offline_seconds)} counted as productive`
                : ''}
            </Text>
          ) : null}

          {software && project ? (
            <>
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
            </>
          ) : software ? (
            <ProjectDayGroups groups={data.groups}
              onApp={(group, app) => router.push({
                pathname: '/app-usage',
                params: {
                  ...drill, app, project: group.projectId ?? NO_PROJECT,
                  label: `${formatDay(day, { weekday: true })} · ${group.projectId ? `project ${group.name}` : 'no project'}`,
                },
              })}
              onWebsite={(group, domain) => router.push({
                pathname: '/website',
                params: {
                  ...drill, domain, project: group.projectId ?? NO_PROJECT,
                  label: `${formatDay(day, { weekday: true })} · ${group.projectId ? `project ${group.name}` : 'no project'}`,
                },
              })} />
          ) : null}
          <Timeline rows={data.timeline} timezone={tz} apps={software} />
          <Button title="Export this day (CSV)" variant="secondary" onPress={exportDay} loading={exporting}
            disabled={data.timeline.length === 0} />
          <Text style={[styles.hint, { textAlign: 'center' }]}>Times shown in {tz}.</Text>
        </>
      ) : null}
    </Screen>
  );
}
