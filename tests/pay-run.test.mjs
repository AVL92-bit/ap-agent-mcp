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
test('one payment per invoice: each bill is its own line, its own amount, its own invoice number as the reference', () => {
  const r = buildPayRun([bill({ number: 'INV-2', amountDue: 50.5, dueDate: '2026-12-05' }), bill()], [contact()]);
  assert.equal(r.review.length, 2);
  assert.deepEqual(r.review.map(l => [l.billNumber, l.amountDue, l.status]), [['INV-1', 100, 'ready'], ['INV-2', 50.5, 'ready']]); // due-date order
  assert.equal(r.fileLines.length, 2);
  assert.deepEqual(r.fileLines[0], { name: 'Acme Supplies Ltd', recipientType: 'BUSINESS', accountNumber: '12345678', sortCode: '123456', amount: 100, reference: 'INV-1' });
  assert.deepEqual(r.fileLines[1], { name: 'Acme Supplies Ltd', recipientType: 'BUSINESS', accountNumber: '12345678', sortCode: '123456', amount: 50.5, reference: 'INV-2' });
  assert.equal(r.totals.ready, 150.5);
  assert.equal(r.totals.ready_lines, 2);
});
test('removing one invoice\'s line removes exactly that bill; nothing else changes', () => {
  const all = buildPayRun([bill(), bill({ number: 'INV-2', amountDue: 50.5 }), bill({ number: 'INV-3', amountDue: 10 })], [contact()]);
  const without = all.fileLines.filter(l => l.reference !== 'INV-2');
  assert.deepEqual(without.map(l => l.reference), ['INV-1', 'INV-3']);
  assert.equal(without.reduce((n, l) => n + l.amount, 0), 110);
});
test('direct debit suppliers are excluded from the file but shown as excluded, every invoice', () => {
  const r = buildPayRun([bill({ contactName: 'Wavenet (DD)' }), bill({ number: 'INV-2', contactName: 'Wavenet (DD)' })], [contact({ name: 'Wavenet (DD)' })]);
  assert.deepEqual(r.review.map(l => l.status), ['excluded', 'excluded']);
  assert.deepEqual(r.review[0].flags, ['direct_debit_excluded']);
  assert.equal(r.fileLines.length, 0);
  assert.equal(r.totals.excluded, 200);
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
test('non-GBP and zero/negative amounts are not written', () => {
  assert.equal(buildPayRun([bill({ currency: 'EUR' })], [contact()]).review[0].flags[0], 'not_gbp');
  const zero = buildPayRun([bill({ amountDue: 0 })], [contact()]);
  assert.equal(zero.review[0].flags.includes('zero_or_negative_amount'), true);
  assert.equal(zero.fileLines.length, 0);
});
test('invoices only: credit on account is not considered, flagged or netted off (the owner checks it in Xero)', () => {
  // A third argument (credits) is ignored: the function takes bills and contacts only.
  const r = buildPayRun([bill(), bill({ number: 'INV-2', amountDue: 50 })], [contact()], [{ contactId: 'c1', remaining: 20 }]);
  assert.deepEqual(r.review.map(l => l.status), ['ready', 'ready']);
  assert.deepEqual(r.review.map(l => l.flags), [[], []]);
  assert.deepEqual(r.fileLines.map(l => l.amount), [100, 50]);
  assert.equal(JSON.stringify(r.review).toLowerCase().includes('credit'), false);
});
test('an invoice number longer than the reference limit is held for attention, never silently cut', () => {
  const longNumber = 'X'.repeat(REFERENCE_MAX + 1);
  const r = buildPayRun([bill({ number: longNumber })], [contact()]);
  assert.equal(r.review[0].status, 'needs_attention');
  assert.deepEqual(r.review[0].flags, ['reference_too_long']);
  assert.equal(r.fileLines.length, 0);
  assert.equal(buildPayRun([bill({ number: 'X'.repeat(REFERENCE_MAX) })], [contact()]).fileLines.length, 1);
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
