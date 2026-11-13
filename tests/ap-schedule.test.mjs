import test from 'node:test';
import assert from 'node:assert/strict';
import { londonNow, isDue, summariseRun } from '../dist/ap-schedule.js';
test('London time follows GMT and BST', () => {
  assert.deepEqual(londonNow(new Date('2026-11-13T06:00:00Z')).time, '06:00');
  assert.deepEqual(londonNow(new Date('2026-07-01T05:00:00Z')).time, '06:00');
  assert.equal(londonNow(new Date('2026-11-13T23:30:00Z')).date, '2026-11-13');
});
test('due at or after the scheduled time, on allowed days only', () => {
  assert.equal(isDue({ date: '2026-11-13', time: '05:59', weekday: 'Fri' }, '06:00'), false);
  assert.equal(isDue({ date: '2026-11-13', time: '06:00', weekday: 'Fri' }, '06:00'), true);
  assert.equal(isDue({ date: '2026-11-14', time: '09:00', weekday: 'Sat' }, '06:00', 'Mon,Tue,Wed,Thu,Fri'), false);
  assert.equal(isDue({ date: '2026-11-13', time: '09:00', weekday: 'Fri' }, '06:00', 'Mon,Tue,Wed,Thu,Fri'), true);
  assert.equal(isDue({ date: '2026-11-13', time: '09:00', weekday: 'Fri' }, '6am'), false);
});
test('run summary counts', () => {
  const s = summariseRun({ conversations: 3, documents: 2, archived: 1, items: [{ archived: true, failures: [] }, { archived: false, failures: ['x'] }, { archived: false, failures: [] }] });
  assert.equal(s.left_open, 2); assert.equal(s.failures, 1); assert.equal(s.stopped_early, null);
});
