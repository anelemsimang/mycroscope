import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Button, Card, Empty, ErrorBanner, Field, Loading, Screen, Segmented, colors, styles } from '@/components/ui';
import { api, errorMessage, type Policy, type WorkSchedule } from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { manageableTeams } from '@/lib/scope';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = (t: string) => (t ?? '').slice(0, 5);

type Hours = { work_days: number[]; work_start: string; work_end: string };
type Target = { team?: string; employee?: string };

function describe(h: Hours) {
  const days = [...h.work_days].sort().map((d) => DAYS[d - 1]).join(', ');
  return `${days} · ${hhmm(h.work_start)}–${hhmm(h.work_end)}`;
}

export default function WorkHours() {
  const profile = useProfile();
  const { data, error, loading, refresh, reload } = useAsync(async () => {
    const [settings, schedules, { teams, managers }, people, features] = await Promise.all([
      api.complianceSettings(profile.organizationId), api.workSchedules(), api.teams(), api.employees(), api.features(),
    ]);
    return {
      settings, schedules, teams, people: people.filter((p) => p.is_active),
      scope: manageableTeams(teams, managers, profile),
      allowed: features.includes('schedule_adherence') && features.includes('time_tracking'),
    };
  }, [profile.organizationId]);
  const [editing, setEditing] = useState<string | null>(null);
  const [person, setPerson] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (!data) return <Screen><ErrorBanner message={error ?? 'Could not load working hours.'} onRetry={refresh} /></Screen>;

  const company: Hours = data.settings;
  const inForce = data.settings.tracking_schedule === 'work_hours';
  const byTeam = new Map(data.schedules.filter((s) => s.team_id).map((s) => [s.team_id!, s]));
  const individual = data.schedules.filter((s) => s.employee_id);
  const nameOf = (id: string | null) => data.people.find((p) => p.id === id)?.name ?? 'Former employee';
  const withoutOwn = data.people.filter((p) => !individual.some((s) => s.employee_id === p.id));

  function saved(policy: Policy | null, previous: number | undefined) {
    setEditing(null);
    setPerson(null);
    reload();
    if (policy && policy.version !== previous) {
      notify('Saved', `Monitoring notice version ${policy.version} published. Employees must acknowledge it.`);
    }
  }

  async function remove(target: Target, label: string) {
    if (!(await confirmAction(`Remove hours for ${label}?`,
      target.team ? 'The company hours will apply to this team again.' : "The team's or company's hours will apply again.",
      'Remove'))) return;
    try {
      const before = (await api.policies())[0]?.version;
      saved(await api.deleteWorkSchedule(target), before);
    } catch (e) {
      notify('Could not remove', errorMessage(e));
    }
  }

  return (
    <Screen>
      <Card title="Working hours">
        <Text style={styles.hint}>
          {data.allowed
            ? 'Teams and individual people can have their own working hours, for example a dispatch team that starts at 06:00 or a part-time employee. A person\'s own hours come first, then their team\'s, then the company\'s. The hours are listed in the monitoring notice, so changing them publishes a new notice version.'
            : 'These hours apply to everyone. They are listed in the monitoring notice, so changing them publishes a new notice version.'}
        </Text>
        {!inForce ? (
          <Text style={[styles.hint, { color: colors.danger }]}>
            Monitoring currently runs whenever people are signed in, so these hours are not in force. Choose "Working hours
            only" under Monitoring & privacy to use them.
          </Text>
        ) : null}
      </Card>

      <Card title="Company hours">
        <Text style={styles.rowText}>{describe(company)}</Text>
        <Button small variant="ghost" title="Change under Monitoring & privacy" onPress={() => router.push('/monitoring')} />
      </Card>

      {data.allowed ? (
        <>
          <Card title="Teams">
            {data.scope.teams.length === 0 ? <Empty text="No teams yet. The manager who created the organisation creates teams under Settings → Teams." /> : null}
            {data.scope.teams.map((t) => {
              const own = byTeam.get(t.id);
              const key = `team:${t.id}`;
              return (
                <View key={t.id} style={{ paddingVertical: 6, gap: 4 }}>
                  <View style={[styles.row, { justifyContent: 'space-between' }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.rowText, { fontWeight: '600' }]}>{t.name}</Text>
                      <Text style={styles.hint}>{own ? describe(own) : 'Uses the company hours'}</Text>
                    </View>
                    <Pressable hitSlop={8} onPress={() => setEditing(editing === key ? null : key)}>
                      <Text style={{ color: colors.primary, fontWeight: '600' }}>{editing === key ? 'Close' : own ? 'Change' : 'Set hours'}</Text>
                    </Pressable>
                    {own ? (
                      <Pressable hitSlop={8} style={{ marginLeft: 14 }} onPress={() => remove({ team: t.id }, t.name)}>
                        <Text style={{ color: colors.danger, fontWeight: '600' }}>Remove</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {editing === key ? <HoursEditor initial={own ?? company} target={{ team: t.id }} onSaved={saved} /> : null}
                </View>
              );
            })}
          </Card>

          <Card title="Individual hours">
            {individual.length === 0 ? <Empty text="Nobody has individual hours." /> : null}
            {individual.map((s: WorkSchedule) => {
              const key = `emp:${s.employee_id}`;
              return (
                <View key={s.id} style={{ paddingVertical: 6, gap: 4 }}>
                  <View style={[styles.row, { justifyContent: 'space-between' }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.rowText, { fontWeight: '600' }]}>{nameOf(s.employee_id)}</Text>
                      <Text style={styles.hint}>{describe(s)}</Text>
                    </View>
                    <Pressable hitSlop={8} onPress={() => setEditing(editing === key ? null : key)}>
                      <Text style={{ color: colors.primary, fontWeight: '600' }}>{editing === key ? 'Close' : 'Change'}</Text>
                    </Pressable>
                    <Pressable hitSlop={8} style={{ marginLeft: 14 }}
                      onPress={() => remove({ employee: s.employee_id! }, nameOf(s.employee_id))}>
                      <Text style={{ color: colors.danger, fontWeight: '600' }}>Remove</Text>
                    </Pressable>
                  </View>
                  {editing === key ? <HoursEditor initial={s} target={{ employee: s.employee_id! }} onSaved={saved} /> : null}
                </View>
              );
            })}
            {withoutOwn.length > 0 ? (
              <>
                <Text style={[styles.label, { marginTop: 8 }]}>Give someone individual hours</Text>
                <Segmented options={withoutOwn.map((p) => ({ value: p.id, label: p.name }))} value={person ?? ''}
                  onChange={(v) => setPerson(v)} />
                {person ? <HoursEditor initial={company} target={{ employee: person }} onSaved={saved} /> : null}
              </>
            ) : null}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

function HoursEditor({ initial, target, onSaved }: {
  initial: Hours; target: Target; onSaved: (policy: Policy | null, previous: number | undefined) => void;
}) {
  const [days, setDays] = useState<number[]>(initial.work_days);
  const [start, setStart] = useState(hhmm(initial.work_start));
  const [end, setEnd] = useState(hhmm(initial.work_end));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    if (days.length === 0) return setError('Choose at least one working day.');
    if (!TIME.test(start) || !TIME.test(end)) return setError('Enter working hours as HH:MM, e.g. 08:00.');
    if (start === end) return setError('Working hours must start and end at different times.');
    if (!(await confirmAction('Save working hours?',
      'If monitoring is limited to working hours, employees will see an updated monitoring notice and must acknowledge it.',
      'Save'))) return;
    setBusy(true);
    try {
      const before = (await api.policies())[0]?.version;
      onSaved(await api.saveWorkSchedule(target, days, start, end), before);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8, paddingTop: 4 }}>
      {error ? <ErrorBanner message={error} /> : null}
      <View style={styles.segmented}>
        {DAYS.map((d, i) => {
          const iso = i + 1;
          const on = days.includes(iso);
          return (
            <Pressable key={d} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
              onPress={() => setDays(on ? days.filter((x) => x !== iso) : [...days, iso].sort())}
              style={[styles.segment, on && styles.segmentActive]}>
              <Text style={[styles.segmentText, on && { color: '#fff' }]}>{d}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={[styles.row, { gap: 8 }]}>
        <View style={{ flex: 1 }}><Field label="From" value={start} onChangeText={(v) => setStart(v.trim())} placeholder="08:00" maxLength={5} /></View>
        <View style={{ flex: 1 }}><Field label="To" value={end} onChangeText={(v) => setEnd(v.trim())} placeholder="17:00" maxLength={5} /></View>
      </View>
      <Text style={styles.hint}>An end before the start means a night shift (e.g. 22:00 to 06:00).</Text>
      <Button small title="Save hours" onPress={save} loading={busy} />
    </View>
  );
}
