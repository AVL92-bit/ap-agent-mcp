import test from 'node:test';
import assert from 'node:assert/strict';
import { recipientTypeFor, isDirectDebitContact, parseBankDetails, referenceFor, buildPayRun, summarise, renderRevolutCsv, REFERENCE_MAX } from '../dist/pay-run.js';

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
test('always-business list: a business with no Ltd in its name (JP Medassist) is BUSINESS; case and spacing are ignored', () => {
  const jp = contact({ name: 'JP Medassist', batchPayments: { BankAccountNumber: '12345678', BankAccountName: 'JP Medassist' } });
  assert.equal(buildPayRun([bill()], [jp]).lines[0].recipientType, 'INDIVIDUAL'); // without the list: no Ltd, so individual
  assert.equal(buildPayRun([bill()], [jp], { alwaysBusiness: ['JP Medassist'] }).lines[0].recipientType, 'BUSINESS');
  assert.equal(buildPayRun([bill()], [jp], { alwaysBusiness: ['  jp   MEDASSIST '] }).lines[0].recipientType, 'BUSINESS');
  // matched on the bank account name too, and on the contact name when the account name differs
  const other = contact({ name: 'J P Medical', batchPayments: { BankAccountNumber: '12345678', BankAccountName: 'JP Medassist' } });
  assert.equal(buildPayRun([bill()], [other], { alwaysBusiness: ['JP Medassist'] }).lines[0].recipientType, 'BUSINESS');
  // others are unaffected
  assert.equal(buildPayRun([bill()], [contact({ name: 'Dr J Smith', batchPayments: { BankAccountNumber: '12345678', BankAccountName: 'Dr J Smith' } })], { alwaysBusiness: ['JP Medassist'] }).lines[0].recipientType, 'INDIVIDUAL');
  // a listed supplier still gets its type when the account name is missing; nothing else is invented
  const noName = buildPayRun([bill()], [jp.batchPayments && { ...jp, batchPayments: { BankAccountNumber: '12345678' } }], { alwaysBusiness: ['JP Medassist'] }).lines[0];
  assert.deepEqual([noName.recipientType, noName.name, noName.missing], ['BUSINESS', '', ['account_name']]);
});
test('unsafe characters are removed from the payment reference before it is cut to 18', () => {
  assert.equal(referenceFor('INV-MS-1446*-July-2026'), 'MS-1446-July-2026'); // * removed, then last 18, then leading hyphen dropped
  assert.equal(referenceFor('INV-MS-8675*-October-2026'), 'MS-8675-October-2026'.slice(-18).replace(/^[ \/-]+/, ''));
  assert.equal(referenceFor('INV/38652'), 'INV/38652'); // slash, hyphen, space and alphanumerics are kept
  assert.equal(referenceFor('RI 65930654'), 'RI 65930654');
  assert.equal(referenceFor('A&B #12 (x) "q" 50%'), 'AB 12 x q 50');
  assert.equal(referenceFor('  INV__1.2,3:4;5+6@7  '), 'INV1234567');
  assert.equal(referenceFor('=SUM(1)'), 'SUM1'); // nothing that starts a spreadsheet formula survives
  assert.equal(referenceFor('***'), '');
  for (const n of ['INV-MS-1446*-July-2026', 'A&B/#C', 'X'.repeat(40) + '*', '*'.repeat(30) + 'A']) {
    const r = referenceFor(n);
    assert.match(r, /^[A-Za-z0-9 \/-]*$/);
    assert.ok(r.length <= REFERENCE_MAX);
    assert.equal(/^[ \/-]/.test(r), false);
  }
});
test('a long invoice number keeps its LAST 18 characters', () => {
  assert.equal(referenceFor('123456789123456789123'), '456789123456789123');
  assert.equal(referenceFor('123456789123456789123').length, REFERENCE_MAX);
  assert.equal(referenceFor('INV-1'), 'INV-1');
  assert.equal(referenceFor('X'.repeat(REFERENCE_MAX)), 'X'.repeat(REFERENCE_MAX));
});
test('bank details: sort code and account number from the 14 digits; the batch number must agree', () => {
  assert.deepEqual(parseBankDetails(contact()), { ok: true, sortCode: '123456', accountNumber: '12345678' });
  assert.deepEqual(parseBankDetails(contact({ bankAccountDetails: '12-34-56 12345678' })), { ok: true, sortCode: '123456', accountNumber: '12345678' });
  assert.equal(parseBankDetails(contact({ batchPayments: { BankAccountNumber: '87654321' } })).problem, 'details_disagree');
  assert.equal(parseBankDetails(contact({ bankAccountDetails: '' , batchPayments: null })).problem, 'missing');
  assert.equal(parseBankDetails(contact({ bankAccountDetails: '1234' })).problem, 'unrecognised_format');
});
test('one payment per invoice: each bill is its own complete line with its own amount and invoice number as reference', () => {
  const r = buildPayRun([bill({ number: 'INV-2', amountDue: 50.5, dueDate: '2026-12-05' }), bill()], [contact()]);
  assert.deepEqual(r.lines.map(l => [l.billNumber, l.amount, l.reference, l.missing.length]), [['INV-1', 100, 'INV-1', 0], ['INV-2', 50.5, 'INV-2', 0]]);
  assert.deepEqual([r.lines[0].name, r.lines[0].recipientType, r.lines[0].accountNumber, r.lines[0].sortCode], ['Acme Supplies Ltd', 'BUSINESS', '12345678', '123456']);
  assert.deepEqual(r.totals, { lines: 2, complete_lines: 2, incomplete_lines: 0, amount: 150.5 });
});
test('removing one invoice\'s line removes exactly that bill; nothing else changes', () => {
  const all = buildPayRun([bill(), bill({ number: 'INV-2', amountDue: 50.5 }), bill({ number: 'INV-3', amountDue: 10 })], [contact()]);
  const without = all.lines.filter(l => l.reference !== 'INV-2');
  assert.deepEqual(without.map(l => l.reference), ['INV-1', 'INV-3']);
  assert.equal(without.reduce((n, l) => n + l.amount, 0), 110);
});
test('(DD) suppliers are skipped entirely: no row, only counted', () => {
  const r = buildPayRun([bill({ contactName: 'Wavenet (DD)' }), bill({ number: 'INV-2', contactName: 'Wavenet (DD)' })], [contact({ name: 'Wavenet (DD)' })]);
  assert.equal(r.lines.length, 0);
  assert.equal(r.skipped.direct_debit, 2);
  assert.equal(renderRevolutCsv(r.lines).trimEnd().split('\r\n').length, 1); // header only
  assert.equal(JSON.stringify(summarise(r)).includes('Wavenet'), false);
});
test('non-GBP, zero and negative amounts are skipped, not listed', () => {
  const r = buildPayRun([bill({ currency: 'EUR' }), bill({ number: 'INV-2', amountDue: 0 }), bill({ number: 'INV-3', amountDue: -20 }), bill({ number: 'INV-4' })], [contact()]);
  assert.deepEqual(r.lines.map(l => l.billNumber), ['INV-4']);
  assert.deepEqual(r.skipped, { direct_debit: 0, non_gbp: 1, zero_or_negative: 2 });
});
test('partial rows: whatever Xero lacks is left blank, amount and reference are always filled', () => {
  // no account name: name and type blank, numbers still filled
  const noName = buildPayRun([bill()], [contact({ batchPayments: { BankAccountNumber: '12345678' } })]).lines[0];
  assert.deepEqual([noName.name, noName.recipientType, noName.accountNumber, noName.sortCode, noName.amount, noName.reference], ['', '', '12345678', '123456', 100, 'INV-1']);
  assert.deepEqual(noName.missing, ['account_name']);
  // no bank details: numbers blank, name filled
  const noBank = buildPayRun([bill()], [contact({ bankAccountDetails: '', batchPayments: { BankAccountName: 'X Ltd' } })]).lines[0];
  assert.deepEqual([noBank.name, noBank.accountNumber, noBank.sortCode], ['X Ltd', '', '']);
  assert.deepEqual(noBank.missing, ['bank_details']);
  // contact missing entirely: only amount and reference
  const none = buildPayRun([bill()], []).lines[0];
  assert.deepEqual([none.name, none.accountNumber, none.sortCode, none.amount, none.reference, none.missing], ['', '', '', 100, 'INV-1', ['contact_not_found']]);
});
test('disagreeing bank numbers are BOTH left blank: never guess which is right', () => {
  const l = buildPayRun([bill()], [contact({ batchPayments: { BankAccountNumber: '99999999', BankAccountName: 'X Ltd' } })]).lines[0];
  assert.deepEqual([l.accountNumber, l.sortCode, l.missing], ['', '', ['bank_details_disagree']]);
  const bad = buildPayRun([bill()], [contact({ bankAccountDetails: '1234' })]).lines[0];
  assert.deepEqual([bad.accountNumber, bad.sortCode, bad.missing], ['', '', ['bank_details_unrecognised']]);
});
test('incomplete lines come first so they are noticed', () => {
  const r = buildPayRun([bill({ number: 'A', contactId: 'c1', contactName: 'Acme' }), bill({ number: 'B', contactId: 'c2', contactName: 'Zed' })],
    [contact(), contact({ contactId: 'c2', name: 'Zed', bankAccountDetails: '' , batchPayments: null })]);
  assert.deepEqual(r.lines.map(l => [l.billNumber, l.missing.length > 0]), [['B', true], ['A', false]]);
});
test('the masked summary never contains a sort code, account number or account name', () => {
  const json = JSON.stringify(summarise(buildPayRun([bill()], [contact()])));
  assert.equal(/12345678|123456/.test(json), false);
  assert.equal(json.includes('Acme Supplies Ltd'), false);
  assert.equal(json.includes('INV-1'), true);
});
test('invoices only: credit on account is not considered anywhere', () => {
  const json = JSON.stringify(summarise(buildPayRun([bill()], [contact()]))).toLowerCase();
  assert.equal(json.includes('credit'), false);
});
test('Revolut CSV: exactly the template columns, blanks stay blank, GBP to GB, 2dp amounts, quoting, formula characters neutralised', () => {
  const csv = renderRevolutCsv([
    { supplier: 's', billNumber: 'b', dueDate: null, name: 'Smith, Jane', recipientType: 'INDIVIDUAL', accountNumber: '12345678', sortCode: '123456', amount: 10, reference: 'INV-1', missing: [] },
    { supplier: 's', billNumber: 'b', dueDate: null, name: '=HYPERLINK("x")', recipientType: 'BUSINESS', accountNumber: '87654321', sortCode: '654321', amount: 1234.5, reference: 'A, B', missing: [] },
    { supplier: 's', billNumber: 'b', dueDate: null, name: '', recipientType: '', accountNumber: '', sortCode: '', amount: 7, reference: 'INV-9', missing: ['contact_not_found'] },
  ]);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], 'Name,Recipient type,Account number,Sort code,Recipient bank country,Currency,Amount,Payment reference');
  assert.equal(lines[1], '"Smith, Jane",INDIVIDUAL,12345678,123456,GB,GBP,10.00,INV-1');
  assert.equal(lines[2].startsWith(`"'=HYPERLINK(""x"")",BUSINESS`), true);
  assert.equal(lines[2].endsWith(',GB,GBP,1234.50,"A, B"'), true);
  assert.equal(lines[3], ',,,,GB,GBP,7.00,INV-9');
  assert.equal(lines.every(l => !/supplier|missing/i.test(l) || l === lines[0]), true);
});
