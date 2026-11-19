import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPayRunInputs } from '../dist/pay-run-xero.js';
import { buildPayRun } from '../dist/pay-run.js';

const inv = (n, cid, name, due, extra = {}) => ({ InvoiceNumber: n, InvoiceID: `id-${n}`, Contact: { ContactID: cid, Name: name }, AmountDue: due, DueDateString: '2026-12-01T00:00:00', CurrencyCode: 'GBP', ...extra });

test('loads awaiting-payment bills, their contacts in chunks, and unapplied credits; only ever GETs the three resources', async () => {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    if (path.startsWith('Invoices?')) return { Invoices: [inv('A1', 'c1', 'Acme', 100), inv('A2', 'c1', 'Acme', 50.5), inv('Z0', 'c2', 'Paid Co', 0)] };
    if (path.startsWith('Contacts?IDs=')) return { Contacts: [{ ContactID: 'c1', Name: 'Acme', BankAccountDetails: '12345612345678', BatchPayments: { BankAccountNumber: '12345678', BankAccountName: 'Acme Ltd' } }] };
    if (path.startsWith('CreditNotes?')) return { CreditNotes: [{ Contact: { ContactID: 'c1' }, RemainingCredit: 25 }, { Contact: { ContactID: 'c1' }, RemainingCredit: 0 }] };
    throw new Error(`unexpected ${path}`);
  };
  const { bills, contacts, credits } = await loadPayRunInputs(get);
  assert.deepEqual(bills.map(b => b.number), ['A1', 'A2']); // the fully paid (0 due) one is not awaiting payment
  assert.equal(bills[0].dueDate, '2026-12-01');
  assert.equal(contacts.length, 1);
  assert.deepEqual(credits, [{ contactId: 'c1', remaining: 25 }]);
  assert.equal(calls.some(c => /Statuses=AUTHORISED/.test(c)), true);
  const run = buildPayRun(bills, contacts, credits);
  assert.deepEqual(run.fileLines.map(l => [l.reference, l.amount]), [['A1', 100], ['A2', 50.5]]);
  assert.equal(run.review[0].supplierUnappliedCredit, 25);
});
test('contacts are requested in chunks of 40 ids', async () => {
  const many = Array.from({ length: 85 }, (_, i) => inv(`N${i}`, `c${i}`, `S${i}`, 1));
  const idCalls = [];
  const get = async (path) => {
    if (path.startsWith('Invoices?') && /page=1$/.test(path)) return { Invoices: many.slice(0, 100) };
    if (path.startsWith('Contacts?IDs=')) { idCalls.push(path.split('=')[1].split(',').length); return { Contacts: [] }; }
    if (path.startsWith('CreditNotes?')) return { CreditNotes: [] };
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
