import test from 'node:test';
import assert from 'node:assert/strict';
const { moveOutOfLockedPeriod, xeroDateToIso } = await import(new URL('../dist/xero-review-drafts.js', import.meta.url));
test('locked invoice date moves to the first open day and is flagged', () => {
  const r = moveOutOfLockedPeriod('2026-07-01', '2026-07-24', '2026-09-30');
  assert.equal(r.invoiceDate, '2026-10-01'); assert.equal(r.dueDate, '2026-10-01');
  assert.match(r.note, /locked Xero period \(locked to 2026-09-30\); drafted with date 2026-10-01/);
});
test('open dates are unchanged; a later due date is kept', () => {
  assert.deepEqual(moveOutOfLockedPeriod('2026-11-01', '2026-12-01', '2026-09-30'), { invoiceDate: '2026-11-01', dueDate: '2026-12-01' });
  assert.equal(moveOutOfLockedPeriod('2026-09-30', '2026-11-15', '2026-09-30').dueDate, '2026-11-15');
  assert.deepEqual(moveOutOfLockedPeriod('2026-07-01', '2026-07-24', null), { invoiceDate: '2026-07-01', dueDate: '2026-07-24' });
});
test('Xero date formats', () => {
  assert.equal(xeroDateToIso('/Date(1790726400000+0000)/'), '2026-09-30');
  assert.equal(xeroDateToIso('2026-09-30T00:00:00'), '2026-09-30');
  assert.equal(xeroDateToIso(undefined), null);
});
