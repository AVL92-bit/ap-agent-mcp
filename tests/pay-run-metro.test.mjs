import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanName, beneficiaryNameFor, renderMetroCsv, renderRevolutCsv, findDuplicates, summarise, buildPayRun, NAME_MAX, MAX_LINES, PAYMENT_CODE } from '../dist/pay-run.js';
import { parseDebitAccounts, debitAccountFor } from '../dist/pay-run-config.js';
import { parseCompanies, _setCompaniesForTest, metroPayRunCompanies, loadCompanies } from '../dist/companies.js';

const line = (over = {}) => ({ supplier: 'Acme', billNumber: 'INV-1', dueDate: '2026-12-01', name: 'Acme Supplies Ltd', recipientType: 'BUSINESS',
  accountNumber: '01234567', sortCode: '012345', amount: 100, reference: 'INV-1', missing: [], ...over });

test('the Metro spec: seven fields in the order Metro defines, no header row, payment code 99', () => {
  const csv = renderMetroCsv([{ debitAccount: '09876543', lines: [line()] }]);
  assert.equal(PAYMENT_CODE, '99');
  assert.equal(csv, '09876543,012345,Acme Supplies Ltd,01234567,100.00,INV-1,99\r\n');
  assert.equal(csv.trimEnd().split('\r\n').length, 1); // one line, so no header row
});
test('leading zeros are kept in the debit account, sort code and account number (they are text, never numbers)', () => {
  const [debit, sort, , account] = renderMetroCsv([{ debitAccount: '00000123', lines: [line({ sortCode: '000010', accountNumber: '00004567' })] }]).split(',');
  assert.deepEqual([debit, sort, account], ['00000123', '000010', '00004567']);
});
test('ONE consolidated file for several practices: each line carries its own practice\'s debit account', () => {
  const csv = renderMetroCsv([
    { debitAccount: '11111111', lines: [line({ billNumber: 'A', reference: 'A' }), line({ billNumber: 'B', reference: 'B', amount: 5.5 })] },
    { debitAccount: '22222222', lines: [line({ billNumber: 'C', reference: 'C', amount: 12 })] },
  ]);
  const rows = csv.trimEnd().split('\r\n').map(r => r.split(','));
  assert.deepEqual(rows.map(r => r[0]), ['11111111', '11111111', '22222222']);
  assert.deepEqual(rows.map(r => r[4]), ['100.00', '5.50', '12.00']);
  assert.equal(rows.every(r => r.length === 7 && r[6] === '99'), true);
});
test('gaps stay blank in place: the debit account, amount, reference and code are always filled', () => {
  const csv = renderMetroCsv([{ debitAccount: '11111111', lines: [line({ name: '', sortCode: '', accountNumber: '', missing: ['contact_not_found'] })] }]);
  assert.equal(csv, '11111111,,,,100.00,INV-1,99\r\n');
});
test('names: banned characters become spaces, then the FIRST 18 characters are kept', () => {
  assert.equal(beneficiaryNameFor('Nationwide Cleaning Solutions Ltd'), 'Nationwide Cleanin');
  assert.equal(beneficiaryNameFor('Nationwide Cleaning Solutions Ltd').length, NAME_MAX);
  assert.equal(beneficiaryNameFor("Smith & Jones, Ltd."), 'Smith Jones Ltd.');
  assert.equal(beneficiaryNameFor("O'Brien @ Sons #1"), 'O Brien Sons 1');
  assert.equal(beneficiaryNameFor('Café Münster'), 'Cafe Munster');
  assert.equal(beneficiaryNameFor('  *** Acme ***  '), 'Acme');
  assert.equal(beneficiaryNameFor('Exactly 18 chars!!'), 'Exactly 18 chars');
  assert.equal(beneficiaryNameFor('Acme'), 'Acme');
  assert.equal(beneficiaryNameFor(''), '');
  // never a character Metro bans, and a cut never leaves a trailing space
  for (const n of ['A&B_C%D=E*F#G$H£I!J^K~L,M?N', 'Dr J Smith t/a The Practice Group Limited']) {
    const out = beneficiaryNameFor(n);
    assert.match(out, /^[A-Za-z0-9 .\/-]*$/);
    assert.ok(out.length <= NAME_MAX && out === out.trim());
  }
});
test('the file uses the shortened name, but the Xero account name is untouched in the line (Revolut keeps it in full)', () => {
  const l = line({ name: 'Nationwide Cleaning Solutions Ltd' });
  assert.match(renderMetroCsv([{ debitAccount: '11111111', lines: [l] }]), /,Nationwide Cleanin,/);
  assert.equal(l.name, 'Nationwide Cleaning Solutions Ltd');
  assert.match(renderRevolutCsv([l]), /^Name,Recipient type,[^\r\n]*\r\nNationwide Cleaning Solutions Ltd,BUSINESS,/);
});
test('Revolut still works exactly as before: header row, eight columns, GBP to GB (AVL keeps using it)', () => {
  const csv = renderRevolutCsv([line()]);
  assert.equal(csv.split('\r\n')[0], 'Name,Recipient type,Account number,Sort code,Recipient bank country,Currency,Amount,Payment reference');
  assert.equal(csv.split('\r\n')[1], 'Acme Supplies Ltd,BUSINESS,01234567,012345,GB,GBP,100.00,INV-1');
});
test('limits: at most 1,000 lines across the whole file; debit account must be exactly 8 digits; amounts fit 10 digits', () => {
  const many = Array.from({ length: MAX_LINES }, (_, i) => line({ billNumber: String(i), reference: String(i) }));
  assert.doesNotThrow(() => renderMetroCsv([{ debitAccount: '11111111', lines: many }]));
  assert.throws(() => renderMetroCsv([{ debitAccount: '11111111', lines: many }, { debitAccount: '22222222', lines: [line()] }]), /at most 1000/);
  for (const bad of ['1234567', '123456789', 'abcdefgh', '1234 567']) assert.throws(() => renderMetroCsv([{ debitAccount: bad, lines: [line()] }]), /8 digits/);
  assert.throws(() => renderMetroCsv([{ debitAccount: '11111111', lines: [line({ amount: 1234567890.12 })] }]), /too large/);
  assert.equal(renderMetroCsv([]), '');
});
test('formula characters in a name cannot survive into the file', () => {
  const csv = renderMetroCsv([{ debitAccount: '11111111', lines: [line({ name: '=HYPERLINK("x")', reference: 'R' })] }]);
  assert.equal(/[=+@]/.test(csv.split(',')[2]), false);
});
test('duplicates (same beneficiary, amount and reference) are reported across companies, never removed', () => {
  const entries = [
    { company: 'st-georges', line: line({ billNumber: 'A1' }) },
    { company: 'lamberhurst', line: line({ billNumber: 'A2' }) },     // same beneficiary, amount and reference
    { company: 'st-georges', line: line({ billNumber: 'B', reference: 'DIFFERENT' }) },
    { company: 'st-georges', line: line({ billNumber: 'C', sortCode: '', accountNumber: '' }) }, // unknown beneficiary: cannot compare
  ];
  const d = findDuplicates(entries);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].invoices, ['A1', 'A2']);
  assert.deepEqual(d[0].companies.sort(), ['lamberhurst', 'st-georges']);
  assert.equal(entries.length, 4);
});
test('a reference cut to 18 characters that makes two different invoices identical is caught as a duplicate', () => {
  const bill = (n) => ({ number: n, contactId: 'c1', contactName: 'Acme', amountDue: 50, dueDate: '2026-12-01', currency: 'GBP' });
  const contacts = [{ contactId: 'c1', name: 'Acme', bankAccountDetails: '01234501234567', batchPayments: { BankAccountNumber: '01234567', BankAccountName: 'Acme Ltd' } }];
  const run = buildPayRun([bill('AAAA-0000000000000000001'), bill('BBBB-0000000000000000001')], contacts);
  assert.equal(run.lines[0].reference, run.lines[1].reference);
  assert.equal(findDuplicates(run.lines.map(l => ({ company: 'x', line: l }))).length, 1);
});
test('the Metro summary shows whether a name was cut, has no recipient type, and never shows names or numbers', () => {
  const contacts = [{ contactId: 'c1', name: 'Nationwide Cleaning', bankAccountDetails: '01234501234567', batchPayments: { BankAccountNumber: '01234567', BankAccountName: 'Nationwide Cleaning Solutions Ltd' } },
    { contactId: 'c2', name: 'Short', bankAccountDetails: '01234501234568', batchPayments: { BankAccountNumber: '01234568', BankAccountName: 'Short Ltd' } }];
  const bills = [{ number: 'I1', contactId: 'c1', contactName: 'N', amountDue: 10, dueDate: null, currency: 'GBP' }, { number: 'I2', contactId: 'c2', contactName: 'S', amountDue: 20, dueDate: null, currency: 'GBP' }];
  const s = summarise(buildPayRun(bills, contacts), 'metro');
  assert.deepEqual(s.lines.map(l => [l.invoice, l.name_shortened]), [['I1', true], ['I2', false]]);
  const json = JSON.stringify(s);
  assert.equal(/recipient_type/.test(json), false);
  assert.equal(/0123450|01234567|012345|Nationwide Cleaning Solutions/.test(json), false);
  assert.equal(/recipient_type/.test(JSON.stringify(summarise(buildPayRun(bills, contacts), 'revolut'))), true);
});

