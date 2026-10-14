import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import {
  BarRow, Button, Card, Empty, ErrorBanner, Field, InnerTabs, Loading, Screen, Segmented, StackedBar, StatGrid, colors, styles,
} from '@/components/ui';
import {
  api, errorMessage, type AiAdoptionRow, type AiCatalogTool, type AiPersonUsage, type CapacityRow, type Feature, type Granularity, type OfficeAdherence, type SoftwareUsage, type TrendPoint, type WorkloadRow,
  type WorkloadStatus,
} from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import {
  addDays, daysBetween, formatDay, formatDuration, formatMoney, percent, periodRange, todayIn, type Ymd,
} from '@/lib/format';
import { manageableTeams } from '@/lib/scope';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

type Tab = 'trends' | 'workload' | 'capacity' | 'software' | 'where' | 'ai';
type Period = 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'last_30' | 'last_90' | 'last_365';

const ALL = '__all__';
const PERIODS: { value: Period; label: string }[] = [
  { value: 'this_week', label: 'This week' },
  { value: 'last_week', label: 'Last week' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'last_30', label: 'Last 30 days' },
  { value: 'last_90', label: 'Last 90 days' },
  { value: 'last_365', label: 'Last 12 months' },
];
const TAB_FEATURE: Record<Tab, Feature> = {
  trends: 'trends', workload: 'workload', capacity: 'workload', software: 'software_usage', where: 'work_location',
  ai: 'ai_tools',
};
const TAB_LABEL: Record<Tab, string> = {
  trends: 'Trends', workload: 'Workload', capacity: 'Capacity', software: 'Software', where: 'Office days',
  ai: 'AI tools',
};

/** The "last N days" periods end yesterday so a half-finished day doesn't drag the averages down. */
function rangeFor(period: Period, today: Ymd): { from: Ymd; to: Ymd } {
  switch (period) {
    case 'last_30': return { from: addDays(today, -30), to: addDays(today, -1) };
    case 'last_90': return { from: addDays(today, -90), to: addDays(today, -1) };
    case 'last_365': return { from: addDays(today, -365), to: addDays(today, -1) };
    default: return periodRange(period, today);
  }
}

function granularityFor(from: Ymd, to: Ymd): Granularity {
  const days = daysBetween(from, to) + 1;
  return days <= 31 ? 'day' : days <= 120 ? 'week' : 'month';
}

const hours = (seconds: number) => seconds / 3600;
const rand = (amount: number) => formatMoney(Math.round(amount * 100));

export default function Insights() {
  const profile = useProfile();
  const [tab, setTab] = useState<Tab>('trends');
  const [period, setPeriod] = useState<Period>('last_30');
  const [team, setTeam] = useState<string>(ALL);
  const range = rangeFor(period, todayIn(profile.timezone));
  const teamId = team === ALL ? null : team;

  const setup = useAsync(async () => {
    const [features, { teams, managers }] = await Promise.all([api.features(), api.teams()]);
    return { features, scope: manageableTeams(teams, managers, profile) };
  }, [profile.employeeId]);

  if (setup.loading && !setup.data) return <Loading />;
  if (!setup.data) return <Screen><ErrorBanner message={setup.error ?? 'Could not load insights.'} onRetry={setup.refresh} /></Screen>;

  const { features, scope } = setup.data;
  const tabs = (Object.keys(TAB_LABEL) as Tab[]).filter((t) => features.includes(TAB_FEATURE[t]));
  if (tabs.length === 0) {
    return (
      <Screen>
        <Card title="Insights">
          <Text style={styles.hint}>Workforce insights are not included in your plan. Contact Mycroscope to upgrade.</Text>
        </Card>
      </Screen>
    );
  }
  const current = tabs.includes(tab) ? tab : tabs[0];
  const teamOptions = [
    ...(scope.orgWide ? [{ value: ALL, label: 'All teams' }] : [{ value: ALL, label: 'All my teams' }]),
    ...scope.teams.map((t) => ({ value: t.id, label: t.name })),
  ];

  return (
    <Screen>
      <InnerTabs tabs={tabs.map((t) => ({ value: t, label: TAB_LABEL[t] }))} value={current} onChange={setTab} />
      {current !== 'capacity' && scope.teams.length > 0 ? (
        <Card title="Select Team">
          <Segmented value={team} onChange={setTeam} options={teamOptions} />
        </Card>
      ) : null}
      <Card title="Select Period">
        <Segmented options={PERIODS} value={period} onChange={setPeriod} />
        <Text style={styles.hint}>
          {formatDay(range.from)} to {formatDay(range.to)} · {profile.timezone}
        </Text>
      </Card>
      {current === 'trends' ? <Trends from={range.from} to={range.to} team={teamId} /> : null}
      {current === 'workload' ? <Workload from={range.from} to={range.to} team={teamId} /> : null}
      {current === 'capacity' ? <Capacity from={range.from} to={range.to} orgWide={scope.orgWide} teams={scope.teams} /> : null}
      {current === 'software' ? <Software from={range.from} to={range.to} team={teamId} orgWide={scope.orgWide} /> : null}
      {current === 'where' ? <Where from={range.from} to={range.to} team={teamId} /> : null}
      {current === 'ai' ? <AiTools from={range.from} to={range.to} team={teamId} orgWide={scope.orgWide} /> : null}
    </Screen>
  );
}

