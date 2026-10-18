import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ALL_PROJECTS, NO_PROJECT, projectChoices, projectChoicesForDay, projectQuery, projectScopeName, projectScopePhrase } from './projects.ts';

const projects = [
  { id: '11111111-1111-1111-1111-111111111111', name: 'Website', is_active: true },
  { id: '22222222-2222-2222-2222-222222222222', name: 'Old app', is_active: false },
];

test('no project is a separate filter from all projects and from a named project', () => {
  assert.deepEqual(projectQuery(null), {});
  assert.deepEqual(projectQuery(ALL_PROJECTS), {});
  assert.deepEqual(projectQuery(NO_PROJECT), { p_unassigned: true });
  assert.deepEqual(projectQuery(projects[0].id), { p_project: projects[0].id });
});

test('no project is listed after all projects and before named projects', () => {
  assert.deepEqual(projectChoices(projects).map((p) => p.label), [
    'All projects', 'No project', 'Website', 'Old app (archived)',
  ]);
});

test('the same project name for two people stays two separate choices', () => {
  const choices = projectChoices([
    { id: 'a', name: 'PRJ1', is_active: true, owner: 'Anele' },
    { id: 'b', name: 'PRJ1', is_active: true, owner: 'Andril' },
  ]);
  assert.deepEqual(choices.map((p) => p.label), ['All projects', 'No project', 'PRJ1 · Anele', 'PRJ1 · Andril']);
});

test('a chosen day keeps only the projects that have time that day', () => {
  const choices = projectChoicesForDay(projects, [
    { project_id: projects[0].id },
    { project_id: null },
  ]);
  assert.deepEqual(choices.map((p) => p.label), ['All projects', 'No project', 'Website']);
});

test('scope labels', () => {
  assert.equal(projectScopeName(ALL_PROJECTS, projects), null);
  assert.equal(projectScopeName(NO_PROJECT, projects), 'No project');
  assert.equal(projectScopeName(projects[0].id, projects), 'Website');
  assert.equal(projectScopePhrase(NO_PROJECT), 'no project');
  assert.equal(projectScopePhrase(projects[0].id, projects), 'project Website');
  assert.equal(projectScopePhrase(ALL_PROJECTS), '');
});
