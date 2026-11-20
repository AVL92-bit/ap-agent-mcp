import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseAccount, isPrepaymentAccount, POSTABLE_EXPENSE_TYPES } from '../dist/ap-best-candidate-selection.js';

const acct = (code, type, name = `Account ${code}`, status = 'ACTIVE') => ({ code, name, type, status });
const chart = [
  acct('449', 'EXPENSE', 'Expenses'),
  acct('620', 'CURRENT', 'Prepayments'),               // Xero's default chart: current asset named Prepayments
  acct('621', 'PREPAYMENT', 'Insurance paid in advance'), // Xero's PREPAYMENT type
  acct('630', 'CURRENT', 'Debtors'),
  acct('622', 'CURRENT', 'Old Prepayments', 'ARCHIVED'),
];

test('only expense account types are postable by default: an allowlist using Xero\'s real type names', () => {
  assert.deepEqual([...POSTABLE_EXPENSE_TYPES].sort(), ['DIRECTCOSTS', 'EXPENSE', 'OVERHEADS']);
  for (const type of ['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS']) assert.equal(chooseAccount([acct('1', type)], '1').value.code, '1', type);
});
test('every other Xero account type is blocked, from history and from a contact default (a human is needed)', () => {
  const blocked = ['BANK', 'CURRENT', 'CURRLIAB', 'LIABILITY', 'TERMLIAB', 'NONCURRENT', 'FIXED', 'DEPRECIATN', 'WAGESEXPENSE',
    'INVENTORY', 'SALES', 'REVENUE', 'OTHERINCOME', 'EQUITY', 'PAYGLIABILITY', 'SUPERANNUATIONEXPENSE', 'SUPERANNUATIONLIABILITY'];
  for (const type of blocked) {
    assert.equal(chooseAccount([acct('1', type, 'Some account')], '1'), null, `${type} from history`);
    assert.equal(chooseAccount([acct('1', type, 'Some account')], undefined, '1'), null, `${type} from contact default`);
  }
});
test('which accounts count as prepayment accounts', () => {
  assert.equal(isPrepaymentAccount(chart[1]), true);   // current asset named Prepayments
  assert.equal(isPrepaymentAccount(chart[2]), true);   // PREPAYMENT type
  assert.equal(isPrepaymentAccount(chart[3]), false);  // another current asset
  assert.equal(isPrepaymentAccount(chart[0]), false);
  assert.equal(isPrepaymentAccount(acct('7', 'CURRLIAB', 'Prepayments received')), false); // wrong type, name alone is not enough
});
test('a supplier whose previous invoice was posted to a prepayment account is posted there again, with no uncertainty', () => {
  for (const code of ['620', '621']) {
    const x = chooseAccount(chart, code);
    assert.equal(x.value.code, code);
    assert.deepEqual(x.uncertainFields, []);
  }
});
test('other current assets stay blocked even from history; archived prepayment accounts are never used', () => {
  assert.equal(chooseAccount(chart, '630'), null);
  assert.equal(chooseAccount(chart, '622'), null);
});
test('prepayments are followed only from the supplier\'s history: never from a contact default or as a generic fallback', () => {
  assert.equal(chooseAccount(chart, undefined, '620'), null);
  assert.equal(chooseAccount(chart), null);
  assert.equal(chooseAccount(chart, '449').value.code, '449');
});