// ---- Trends -------------------------------------------------------------------

function sumTrend(points: TrendPoint[]) {
  return points.reduce((t, p) => ({
    personDays: t.personDays + p.person_days,
    active: t.active + p.active_seconds,
    productive: t.productive + p.productive_seconds,
    unproductive: t.unproductive + p.unproductive_seconds,
    offline: t.offline + p.offline_seconds,
    productiveOffline: t.productiveOffline + p.productive_offline_seconds,
  }), { personDays: 0, active: 0, productive: 0, unproductive: 0, offline: 0, productiveOffline: 0 });
}

/** Computer productive time plus the reasons the company counts as productive. */
function productiveTotal(t: { productive: number; productiveOffline: number }): number {
  return t.productive + t.productiveOffline;
}

function change(now: number, before: number): string {
  if (!before) return '';
  const pct = Math.round(((now - before) / before) * 100);
  return pct === 0 ? ' (no change)' : ` (${pct > 0 ? '+' : ''}${pct}% vs previous)`;
}

function periodLabel(start: Ymd, granularity: Granularity): string {
  if (granularity === 'month') {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(new Date(`${start}T12:00:00Z`));
  }
  return granularity === 'week' ? `Week of ${formatDay(start)}` : formatDay(start, { weekday: true });
}

function Trends({ from, to, team }: { from: Ymd; to: Ymd; team: string | null }) {
  const granularity = granularityFor(from, to);
  const { data, error, loading, refresh } = useAsync(async () => {
    const length = daysBetween(from, to) + 1;
    const [points, previous] = await Promise.all([
      api.trend(from, to, granularity, team),
      api.trend(addDays(from, -length), addDays(from, -1), 'month', team),
    ]);
    return { points, now: sumTrend(points), before: sumTrend(previous) };
  }, [from, to, team]);

  if (error) return <ErrorBanner message={error} onRetry={refresh} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;

  const { now, before } = data;
  const perDay = (s: number, days: number) => (days ? s / days : 0);
  const prodNow = perDay(productiveTotal(now), now.personDays);
  const prodBefore = perDay(productiveTotal(before), before.personDays);
  const activeNow = perDay(now.active, now.personDays);
  const activeBefore = perDay(before.active, before.personDays);
  const shown = data.points.filter((p) => p.person_days > 0);

  return (
    <>
      <StatGrid items={[
        { label: 'Productive per person-day', value: formatDuration(prodNow), color: colors.success },
        { label: 'Active per person-day', value: formatDuration(activeNow) },
        { label: 'Productive share', value: percent(productiveTotal(now), now.active + now.productiveOffline) },
        { label: 'Days worked', value: String(now.personDays) },
      ]} />
      <Card title="Compared with the previous period">
        {before.personDays === 0 ? (
          <Text style={styles.hint}>No activity in the previous {daysBetween(from, to) + 1} days to compare with.</Text>
        ) : (
          <>
            <Text style={styles.rowText}>Productive time per person-day: {formatDuration(prodNow)}{change(prodNow, prodBefore)}</Text>
            <Text style={styles.rowText}>Active time per person-day: {formatDuration(activeNow)}{change(activeNow, activeBefore)}</Text>
            <Text style={styles.rowText}>
              Productive share: {percent(productiveTotal(now), now.active + now.productiveOffline)} (previously {percent(productiveTotal(before), before.active + before.productiveOffline)})
            </Text>
          </>
        )}
        <Text style={styles.hint}>
          A person-day is one person working on one day, so the figures stay comparable when people join, leave or take leave.
          A day counts when there was computer activity or productive time away. Productive time adds computer time in
          productive apps and websites to time away from the computer in the reasons counted as productive
          (Monitoring & privacy). The coloured bars below are computer time
          {now.offline > 0 ? `, and ${formatDuration(now.offline)} away from the computer was explained in this period` : ''}.
        </Text>
      </Card>
      <Card title={granularity === 'day' ? 'By day' : granularity === 'week' ? 'By week' : 'By month'}>
        {shown.length === 0 ? <Empty text="No activity in this period." /> : null}
        {shown.map((p) => {
          const neutral = Math.max(0, p.active_seconds - p.productive_seconds - p.unproductive_seconds);
          return (
            <View key={p.period_start} style={{ gap: 4, paddingVertical: 4 }}>
              <View style={[styles.row, { justifyContent: 'space-between' }]}>
                <Text style={styles.rowText}>{periodLabel(p.period_start, granularity)}</Text>
                <Text style={styles.hint}>
                  {formatDuration(perDay(p.productive_seconds + p.productive_offline_seconds, p.person_days))} productive per person-day · {p.people}{' '}
                  {p.people === 1 ? 'person' : 'people'}
                </Text>
              </View>
              <StackedBar parts={[
                { value: p.productive_seconds, color: colors.success },
                { value: neutral, color: colors.muted },
                { value: p.unproductive_seconds, color: colors.danger },
              ]} />
            </View>
          );
        })}
        {shown.length > 0 ? (
          <Text style={styles.hint}>Green is productive, grey neutral or uncategorised, red unproductive.</Text>
        ) : null}
      </Card>
    </>
  );
}

