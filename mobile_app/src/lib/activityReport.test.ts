import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activityRecommendations, buildActivityReport, type ActivityReportInput } from './activityReport.ts';

function input(over: Partial<ActivityReportInput> = {}): ActivityReportInput {
  return {
    organization: 'Northwind',
    timezone: 'Africa/Johannesburg',
    scopeName: 'Ada Lovelace',
    periodLabel: 'This week',
    from: '2026-10-05',
    to: '2026-10-07',
    projectLabel: null,
    generatedBy: 'Manager',
    people: [{
      name: 'Ada Lovelace',
      days: [
        { day: '2026-10-05', active: 5 * 3600, idle: 4 * 3600, paused: 0, away: 0, offline: 0, productiveOffline: 0 },
        { day: '2026-10-06', active: 0, idle: 0, paused: 0, away: 0, offline: 0, productiveOffline: 0 },
      ],
    }],
    apps: [{ name: 'Chrome', active: 4 * 3600, idle: 3 * 3600 }],
    websites: [],
    categories: [{ category: 'uncategorised', active: 5 * 3600 }],
    projects: [{ name: 'Website', active: 5 * 3600 }],
    ...over,
  };
}

test('a high idle share names the application and the quiet day', () => {
  const notes = activityRecommendations(input());
  assert.ok(notes.some((note) => note.includes('Idle time') && note.includes('Chrome')));
  assert.ok(notes.some((note) => note.includes('Tue, 6 Oct 2026')));
  assert.ok(notes.some((note) => note.includes('uncategorised') || note.includes('uncategor')));
});

test('a lower plan leaves out application charts and the written coaching', () => {
  const report = buildActivityReport(input({ access: { software: false, coaching: false } }));
  assert.equal(report.charts?.some((chart) => chart.title === 'Applications'), false);
  assert.equal(report.charts?.some((chart) => chart.title === 'Active hours'), true);
  assert.equal(report.sections?.some((section) => section.heading === 'What to improve'), false);
  assert.equal(report.sections?.some((section) => section.paragraphs.some((line) => line.includes('Chrome'))), false);
});

test('application usage without coaching keeps the charts and leaves out the advice', () => {
  const report = buildActivityReport(input({ access: { software: true, coaching: false } }));
  assert.equal(report.charts?.some((chart) => chart.title === 'Applications'), true);
  assert.equal(report.sections?.some((section) => section.heading === 'What to improve'), false);
  assert.ok(report.sections?.some((section) => section.paragraphs.some((line) => line.includes('Chrome'))));
});

test('a project filter tells the manager that time away is left out', () => {
  const report = buildActivityReport(input({ projectLabel: 'No project', people: [{
    name: 'Ada Lovelace',
    days: [{ day: '2026-10-05', active: 8 * 3600, idle: 600, paused: 0, away: 0, offline: 0, productiveOffline: 0 }],
  }] }));
  assert.equal(report.subtitle?.includes('No project'), true);
  assert.ok(report.sections?.find((section) => section.heading === 'What to improve')?.paragraphs.some((line) => line.includes('No project')));
  assert.equal(report.charts?.some((chart) => chart.title === 'Projects'), false);
});
