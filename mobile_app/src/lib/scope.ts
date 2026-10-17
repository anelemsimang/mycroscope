import type { Team, TeamManager } from './api';
import type { Profile } from './session';

/**
 * Teams the signed-in manager may change, mirroring can_manage_team in the database.
 * orgWide: a manager not limited to particular teams. The account that created the organisation is included.
 */
export function manageableTeams(teams: Team[], managers: TeamManager[], profile: Profile) {
  const mine = managers.filter((m) => m.employee_id === profile.employeeId).map((m) => m.team_id);
  const orgWide = profile.role === 'owner' || mine.length === 0;
  return { orgWide, teams: orgWide ? teams : teams.filter((t) => mine.includes(t.id)) };
}