// ---- Office days ---------------------------------------------------------------

function Where({ from, to, team }: { from: Ymd; to: Ymd; team: string | null }) {
  const { data, error, loading, refresh } = useAsync(() => api.officeAdherence(from, to, team), [from, to, team]);
  if (error) return <ErrorBanner message={error} onRetry={refresh} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const judged = data.filter((r) => r.target_per_week !== null && r.weeks_judged > 0);
  const met = judged.filter((r) => (r.weeks_met ?? 0) >= r.weeks_judged).length;
  return (
    <>
      <StatGrid items={[
        { label: 'People', value: String(data.length) },
        { label: 'Weeks on target', value: judged.length ? `${met} of ${judged.length}` : '–' },
      ]} />
      <Card title="Where people worked">
        <Text style={styles.hint}>
          Each day is office, remote, or mixed. A mixed day counts as an office day. Only a full Monday-to-Sunday week
          inside this period is compared with the weekly target, and a week with no recorded day is left out, for example
          when someone was on leave. The desktop app stores the result only, not a home address or a home network name.
        </Text>
        {data.length === 0 ? <Empty text="No one to show." /> : null}
        {data.map((r) => <WhereRow key={r.employee_id} row={r} />)}
      </Card>
    </>
  );
}

function WhereRow({ row }: { row: OfficeAdherence }) {
  const target = row.target_per_week === null
    ? 'No weekly target'
    : row.weeks_judged === 0
      ? `Target ${row.target_per_week} a week · no full week to judge`
      : `${row.weeks_met} of ${row.weeks_judged} weeks at the target of ${row.target_per_week}`;
  return (
    <View style={{ paddingVertical: 6 }}>
      <Text style={styles.rowText}>{row.name}{row.team_name ? ` · ${row.team_name}` : ''}</Text>
      <Text style={styles.hint}>
        {row.office_days} office {row.office_days === 1 ? 'day' : 'days'}
        {row.mixed_days > 0 ? ` (${row.mixed_days} mixed)` : ''} · {row.remote_days} remote · {target}
      </Text>
    </View>
  );
}

