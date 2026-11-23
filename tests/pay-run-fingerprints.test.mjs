import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fingerprintKey, fingerprintOf, bankStatusFor, annotateBankStatus, suppliersToVerify, bankCheckCounts, ensureBaselineTable, loadBaselines, acceptBaselines } from '../dist/pay-run-fingerprints.js';
import { buildPayRun, summarise } from '../dist/pay-run.js';

const MASTER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const key = fingerprintKey(MASTER);
const line = (over = {}) => ({ contactId: 'c1', supplier: 'Acme', billNumber: 'INV-1', dueDate: null, name: 'Acme Supplies Ltd', recipientType: 'BUSINESS',
  accountNumber: '01234567', sortCode: '012345', amount: 100, reference: 'INV-1', missing: [], ...over });

test('the key comes from the encryption key, is derived (not the master), and a bad master is refused', () => {
  assert.equal(key.length, 32);
  assert.notEqual(key.toString('hex'), MASTER);
  assert.notDeepEqual(fingerprintKey(OTHER), key);
  assert.deepEqual(fingerprintKey(MASTER), key);
  for (const bad of [undefined, '', 'short', 'z'.repeat(64)]) assert.throws(() => fingerprintKey(bad), /unavailable/);
});
test('the fingerprint is a keyed hash: stable, hex, no plaintext, and different keys give different hashes', () => {
  const fp = fingerprintOf(key, line());
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(fp, fingerprintOf(key, line()));
  assert.equal(fp.includes('012345') || fp.includes('01234567'), false);
  assert.notEqual(fp, fingerprintOf(fingerprintKey(OTHER), line()));
});
test('a change to the sort code, the account number or the account name changes the fingerprint; spacing and case do not', () => {
  const base = fingerprintOf(key, line());
  assert.notEqual(base, fingerprintOf(key, line({ sortCode: '012346' })));
  assert.notEqual(base, fingerprintOf(key, line({ accountNumber: '01234568' })));
  assert.notEqual(base, fingerprintOf(key, line({ name: 'Acme Supplies Limited' })));
  assert.equal(base, fingerprintOf(key, line({ name: '  ACME   supplies ltd ' })));
});
test('incomplete details cannot be fingerprinted', () => {
  for (const over of [{ sortCode: '' }, { accountNumber: '' }, { name: '' }, { name: '   ' }]) assert.equal(fingerprintOf(key, line(over)), null);
});
test('status: unverified with no baseline, unchanged when identical, changed otherwise, n/a when incomplete', () => {
  const fp = fingerprintOf(key, line());
  assert.equal(bankStatusFor(fp, undefined), 'unverified');
  assert.equal(bankStatusFor(fp, fp), 'unchanged');
  assert.equal(bankStatusFor(fp, 'f'.repeat(64)), 'changed');
  assert.equal(bankStatusFor(null, fp), 'n/a');
  assert.equal(bankStatusFor(null, undefined), 'n/a');
});
test('annotating lines: a changed account is caught, a verified one is quiet, a never-verified one is flagged', () => {
  const lines = [line({ contactId: 'ok' }), line({ contactId: 'moved', accountNumber: '99999999' }), line({ contactId: 'new' }), line({ contactId: 'blank', name: '', missing: ['account_name'] })];
  const baselines = new Map([['ok', fingerprintOf(key, line())], ['moved', fingerprintOf(key, line())]]); // 'moved' was verified with the OLD account number
  annotateBankStatus(lines, baselines, key);
  assert.deepEqual(lines.map(l => l.bankStatus), ['unchanged', 'changed', 'unverified', 'n/a']);
  assert.deepEqual(bankCheckCounts(lines), { unchanged: 1, changed: 1, unverified: 1, not_checkable: 1 });
});
test('suppliers to verify: one entry per supplier, changed first, no values', () => {
  const lines = [line({ contactId: 'a', supplier: 'Zed', bankStatus: 'unverified' }), line({ contactId: 'a', supplier: 'Zed', bankStatus: 'unverified', billNumber: '2' }),
    line({ contactId: 'b', supplier: 'Beta', bankStatus: 'changed' }), line({ contactId: 'c', supplier: 'Fine', bankStatus: 'unchanged' })];
  const v = suppliersToVerify(lines);
  assert.deepEqual(v, [{ supplier: 'Beta', status: 'changed', lines: 1 }, { supplier: 'Zed', status: 'unverified', lines: 2 }]);
  assert.equal(/012345|01234567|Acme Supplies/.test(JSON.stringify(v)), false);
});
test('the masked summary carries the status per line and never a value', () => {
  const contacts = [{ contactId: 'c1', name: 'Acme', bankAccountDetails: '01234501234567', batchPayments: { BankAccountNumber: '01234567', BankAccountName: 'Acme Supplies Ltd' } }];
  const bills = [{ number: 'I1', contactId: 'c1', contactName: 'Acme', amountDue: 10, dueDate: null, currency: 'GBP' }];
  const run = buildPayRun(bills, contacts);
  assert.equal(run.lines[0].contactId, 'c1');
  annotateBankStatus(run.lines, new Map(), key);
  const s = summarise(run, 'metro');
  assert.equal(s.lines[0].bank_details, 'unverified');
  assert.equal(/0123450|01234567|012345|Acme Supplies/.test(JSON.stringify(s)), false);
});

