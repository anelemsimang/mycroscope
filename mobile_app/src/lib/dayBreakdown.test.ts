import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assembleDayBreakdown, groupDayBreakdown, type DayBreakdownRow } from './dayBreakdown.ts';

const website = '11111111-1111-1111-1111-111111111111';

test('a day groups named projects and work with no project, without double counting websites', () => {
  const rows: DayBreakdownRow[] = [
    { project_id: null, project_name: 'No project', kind: 'app', label: 'Outlook', active_seconds: 600, idle_seconds: 60, sample_title: null },
    { project_id: website, project_name: 'Website', kind: 'app', label: 'Chrome', active_seconds: 3600, idle_seconds: 120, sample_title: null },
    { project_id: website, project_name: 'Website', kind: 'web', label: 'github.com', active_seconds: 2000, idle_seconds: 0, sample_title: 'Pull request' },
    { project_id: website, project_name: 'Website', kind: 'app', label: 'Code', active_seconds: 1800, idle_seconds: 0, sample_title: null },
    { project_id: null, project_name: 'No project', kind: 'web', label: 'mail.example', active_seconds: 400, idle_seconds: 0, sample_title: 'Inbox' },
  ];
  const groups = groupDayBreakdown(rows);
  assert.deepEqual(groups.map((g) => [g.name, g.active, g.apps.map((a) => a.label), g.websites.map((w) => w.label)]), [
    ['Website', 5400, ['Chrome', 'Code'], ['github.com']],
    ['No project', 600, ['Outlook'], ['mail.example']],
  ]);
});

test('work with no project is the remainder after named projects', () => {
  const rows = assembleDayBreakdown({
    unassignedName: 'No project',
    allApps: [
      { label: 'Chrome', active_seconds: 3600, idle_seconds: 120 },
      { label: 'Outlook', active_seconds: 600, idle_seconds: 0 },
    ],
    allDomains: [
      { label: 'github.com', active_seconds: 2000, idle_seconds: 0, sample_title: 'Pull request' },
      { label: 'mail.example', active_seconds: 400, idle_seconds: 0, sample_title: 'Inbox' },
    ],
    named: [{
      project_id: website,
      project_name: 'Website',
      apps: [{ label: 'Chrome', active_seconds: 2000, idle_seconds: 120 }],
      domains: [{ label: 'github.com', active_seconds: 2000, idle_seconds: 0, sample_title: 'Pull request' }],
    }],
  });
  const groups = groupDayBreakdown(rows);
  assert.deepEqual(groups.map((g) => [g.name, g.active, g.apps.map((a) => [a.label, a.active]), g.websites.map((w) => w.label)]), [
    ['No project', 2200, [['Chrome', 1600], ['Outlook', 600]], ['mail.example']],
    ['Website', 2000, [['Chrome', 2000]], ['github.com']],
  ]);
});