// ---- debit accounts: set in Railway, never in the repository ----
test('debit accounts are parsed from the Railway variable as 8-digit text; leading zeros survive', () => {
  assert.deepEqual(parseDebitAccounts('{"st-georges":"01234567","lamberhurst":"07654321"}'), { 'st-georges': '01234567', lamberhurst: '07654321' });
  assert.deepEqual(parseDebitAccounts(undefined), {});
  assert.deepEqual(parseDebitAccounts('  '), {});
  assert.equal(debitAccountFor('lamberhurst', '{"st-georges":"01234567"}'), null);
  assert.equal(debitAccountFor('st-georges', '{"st-georges":"01234567"}'), '01234567');
});
test('bad debit account settings are refused, and an error message never contains an account number', () => {
  const bad = ['{"st-georges":1234567}', '{"st-georges":"1234567"}', '{"st-georges":"012345678"}', '{"st-georges":"0123456a"}', '[]', 'not json', '{"Bad Key":"01234567"}'];
  for (const raw of bad) {
    assert.throws(() => parseDebitAccounts(raw), (e) => !/\d{7,}/.test(e.message), raw);
  }
  assert.throws(() => parseDebitAccounts('{"st-georges":"01234567x"}'), /exactly 8 digits/);
});
test('no account number is kept in the repository config: debit accounts live only in the Railway variable', () => {
  const json = readFileSync(new URL('../config/companies.json', import.meta.url), 'utf8');
  assert.equal(/"\d{8}"/.test(json), false);
  assert.equal(/"debit/i.test(json), false);
});

// ---- which companies go in which file ----
const co = (key, inbox, tenant, extra = {}) => ({ key, name: key, frontInboxId: inbox, xeroTenantId: tenant, xeroTenantName: key, status: 'live', ...extra });
test('payBank: metro companies go into the consolidated file; a revolut company (AVL) does not; no payBank means no pay run', () => {
  _setCompaniesForTest(parseCompanies({ companies: [
    co('st-georges', 'inb_a', '45a1074b-b172-4f49-a192-f0a8e293b54d', { payBank: 'metro' }),
    co('lamberhurst', 'inb_b', '10ebb429-85ae-46e6-9ab3-ae6eed636af1', { payBank: 'metro' }),
    co('avl', 'inb_c', '11111111-2222-4333-8444-555555555555', { payBank: 'revolut' }),
    co('other', 'inb_d', '22222222-3333-4444-8555-666666666666'),
    co('offline', 'inb_e', null, { status: 'off', xeroTenantName: null, payBank: 'metro' }),
  ] }));
  assert.deepEqual(metroPayRunCompanies().map(c => c.key), ['st-georges', 'lamberhurst']);
  assert.equal(loadCompanies().find(c => c.key === 'avl').payBank, 'revolut');
  assert.equal(loadCompanies().find(c => c.key === 'other').payBank, null);
  assert.throws(() => parseCompanies({ companies: [co('xx', 'inb_a', '45a1074b-b172-4f49-a192-f0a8e293b54d', { payBank: 'paypal' })] }), /payBank/);
  _setCompaniesForTest(null);
});
test('the shipped registry puts all the live practices on Metro', () => {
  _setCompaniesForTest(null);
  assert.deepEqual(metroPayRunCompanies().map(c => c.key).sort(), ['castletown', 'lamberhurst', 'st-georges']);
});

// ---- file names: Metro's upload rejects anything but letters, digits, space and ( ) + , . _ ----
import { payRunFileName, METRO_FILE_NAME } from '../dist/pay-run.js';
test('the file name that Metro rejected used hyphens; the new names never do', () => {
  assert.equal(METRO_FILE_NAME.test('pay-run-metro-group-2026-11-20 (1).csv'), false); // what failed on 2026-11-20
  assert.equal(METRO_FILE_NAME.test('pay_run_metro_group_2026_11_20_1235 (1).csv'), true); // fine even with the browser's (1) suffix
});
test('consolidated Metro file: underscores only, London date and time so each file name is unique', () => {
  const n = payRunFileName({ consolidated: true, bank: 'metro', londonDate: '2026-11-20', londonTime: '14:31' });
  assert.equal(n, 'pay_run_metro_group_2026_11_20_1431.csv');
  assert.match(n, METRO_FILE_NAME);
  assert.notEqual(n, payRunFileName({ consolidated: true, bank: 'metro', londonDate: '2026-11-20', londonTime: '14:32' }));
});
test('a single company file turns its key into underscores too; both banks get safe names', () => {
  assert.equal(payRunFileName({ consolidated: false, bank: 'metro', companyKey: 'st-georges', londonDate: '2026-12-07', londonTime: '09:05' }), 'pay_run_st_georges_metro_2026_12_07_0905.csv');
  assert.equal(payRunFileName({ consolidated: false, bank: 'revolut', companyKey: 'avl', londonDate: '2026-12-07', londonTime: '09:05' }), 'pay_run_avl_revolut_2026_12_07_0905.csv');
  for (const key of ['st-georges', 'lamberhurst', 'avl', 'a-b-c']) assert.match(payRunFileName({ consolidated: false, bank: 'metro', companyKey: key, londonDate: '2026-01-02', londonTime: '00:00' }), METRO_FILE_NAME);
});

// ---- Castletown joins as a dry run, with no pay run bank until its debit account exists ----
test('Castletown is registered live and pays through Metro: it is in the consolidated file with the other two practices', () => {
  _setCompaniesForTest(null);
  const castletown = loadCompanies().find(c => c.key === 'castletown');
  assert.equal(castletown.frontInboxId, 'inb_d42c6');
  assert.equal(castletown.xeroTenantName, 'Castletown Medical');
  assert.equal(castletown.status, 'live');
  assert.equal(castletown.payBank, 'metro');
  assert.deepEqual(metroPayRunCompanies().map(c => c.key).sort(), ['castletown', 'lamberhurst', 'st-georges']);
});
