import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addDays, csvEscape, formatDuration, periodRange, todayIn, weekdayIndex } from './format.ts';

test('today in Johannesburg crosses midnight before UTC does', () => {
  assert.equal(todayIn('Africa/Johannesburg', new Date('2026-10-05T22:30:00Z')), '2026-10-06');
  assert.equal(todayIn('UTC', new Date('2026-10-05T22:30:00Z')), '2026-10-05');
});

test('day arithmetic across month and year ends', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(weekdayIndex('2026-10-05'), 0); // Monday
  assert.equal(weekdayIndex('2026-10-11'), 6); // Sunday
});

test('period ranges', () => {
  const today = '2026-10-07'; // Wednesday
  assert.deepEqual(periodRange('this_week', today), { from: '2026-10-05', to: '2026-10-07' });
  assert.deepEqual(periodRange('last_week', today), { from: '2026-09-28', to: '2026-10-04' });
  assert.deepEqual(periodRange('this_month', today), { from: '2026-10-01', to: '2026-10-07' });
  assert.deepEqual(periodRange('last_month', today), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(periodRange('yesterday', '2026-01-01'), { from: '2025-12-31', to: '2025-12-31' });
});

test('durations', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(30), '<1m');
  assert.equal(formatDuration(3_660), '1h 01m');
  assert.equal(formatDuration(59 * 60), '59m');
});

test('csv escaping blocks spreadsheet formula injection', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvEscape(null), '');
});