// ---- AI tools ------------------------------------------------------------------

function AiTools({ from, to, team, orgWide }: { from: Ymd; to: Ymd; team: string | null; orgWide: boolean }) {
  const { data, error, loading, refresh } = useAsync(async () => {
    const [adoption, people, catalog] = await Promise.all([
      api.aiAdoption(from, to, team),
      api.aiPersonUsage(from, to, team),
      orgWide ? api.aiCatalog() : Promise.resolve([] as AiCatalogTool[]),
    ]);
    return { adoption, people, catalog };
  }, [from, to, team, orgWide]);
  const [busy, setBusy] = useState<string | null>(null);

  async function setStatus(tool: AiCatalogTool, status: 'approved' | 'unapproved' | 'unset') {
    setBusy(tool.id);
    try {
      await api.setAiToolApproval(tool.id, status);
      refresh();
    } catch (e) {
      notify('Could not save', errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorBanner message={error} onRetry={refresh} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const using = data.adoption.filter((r) => r.people_using > 0);
  return (
    <>
      <Card title="Who used an AI tool">
        <Text style={styles.hint}>
          A person counts when the tool's website or app was open at least once in this period. Occasional means under
          two days a week; consistent means two or more. The before and after figures compare productive computer time
          in the 28 days before someone's first use with the 28 days from that first use. They appear only when both
          sides have at least five days with computer activity, and they show a correlation, not a cause. Time in the
          tool itself counts toward those productive hours when the tool's category is productive.
        </Text>
        {using.length === 0 ? <Empty text="No AI tool use in this period." /> : null}
        {using.map((row) => (
          <AiToolBlock key={row.tool_id} row={row} people={data.people.filter((p) => p.tool_id === row.tool_id)} />
        ))}
      </Card>
      {orgWide ? (
        <Card title="Approved tools">
          <Text style={styles.hint}>
            Mark a tool approved, not approved, or leave it with no decision. An alert is sent only for a tool marked
            not approved, and only when that alert is switched on under Monitoring & privacy.
          </Text>
          {data.catalog.map((tool) => {
            const status = tool.approved === true ? 'approved' : tool.approved === false ? 'unapproved' : 'unset';
            return (
              <View key={tool.id} style={{ paddingVertical: 6, gap: 4 }}>
                <Text style={styles.rowText}>{tool.name}</Text>
                <Text style={styles.hint}>{[...tool.domains, ...tool.app_names].join(', ') || 'No website or app name'}</Text>
                <Segmented
                  options={[
                    { value: 'approved', label: 'Approved' },
                    { value: 'unapproved', label: 'Not approved' },
                    { value: 'unset', label: 'No decision' },
                  ]}
                  value={status}
                  onChange={(v) => { if (v !== status && !busy) setStatus(tool, v); }}
                />
              </View>
            );
          })}
        </Card>
      ) : null}
    </>
  );
}

function AiToolBlock({ row, people }: { row: AiAdoptionRow; people: AiPersonUsage[] }) {
  const mark = row.approved === true ? 'Approved' : row.approved === false ? 'Not approved' : 'No decision';
  return (
    <View style={{ paddingVertical: 8, gap: 2 }}>
      <Text style={styles.rowText}>{row.tool_name} · {mark}</Text>
      <Text style={styles.hint}>{row.people_using} of {row.people} {row.people === 1 ? 'person' : 'people'}</Text>
      {people.map((p) => (
        <Text key={p.employee_id} style={styles.hint}>
          {p.name}: {p.level === 'consistent' ? 'consistent' : 'occasional'} ({p.days_used} {p.days_used === 1 ? 'day' : 'days'}, {p.days_per_week} a week)
          {p.before_hours !== null && p.after_hours !== null
            ? `. Productive computer time averaged ${p.before_hours} h a day before first use and ${p.after_hours} h after (${p.before_days} and ${p.after_days} days).`
            : ''}
        </Text>
      ))}
    </View>
  );
}

// ---- Workload -----------------------------------------------------------------

const STATUS_LABEL: Record<WorkloadStatus, string> = {
  under: 'Under-utilised', healthy: 'Healthy', over: 'Over-utilised', no_goal: 'No goal', no_data: 'No activity',
};
const STATUS_COLOR: Record<WorkloadStatus, string> = {
  under: colors.warning, healthy: colors.success, over: colors.danger, no_goal: colors.muted, no_data: colors.muted,
};

function Workload({ from, to, team }: { from: Ymd; to: Ymd; team: string | null }) {
  const { data, error, loading, refresh } = useAsync(() => api.workload(from, to, team), [from, to, team]);

  if (error) return <ErrorBanner message={error} onRetry={refresh} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;

  const count = (s: WorkloadStatus) => data.filter((r) => r.status === s).length;
  const scored = data.filter((r) => r.utilisation !== null);
  const max = Math.max(150, ...scored.map((r) => r.utilisation ?? 0));
  const rest = data.filter((r) => r.utilisation === null);

  return (
    <>
      <StatGrid items={[
        { label: 'Under-utilised', value: String(count('under')), color: STATUS_COLOR.under },
        { label: 'Healthy', value: String(count('healthy')), color: STATUS_COLOR.healthy },
        { label: 'Over-utilised', value: String(count('over')), color: STATUS_COLOR.over },
      ]} />
      <Card title="Workload balance">
        <Text style={styles.hint}>
          Productive time per day worked, as a share of each person's daily goal. This is computer time in productive apps
          and websites, plus time away from the computer in the reasons counted as productive. Breaks and unexplained time
          are left out. A day counts when there was computer activity or productive time away.
        </Text>
        {count('no_goal') > 0 ? (
          <Pressable onPress={() => router.push('/goals')}>
            <Text style={{ color: colors.primary, fontWeight: '600' }}>
              {count('no_goal')} {count('no_goal') === 1 ? 'person has' : 'people have'} no goal. Set productivity goals
            </Text>
          </Pressable>
        ) : null}
        {scored.length === 0 ? <Empty text="No one with a goal worked in this period." /> : null}
        {scored.map((r) => <WorkloadBar key={r.employee_id} row={r} max={max} />)}
      </Card>
      {rest.length > 0 ? (
        <Card title="Not scored">
          {rest.map((r) => (
            <View key={r.employee_id} style={[styles.row, { justifyContent: 'space-between', paddingVertical: 2 }]}>
              <Text style={styles.rowText}>{r.name}</Text>
              <Text style={styles.hint}>{STATUS_LABEL[r.status]}</Text>
            </View>
          ))}
        </Card>
      ) : null}
    </>
  );
}

function WorkloadBar({ row, max }: { row: WorkloadRow; max: number }) {
  const perDay = row.days_worked ? row.productive_seconds / row.days_worked : 0;
  return (
    <BarRow
      label={row.name}
      value={row.utilisation ?? 0}
      max={max}
      right={`${Math.round(row.utilisation ?? 0)}%`}
      color={STATUS_COLOR[row.status]}
      sub={`${STATUS_LABEL[row.status]} · ${formatDuration(perDay)} productive per day of a ${row.goal_hours} h goal · ${
        row.days_worked} ${row.days_worked === 1 ? 'day' : 'days'}${
        row.offline_seconds ? ` · ${formatDuration(row.offline_seconds)} away explained` : ''}${
        row.team_name ? ` · ${row.team_name}` : ''}`}
    />
  );
}

// ---- Capacity -----------------------------------------------------------------

function Capacity({ from, to, orgWide, teams }: {
  from: Ymd; to: Ymd; orgWide: boolean; teams: { id: string; name: string }[];
}) {
  const { data, error, loading, refresh, reload } = useAsync(async () => {
    const [rows, costs] = await Promise.all([api.capacity(from, to), orgWide ? api.workforceCosts() : Promise.resolve([])]);
    return { rows, costs };
  }, [from, to, orgWide]);

  if (error) return <ErrorBanner message={error} onRetry={refresh} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;

  const scored = data.rows.filter((r) => r.fte_gap !== null);
  const spare = scored.reduce((a, r) => a + Math.max(0, r.fte_gap ?? 0), 0);
  const overload = scored.reduce((a, r) => a + Math.max(0, -(r.fte_gap ?? 0)), 0);
  const monthlyIdle = scored.reduce((a, r) => a + Math.max(0, r.monthly_cost ?? 0), 0);
  const hasCosts = scored.some((r) => r.monthly_cost !== null);

  return (
    <>
      <StatGrid items={[
        { label: 'Spare capacity (FTE)', value: spare.toFixed(1), color: colors.warning },
        { label: 'Over capacity (FTE)', value: overload.toFixed(1), color: colors.danger },
        ...(hasCosts ? [{ label: 'Spare capacity cost / month', value: rand(monthlyIdle) }] : []),
      ]} />
      <Card title="Capacity by team">
        <Text style={styles.hint}>
          An estimate from productive time against each team's daily goal. One FTE is one full-time person working to the
          goal. Spare capacity means people averaged less productive time than the goal; over capacity means more.
          Productive time includes the reasons counted as productive for time away from the computer. Unexplained time
          away is left out, so treat the result as a starting point for a conversation.
        </Text>
        {data.rows.length === 0 ? <Empty text="No activity in this period." /> : null}
        {data.rows.map((r) => <CapacityLine key={r.team_id ?? 'none'} row={r} />)}
      </Card>
      {orgWide ? (
        <Card title="Average salaries">
          <Text style={styles.hint}>
            Optional. With an average annual salary (cost to company) the capacity gap is also shown in rand. A team's
            figure replaces the company figure for that team. Only owners and managers who see the whole company can see
            or change salaries.
          </Text>
          <SalaryRow team={null} label="Company average" value={data.costs.find((c) => c.team_id === null)?.annual_salary}
            onSaved={reload} />
          {teams.map((t) => (
            <SalaryRow key={t.id} team={t.id} label={t.name} value={data.costs.find((c) => c.team_id === t.id)?.annual_salary}
              onSaved={reload} />
          ))}
        </Card>
      ) : null}
    </>
  );
}

function CapacityLine({ row }: { row: CapacityRow }) {
  const name = row.team_name ?? 'No team';
  if (row.goal_hours === null || row.fte_gap === null || row.gap_hours === null) {
    return (
      <View style={{ paddingVertical: 4 }}>
        <Text style={[styles.rowText, { fontWeight: '600' }]}>{name}</Text>
        <Text style={styles.hint}>No productivity goal, so capacity can't be estimated.</Text>
      </View>
    );
  }
  const fte = Math.abs(row.fte_gap).toFixed(2);
  const verdict = row.fte_gap > 0 ? `About ${fte} FTE of spare capacity`
    : row.fte_gap < 0 ? `About ${fte} FTE over capacity` : 'Exactly at the goal';
  return (
    <View style={{ paddingVertical: 4, gap: 2 }}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Text style={[styles.rowText, { fontWeight: '600' }]}>{name}</Text>
        <Text style={{ color: row.fte_gap > 0 ? colors.warning : row.fte_gap < 0 ? colors.danger : colors.success, fontWeight: '600' }}>
          {verdict}
        </Text>
      </View>
      <Text style={styles.hint}>
        {row.people} {row.people === 1 ? 'person' : 'people'} · {formatDuration(row.avg_productive_hours * 3600)} productive per
        day worked against a {row.goal_hours} h goal
      </Text>
      {row.monthly_cost !== null && row.annual_cost !== null && row.fte_gap > 0 ? (
        <Text style={styles.hint}>
          Unused capacity worth about {rand(row.monthly_cost)} a month ({rand(row.annual_cost)} a year).
        </Text>
      ) : null}
      {row.monthly_cost !== null && row.fte_gap < 0 ? (
        <Text style={styles.hint}>
          Covering the extra work with new staff would cost about {rand(-row.monthly_cost)} a month.
        </Text>
      ) : null}
    </View>
  );
}

function SalaryRow({ team, label, value, onSaved }: {
  team: string | null; label: string; value: number | undefined; onSaved: () => void;
}) {
  const [text, setText] = useState(value ? String(value) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const cleaned = text.replace(/[\s,R]/g, '');
    const amount = cleaned === '' ? null : Number(cleaned);
    if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) return setError('Enter an amount above zero, or leave it empty.');
    setBusy(true);
    try {
      await api.setWorkforceCost(team, amount);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 6, paddingVertical: 4 }}>
      {error ? <ErrorBanner message={error} /> : null}
      <View style={[styles.row, { gap: 8, alignItems: 'flex-end' }]}>
        <View style={{ flex: 1 }}>
          <Field label={`${label} (annual, rand)`} value={text} onChangeText={setText} keyboardType="number-pad"
            placeholder={team ? 'Uses the company average' : 'Not set'} />
        </View>
        <Button small title="Save" onPress={save} loading={busy} />
      </View>
    </View>
  );
}

// ---- Software -----------------------------------------------------------------

const CATEGORY_COLOR: Record<SoftwareUsage['category'], string> = {
  productive: colors.success, neutral: colors.primary, unproductive: colors.danger, uncategorised: colors.muted,
};

function Software({ from, to, team, orgWide }: { from: Ymd; to: Ymd; team: string | null; orgWide: boolean }) {
  const [kind, setKind] = useState<'app' | 'domain'>('app');
  const [editing, setEditing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, error, loading, refresh, reload } = useAsync(
    () => api.softwareUsage(from, to, kind, team), [from, to, kind, team]);

  async function removeLicence(row: SoftwareUsage) {
    if (!row.licence_id || !(await confirmAction(`Remove the licence count for ${row.name}?`, undefined, 'Remove'))) return;
    setActionError(null);
    try {
      await api.deleteLicence(row.licence_id);
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  // Licences are bought for the whole company, so seats are only compared with company-wide usage.
  const licences = orgWide && team === null;
  const licensed = licences ? (data ?? []).filter((r) => r.licence_seats !== null) : [];
  const spend = licensed.reduce((a, r) => a + (r.licence_seats ?? 0) * (r.monthly_cost_per_seat ?? 0), 0);
  const unusedSpend = licensed.reduce(
    (a, r) => a + Math.max(0, (r.licence_seats ?? 0) - r.users) * (r.monthly_cost_per_seat ?? 0), 0);
  const unusedSeats = licensed.reduce((a, r) => a + Math.max(0, (r.licence_seats ?? 0) - r.users), 0);
  const max = Math.max(1, ...(data ?? []).map((r) => r.active_seconds));
  const noun = kind === 'app' ? 'app' : 'website';

  return (
    <>
      <Card title="Software usage">
        <Segmented value={kind} onChange={(v) => { setKind(v); setEditing(null); }} options={[
          { value: 'app', label: 'Apps' }, { value: 'domain', label: 'Websites' },
        ]} />
        <Text style={styles.hint}>
          Active time and how many people used each {noun} in the period.
          {licences
            ? ` Enter the licences you pay for to see unused seats. A licence counts as used by anyone who used the ${noun} at least once in the period.`
            : orgWide ? ' Choose All teams to see and manage licences.' : ''}
        </Text>
      </Card>
      {licensed.length > 0 ? (
        <StatGrid items={[
          { label: 'Unused licences', value: String(unusedSeats), color: unusedSeats ? colors.warning : undefined },
          ...(spend > 0 ? [
            { label: 'Licence spend / month', value: rand(spend) },
            { label: 'Unused spend / month', value: rand(unusedSpend), color: unusedSpend ? colors.warning : undefined },
          ] : []),
        ]} />
      ) : null}
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {actionError ? <ErrorBanner message={actionError} /> : null}
      {loading && !data ? <Loading /> : null}
      {data ? (
        <Card title={kind === 'app' ? 'Apps' : 'Websites'}>
          {data.length === 0 ? <Empty text={`No ${noun}s used in this period.`} /> : null}
          {data.map((r) => {
            const key = `${kind}:${r.name.toLowerCase()}`;
            const seats = licences ? r.licence_seats : null;
            const licence = seats === null ? '' : ` · ${r.users} of ${seats} licences used${
              r.monthly_cost_per_seat ? ` · ${rand(r.monthly_cost_per_seat)} per seat a month` : ''}`;
            return (
              <View key={key} style={{ paddingVertical: 2 }}>
                <BarRow label={r.name} value={r.active_seconds} max={max} right={formatDuration(r.active_seconds)}
                  color={CATEGORY_COLOR[r.category]}
                  sub={`${r.users} of ${r.people} people (${percent(r.users, r.people)})${licence}`} />
                {licences ? (
                  <View style={[styles.row, { gap: 14 }]}>
                    <Pressable hitSlop={8} onPress={() => setEditing(editing === key ? null : key)}>
                      <Text style={{ color: colors.primary, fontWeight: '600' }}>
                        {editing === key ? 'Close' : seats === null ? 'Add licences' : 'Change licences'}
                      </Text>
                    </Pressable>
                    {seats !== null ? (
                      <Pressable hitSlop={8} onPress={() => removeLicence(r)}>
                        <Text style={{ color: colors.danger, fontWeight: '600' }}>Remove</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
                {editing === key ? (
                  <LicenceEditor kind={kind} name={r.name} seats={seats} cost={r.monthly_cost_per_seat}
                    onSaved={() => { setEditing(null); reload(); }} />
                ) : null}
              </View>
            );
          })}
          {data.length >= 300 ? <Text style={styles.hint}>Showing the 300 most used.</Text> : null}
        </Card>
      ) : null}
      {licences ? (
        <Card title={`Licences for an ${noun} nobody used yet`}>
          <LicenceEditor kind={kind} name={null} seats={null} cost={null} onSaved={reload} />
        </Card>
      ) : null}
    </>
  );
}

function LicenceEditor({ kind, name, seats, cost, onSaved }: {
  kind: 'app' | 'domain'; name: string | null; seats: number | null; cost: number | null; onSaved: () => void;
}) {
  const [title, setTitle] = useState(name ?? '');
  const [seatText, setSeatText] = useState(seats ? String(seats) : '');
  const [costText, setCostText] = useState(cost !== null ? String(cost) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const n = Number(seatText);
    const c = costText.trim() === '' ? null : Number(costText.replace(/[\s,R]/g, ''));
    if (!title.trim()) return setError(kind === 'app' ? 'Enter the app name as it appears in reports.' : 'Enter the website, like zoom.us.');
    if (!Number.isInteger(n) || n < 1) return setError('Enter the number of licences (a whole number).');
    if (c !== null && (!Number.isFinite(c) || c < 0)) return setError('Enter the monthly cost per licence, or leave it empty.');
    setBusy(true);
    try {
      await api.setLicence(kind, title.trim(), n, c);
      if (!name) { setTitle(''); setSeatText(''); setCostText(''); }
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8, paddingTop: 4 }}>
      {error ? <ErrorBanner message={error} /> : null}
      {name === null ? (
        <Field label={kind === 'app' ? 'App name' : 'Website'} value={title} onChangeText={setTitle}
          placeholder={kind === 'app' ? 'Adobe Photoshop' : 'zoom.us'} autoCapitalize="none" />
      ) : null}
      <View style={[styles.row, { gap: 8 }]}>
        <View style={{ flex: 1 }}>
          <Field label="Licences" value={seatText} onChangeText={setSeatText} keyboardType="number-pad" />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Cost per licence a month (R)" value={costText} onChangeText={setCostText} keyboardType="decimal-pad"
            placeholder="Optional" />
        </View>
      </View>
      <Button small title="Save licences" onPress={save} loading={busy} />
    </View>
  );
}
