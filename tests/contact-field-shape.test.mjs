import test from 'node:test';
import assert from 'node:assert/strict';
import { describeContactFields, maskDigits } from '../dist/contact-field-shape.js';

test('digits are always masked, so a sort code or account number can never appear', () => {
  assert.equal(maskDigits('12-34-56 12345678'), '##-##-## ########');
  const out = describeContactFields({ Name: 'JP Medassist Ltd', BankAccountDetails: '12345612345678', AccountNumber: 'ACC-0042' });
  assert.equal(out.BankAccountDetails, '##############');
  assert.equal(out.AccountNumber, 'ACC-####');
  assert.equal(out.Name, 'JP Medassist Ltd');
});
test('only allowlisted fields show a value; everything else reports presence only', () => {
  const out = describeContactFields({ EmailAddress: 'a@b.com', TaxNumber: '123456789', Website: '', Phones: [{}, {}], Addresses: [], BankAccountName: 'JP Medassist Ltd', Extra: { a: 1, b: 2 } });
  assert.equal(out.EmailAddress, 'present');
  assert.equal(out.TaxNumber, 'present');
  assert.equal(out.Website, 'empty');
  assert.equal(out.Phones, 'present (2 items)');
  assert.equal(out.Addresses, 'empty');
  assert.equal(out.BankAccountName, 'present'); // key name is visible, which is what we need to know
  assert.equal(out.Extra, 'present (object with keys: a, b)');
  assert.equal(JSON.stringify(out).includes('a@b.com'), false);
  assert.equal(JSON.stringify(out).includes('123456789'), false);
});
test('the tool is read-only: only a GET to Contacts and no write methods', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('"inspect_contact_bank_fields"'), src.indexOf('"get_scheduled_run_history"'));
  assert.match(block, /api\.xero\.com\/api\.xro\/2\.0\/Contacts\?searchTerm=/);
  assert.equal(/method:\s*["'](POST|PUT|DELETE|PATCH)/i.test(block), false);
});