// ---- storage: only fingerprints, names and dates reach the database ----
function fakeDb() {
  const calls = [];
  const rows = new Map();
  return { calls, db: { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (/INSERT INTO pay_run_bank_baselines/.test(sql)) rows.set(`${params[0]}|${params[1]}`, { contact_id: params[1], fingerprint: params[3] });
    if (/SELECT contact_id, fingerprint/.test(sql)) return { rows: [...rows.entries()].filter(([k]) => k.startsWith(`${params[0]}|`)).map(([, v]) => v) };
    return { rows: [] };
  } } };
}
test('accepting records the fingerprint of the current details, once per supplier, and loading returns it', async () => {
  const { db, calls } = fakeDb();
  await ensureBaselineTable(db);
  const lines = [line({ contactId: 'a' }), line({ contactId: 'a', billNumber: '2' }), line({ contactId: 'b', accountNumber: '07654321' })];
  assert.equal(await acceptBaselines(db, 'st-georges', lines, key), 2);
  const inserts = calls.filter(c => /INSERT/.test(c.sql));
  assert.equal(inserts.length, 2);
  const everything = JSON.stringify(calls.map(c => c.params));
  assert.equal(everything.includes('01234567') || everything.includes('012345') || everything.includes('07654321') || everything.includes('Acme Supplies'), false, 'no bank detail or account name is sent to the database');
  const loaded = await loadBaselines(db, 'st-georges');
  assert.equal(loaded.get('a'), fingerprintOf(key, line({ contactId: 'a' })));
  assert.equal((await loadBaselines(db, 'lamberhurst')).size, 0); // baselines are per company
});
test('incomplete details are never recorded as verified', async () => {
  const { db, calls } = fakeDb();
  assert.equal(await acceptBaselines(db, 'x', [line({ name: '' }), line({ sortCode: '', contactId: 'z' })], key), 0);
  assert.equal(calls.filter(c => /INSERT/.test(c.sql)).length, 0);
});
test('the table holds fingerprints, supplier names and dates: no column for sort codes, account numbers or account names', () => {
  const src = readFileSync(new URL('../src/pay-run-fingerprints.ts', import.meta.url), 'utf8');
  const ddl = src.match(/CREATE TABLE IF NOT EXISTS pay_run_bank_baselines \([\s\S]*?\)`\);/)?.[0] ?? '';
  assert.ok(ddl.includes('fingerprint text NOT NULL'));
  assert.equal(/sort_code|account_number|account_name|sortcode/i.test(ddl), false);
});
