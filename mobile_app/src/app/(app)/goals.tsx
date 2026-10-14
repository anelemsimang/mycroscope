import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Button, Card, Empty, ErrorBanner, Field, Loading, Screen, colors, styles } from '@/components/ui';
import { api, errorMessage, type Goal } from '@/lib/api';
import { confirmAction } from '@/lib/dialog';
import { manageableTeams } from '@/lib/scope';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

const DEFAULTS = { productive_hours: 6, under_percent: 80, over_percent: 120 };

function describe(g: Pick<Goal, 'productive_hours' | 'under_percent' | 'over_percent'>) {
  return `${g.productive_hours} productive h/day · under ${g.under_percent}% · over ${g.over_percent}%`;
}

export default function Goals() {
  const profile = useProfile();
  const { data, error, loading, refresh, reload } = useAsync(async () => {
    const [goals, { teams, managers }, features] = await Promise.all([api.goals(), api.teams(), api.features()]);
    return { goals, scope: manageableTeams(teams, managers, profile), allowed: features.includes('goals') };
  }, [profile.employeeId]);
  const [editing, setEditing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (!data) return <Screen><ErrorBanner message={error ?? 'Could not load goals.'} onRetry={refresh} /></Screen>;

  const company = data.goals.find((g) => g.team_id === null) ?? null;
  const byTeam = new Map(data.goals.filter((g) => g.team_id).map((g) => [g.team_id!, g]));

  async function remove(team: string | null, label: string) {
    if (!(await confirmAction(`Remove the goal for ${label}?`, undefined, 'Remove'))) return;
    setActionError(null);
    try {
      await api.deleteGoal(team);
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  const row = (key: string, team: string | null, label: string, goal: Goal | null, fallback: string, canEdit: boolean) => (
    <View key={key} style={{ paddingVertical: 6, gap: 4 }}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.rowText, { fontWeight: '600' }]}>{label}</Text>
          <Text style={styles.hint}>{goal ? describe(goal) : fallback}</Text>
        </View>
        {canEdit ? (
          <Pressable hitSlop={8} onPress={() => setEditing(editing === key ? null : key)}>
            <Text style={{ color: colors.primary, fontWeight: '600' }}>{editing === key ? 'Close' : goal ? 'Change' : 'Set goal'}</Text>
          </Pressable>
        ) : null}
        {canEdit && goal ? (
          <Pressable hitSlop={8} style={{ marginLeft: 14 }} onPress={() => remove(team, label)}>
            <Text style={{ color: colors.danger, fontWeight: '600' }}>Remove</Text>
          </Pressable>
        ) : null}
      </View>
      {editing === key ? (
        <GoalEditor team={team} initial={goal ?? company ?? DEFAULTS} onSaved={() => { setEditing(null); reload(); }} />
      ) : null}
    </View>
  );

  return (
    <Screen>
      <Card title="Productivity goals">
        <Text style={styles.hint}>
          A goal is the productive time you expect per person per working day, counted from apps and websites marked
          productive. People below the under-utilised share of the goal may have spare capacity; people above the
          over-utilised share may be overloaded. A team's goal replaces the company goal for that team. Goals are only
          visible to owners and managers.
        </Text>
        {!data.allowed ? (
          <Text style={[styles.hint, { color: colors.danger }]}>
            Productivity goals are not included in your plan. Contact Mycroscope to upgrade.
          </Text>
        ) : null}
      </Card>
      {actionError ? <ErrorBanner message={actionError} /> : null}
      {data.allowed ? (
        <>
          <Card title="Company goal">
            {row('company', null, 'Everyone', company, 'No company goal yet', data.scope.orgWide)}
          </Card>
          <Card title="Team goals">
            {data.scope.teams.length === 0 ? <Empty text="No teams yet." /> : null}
            {data.scope.teams.map((t) =>
              row(`team:${t.id}`, t.id, t.name, byTeam.get(t.id) ?? null,
                company ? 'Uses the company goal' : 'No goal', true))}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

function GoalEditor({ team, initial, onSaved }: {
  team: string | null; initial: Pick<Goal, 'productive_hours' | 'under_percent' | 'over_percent'>; onSaved: () => void;
}) {
  const [hours, setHours] = useState(String(initial.productive_hours));
  const [under, setUnder] = useState(String(initial.under_percent));
  const [over, setOver] = useState(String(initial.over_percent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const h = Number(hours.replace(',', '.'));
    const u = Number(under);
    const o = Number(over);
    if (!Number.isFinite(h) || h < 0.5 || h > 16) return setError('The daily goal must be between 0.5 and 16 hours.');
    if (!Number.isInteger(u) || u < 10 || u > 99) return setError('Under-utilised must be a whole percentage from 10 to 99.');
    if (!Number.isInteger(o) || o < 101 || o > 300) return setError('Over-utilised must be a whole percentage from 101 to 300.');
    setBusy(true);
    try {
      await api.saveGoal(team, h, u, o);
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
      <Field label="Productive hours per person per day" value={hours} onChangeText={setHours} keyboardType="decimal-pad"
        hint="For example 6, or 5.5." />
      <View style={[styles.row, { gap: 8 }]}>
        <View style={{ flex: 1 }}>
          <Field label="Under-utilised below (%)" value={under} onChangeText={setUnder} keyboardType="number-pad" />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Over-utilised above (%)" value={over} onChangeText={setOver} keyboardType="number-pad" />
        </View>
      </View>
      <Button small title="Save goal" onPress={save} loading={busy} />
    </View>
  );
}
