import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPayRunInputs } from '../dist/pay-run-xero.js';
import { buildPayRun } from '../dist/pay-run.js';

const inv = (n, cid, name, due, extra = {}) => ({ InvoiceNumber: n, InvoiceID: `id-${n}`, Contact: { ContactID: cid, Name: name }, AmountDue: due, DueDateString: '2026-12-01T00:00:00', CurrencyCode: 'GBP', ...extra });

test('loads awaiting-payment invoices and their contacts only; never reads credit notes; only ever GETs', async () => {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    if (path.startsWith('Invoices?')) return { Invoices: [inv('A1', 'c1', 'Acme', 100), inv('A2', 'c1', 'Acme', 50.5), inv('Z0', 'c2', 'Paid Co', 0)] };
    if (path.startsWith('Contacts?IDs=')) return { Contacts: [{ ContactID: 'c1', Name: 'Acme', BankAccountDetails: '12345612345678', BatchPayments: { BankAccountNumber: '12345678', BankAccountName: 'Acme Ltd' } }] };
    throw new Error(`unexpected ${path}`); // a CreditNotes call would land here and fail the test
  };
  const { bills, contacts, ...rest } = await loadPayRunInputs(get);
  assert.deepEqual(bills.map(b => b.number), ['A1', 'A2']); // the fully paid (0 due) one is not awaiting payment
  assert.equal(bills[0].dueDate, '2026-12-01');
  assert.equal(contacts.length, 1);
  assert.deepEqual(rest, {});
  assert.equal(calls.some(c => /CreditNotes/.test(c)), false);
  assert.equal(calls.some(c => /Statuses=AUTHORISED/.test(c)), true);
  const run = buildPayRun(bills, contacts);
  assert.deepEqual(run.fileLines.map(l => [l.reference, l.amount]), [['A1', 100], ['A2', 50.5]]);
});
test('contacts are requested in chunks of 40 ids', async () => {
  const many = Array.from({ length: 85 }, (_, i) => inv(`N${i}`, `c${i}`, `S${i}`, 1));
  const idCalls = [];
  const get = async (path) => {
    if (path.startsWith('Invoices?') && /page=1$/.test(path)) return { Invoices: many.slice(0, 100) };
    if (path.startsWith('Contacts?IDs=')) { idCalls.push(path.split('=')[1].split(',').length); return { Contacts: [] }; }
    throw new Error(`unexpected ${path}`);
  };
  await loadPayRunInputs(get);
  assert.deepEqual(idCalls, [40, 40, 5]);
});
test('a partial result is refused: pagination that never ends throws instead of building half a pay run', async () => {
  const get = async () => ({ Invoices: Array.from({ length: 100 }, (_, i) => inv(`N${i}`, 'c1', 'A', 1)) });
  await assert.rejects(() => loadPayRunInputs(get), /pagination incomplete/);
});
test('the loader contains no write verbs', async () => {
  const { readFileSync } = await import('node:fs');
  const s = readFileSync(new URL('../src/pay-run-xero.ts', import.meta.url), 'utf8');
  assert.equal(/POST|PUT|DELETE|PATCH|method:/.test(s), false);
});
