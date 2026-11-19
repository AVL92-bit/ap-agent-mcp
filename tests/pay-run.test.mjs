import test from 'node:test';
import assert from 'node:assert/strict';
import { recipientTypeFor, isDirectDebitContact, parseBankDetails, buildPayRun, renderRevolutCsv, REFERENCE_MAX } from '../dist/pay-run.js';

const bill = (over) => ({ number: 'INV-1', contactId: 'c1', contactName: 'Acme Supplies', amountDue: 100, dueDate: '2026-12-01', currency: 'GBP', ...over });
const contact = (over) => ({ contactId: 'c1', name: 'Acme Supplies', bankAccountDetails: '12345612345678', batchPayments: { BankAccountNumber: '12345678', BankAccountName: 'Acme Supplies Ltd' }, ...over });

test('business if the account name has Limited, Ltd, LLP, PLC and similar; otherwise individual (locums)', () => {
  for (const n of ['Acme Supplies Ltd', 'ACME LIMITED', 'Smith & Co LLP', 'Big Group PLC', 'Care Trust', 'Ltd.']) assert.equal(recipientTypeFor(n), 'BUSINESS', n);
  for (const n of ['Dr J Smith', 'Jane Locum', 'Ltdsmith']) assert.equal(recipientTypeFor(n), 'INDIVIDUAL', n);
});
test('(DD) and direct debit contacts are recognised', () => {
  assert.equal(isDirectDebitContact('Wavenet (DD)'), true);
  assert.equal(isDirectDebitContact('Healthtech-1 (dd)'), true);
  assert.equal(isDirectDebitContact('Wavenet Limited'), false);
});
test('bank details: sort code and account number from the 14 digits; the batch number must agree', () => {
  assert.deepEqual(parseBankDetails(contact()), { ok: true, sortCode: '123456', accountNumber: '12345678' });
  assert.deepEqual(parseBankDetails(contact({ bankAccountDetails: '12-34-56 12345678' })), { ok: true, sortCode: '123456', accountNumber: '12345678' });
  assert.equal(parseBankDetails(contact({ batchPayments: { BankAccountNumber: '87654321' } })).problem, 'details_disagree');
  assert.equal(parseBankDetails(contact({ bankAccountDetails: '' , batchPayments: null })).problem, 'missing');
  assert.equal(parseBankDetails(contact({ bankAccountDetails: '1234' })).problem, 'unrecognised_format');
});
test('a normal supplier is ready: one line, amounts summed per supplier, reference is the invoice numbers', () => {
  const r = buildPayRun([bill(), bill({ number: 'INV-2', amountDue: 50.5, dueDate: '2026-12-05' })], [contact()]);
  assert.equal(r.review[0].status, 'ready');
  assert.equal(r.review[0].total, 150.5);
  assert.equal(r.review[0].reference, 'INV-1, INV-2');
  assert.equal(r.fileLines.length, 1);
  assert.deepEqual(r.fileLines[0], { name: 'Acme Supplies Ltd', recipientType: 'BUSINESS', accountNumber: '12345678', sortCode: '123456', amount: 150.5, reference: 'INV-1, INV-2' });
});
test('direct debit suppliers are excluded from the file but shown as excluded', () => {
  const r = buildPayRun([bill({ contactName: 'Wavenet (DD)' })], [contact({ name: 'Wavenet (DD)' })]);
  assert.equal(r.review[0].status, 'excluded');
  assert.deepEqual(r.review[0].flags, ['direct_debit_excluded']);
  assert.equal(r.fileLines.length, 0);
  assert.equal(r.totals.excluded, 100);
});
test('missing bank details, missing account name, disagreeing numbers: flagged, no file line, never guessed', () => {
  assert.deepEqual(buildPayRun([bill()], [contact({ bankAccountDetails: '', batchPayments: { BankAccountName: 'X Ltd' } })]).review[0].flags, ['no_bank_details']);
  const noName = buildPayRun([bill()], [contact({ batchPayments: { BankAccountNumber: '12345678' } })]);
  assert.deepEqual(noName.review[0].flags, ['no_account_name']);
  assert.equal(noName.review[0].status, 'needs_attention');
  assert.equal(noName.fileLines.length, 0);
  assert.equal(buildPayRun([bill()], [contact({ batchPayments: { BankAccountNumber: '99999999', BankAccountName: 'X Ltd' } })]).review[0].flags.includes('bank_details_disagree'), true);
  assert.equal(buildPayRun([bill()], []).review[0].flags.includes('contact_not_found'), true);
});
test('non-GBP and zero/negative totals are not written', () => {
  assert.equal(buildPayRun([bill({ currency: 'EUR' })], [contact()]).review[0].flags[0], 'not_gbp');
  const zero = buildPayRun([bill({ amountDue: 0 })], [contact()]);
  assert.equal(zero.review[0].flags.includes('zero_or_negative_total'), true);
  assert.equal(zero.fileLines.length, 0);
});
test('unapplied credit and a long reference are flagged but do not block the line', () => {
  const many = Array.from({ length: 6 }, (_, i) => bill({ number: `LONGNUMBER-${i}` }));
  const r = buildPayRun(many, [contact()], [{ contactId: 'c1', remaining: 20 }]);
  assert.equal(r.review[0].status, 'ready');
  assert.equal(r.review[0].flags.includes('unapplied_credit'), true);
  assert.equal(r.review[0].flags.includes('reference_truncated'), true);
  assert.equal(r.review[0].reference.length, REFERENCE_MAX);
  assert.equal(r.fileLines.length, 1);
});
test('the review never contains a sort code or an account number', () => {
  const json = JSON.stringify(buildPayRun([bill()], [contact()]).review);
  assert.equal(/12345678|123456/.test(json), false);
});
test('Revolut CSV: exactly the template columns, GBP to GB, 2dp amounts, quoting, and formula characters neutralised', () => {
  const csv = renderRevolutCsv([
    { name: 'Smith, Jane', recipientType: 'INDIVIDUAL', accountNumber: '12345678', sortCode: '123456', amount: 10, reference: 'INV-1' },
    { name: '=HYPERLINK("x")', recipientType: 'BUSINESS', accountNumber: '87654321', sortCode: '654321', amount: 1234.5, reference: 'A, B' },
  ]);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], 'Name,Recipient type,Account number,Sort code,Recipient bank country,Currency,Amount,Payment reference');
  assert.equal(lines[1], '"Smith, Jane",INDIVIDUAL,12345678,123456,GB,GBP,10.00,INV-1');
  assert.equal(lines[2].startsWith(`"'=HYPERLINK(""x"")",BUSINESS`), true);
  assert.equal(lines[2].endsWith(',GB,GBP,1234.50,"A, B"'), true);
});
