import { useState } from 'react';
import { Text, View } from 'react-native';

import { Button, Card, Empty, ErrorBanner, Field, Loading, Screen, ToggleRow, styles } from '@/components/ui';
import { api, errorMessage, type Team, type TeamRow } from '@/lib/api';
import { confirmAction, notify } from '@/lib/dialog';
import { useProfile } from '@/lib/session';
import { useAsync } from '@/lib/useAsync';

export default function Teams() {
  const profile = useProfile();
  const { data, error, loading, refresh, reload } = useAsync(async () => {
    const [{ teams, managers }, people] = await Promise.all([api.teams(), api.teamOverview()]);
    return { teams, managers, people: people.filter((p) => p.is_active) };
  }, []);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (profile.role !== 'owner') return <Screen><Card><Text style={styles.hint}>Only the owner can manage teams.</Text></Card></Screen>;
  if (loading && !data) return <Loading />;

  async function run(fn: () => Promise<unknown>) {
    setFormError(null);
    setBusy(true);
    try {
      await fn();
      reload();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Card title="Teams">
        <Text style={styles.hint}>
          A manager assigned to one or more teams sees only the people in those teams. Managers without a team see
          everyone. The owner always sees everyone. People can belong to one team.
        </Text>
        {formError ? <ErrorBanner message={formError} /> : null}
        <Field label="New team" value={name} onChangeText={setName} placeholder="e.g. Dispatch" />
        <Button title="Create team" loading={busy} disabled={!name.trim()}
          onPress={() => run(async () => { await api.saveTeam(null, name.trim()); setName(''); })} />
      </Card>
      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}
      {data && data.teams.length === 0 ? <Card><Empty text="No teams yet." /></Card> : null}
      {data?.teams.map((t) => (
        <TeamCard key={t.id} team={t} people={data.people}
          managerIds={data.managers.filter((m) => m.team_id === t.id).map((m) => m.employee_id)}
          busy={busy} run={run} />
      ))}
    </Screen>
  );
}

function TeamCard({ team, people, managerIds, busy, run }: {
  team: Team; people: TeamRow[]; managerIds: string[]; busy: boolean; run: (fn: () => Promise<unknown>) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const managers = people.filter((p) => p.role === 'manager');
  const members = people.filter((p) => p.role !== 'owner');

  async function remove() {
    if (await confirmAction(`Delete ${team.name}?`, 'Its people stay, without a team. Its managers go back to seeing everyone.', 'Delete')) {
      run(() => api.deleteTeam(team.id));
    }
  }

  return (
    <Card title={team.name} right={<Text style={{ color: '#dc2626', fontWeight: '600' }} onPress={remove}>Delete</Text>}>
      {renaming !== null ? (
        <View style={{ gap: 6 }}>
          <Field label="Team name" value={renaming} onChangeText={setRenaming} />
          <View style={[styles.row, { gap: 8 }]}>
            <View style={{ flex: 1 }}>
              <Button small title="Save" disabled={!renaming.trim()} loading={busy}
                onPress={() => run(async () => { await api.saveTeam(team.id, renaming.trim()); setRenaming(null); })} />
            </View>
            <View style={{ flex: 1 }}><Button small variant="ghost" title="Cancel" onPress={() => setRenaming(null)} /></View>
          </View>
        </View>
      ) : <Button small variant="ghost" title="Rename" onPress={() => setRenaming(team.name)} />}

      <Text style={styles.label}>Managers of this team</Text>
      {managers.length === 0 ? <Text style={styles.hint}>No one has the Manager role yet (set it under Manage employee).</Text> : null}
      {managers.map((m) => (
        <ToggleRow key={m.employee_id} label={m.name} value={managerIds.includes(m.employee_id)} disabled={busy}
          onChange={(on) => run(() => api.setTeamManagers(team.id,
            on ? [...managerIds, m.employee_id] : managerIds.filter((x) => x !== m.employee_id)))} />
      ))}

      <Text style={[styles.label, { marginTop: 8 }]}>People in this team</Text>
      {members.map((p) => (
        <ToggleRow key={p.employee_id} label={p.name} disabled={busy}
          hint={p.team_id && p.team_id !== team.id ? `Currently in ${p.team_name}` : undefined}
          value={p.team_id === team.id}
          onChange={(on) => {
            if (on && p.team_id && p.team_id !== team.id) notify('Moved', `${p.name} moved from ${p.team_name} to ${team.name}.`);
            run(() => api.setEmployeeTeam(p.employee_id, on ? team.id : null));
          }} />
      ))}
    </Card>
  );
}
