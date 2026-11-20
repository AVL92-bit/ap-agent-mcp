import test from 'node:test';
import assert from 'node:assert/strict';
import { aliasContact, parseSupplierAliases, loadSupplierAliases } from '../dist/supplier-aliases.js';
import { chooseSupplier } from '../dist/ap-best-candidate-selection.js';
import { buildDraftFromAvailableCandidates } from '../dist/ap-draft-candidate-command.js';
import { extractInvoiceCandidates } from '../dist/invoice-candidates.js';

const contacts = [{ id: 'c-focus', name: 'Focus House (DD)', defaultPurchaseCode: '449' }, { id: 'c-wave', name: 'Wavenet (DD)' }];
const aliases = { 'Focus 4 U Ltd': 'Focus House (DD)' };

test('the problem the alias solves: without it, "Focus 4 U Ltd" does not match "Focus House (DD)"', () => {
  assert.equal(chooseSupplier('Focus 4 U Ltd', contacts), null);
});
test('a bill from the aliased name uses the named Xero contact, ignoring case, punctuation and Ltd/Limited', () => {
  for (const name of ['Focus 4 U Ltd', 'FOCUS 4 U LIMITED', 'focus 4 u', 'Focus 4-U Ltd.', 'Focus 4 U Limited']) {
    assert.equal(aliasContact(name, contacts, aliases)?.id, 'c-focus', name);
  }
});
test('only an exact alias applies: similar or unrelated names are not hijacked', () => {
  for (const name of ['Focus House', 'Focus 4 U Group Ltd', 'Focus', 'Wavenet Ltd', '']) assert.equal(aliasContact(name, contacts, aliases), null, name);
});
test('the alias does nothing if the named Xero contact does not exist in this organisation (no contact is ever created)', () => {
  assert.equal(aliasContact('Focus 4 U Ltd', [{ id: 'c-wave', name: 'Wavenet (DD)' }], aliases), null);
  assert.equal(aliasContact('Focus 4 U Ltd', [], aliases), null);
});
test('the target must match the Xero contact name exactly (ignoring case and punctuation), not just resemble it', () => {
  assert.equal(aliasContact('Focus 4 U Ltd', [{ id: 'x', name: 'Focus House' }], aliases), null);
  assert.equal(aliasContact('Focus 4 U Ltd', [{ id: 'x', name: 'focus house (dd)' }], aliases)?.id, 'x');
});
test('config parsing ignores malformed entries and never throws', () => {
  assert.deepEqual(parseSupplierAliases({}), {});
  assert.deepEqual(parseSupplierAliases({ aliases: [] }), {});
  assert.deepEqual(parseSupplierAliases({ aliases: { 'A': 'B', 'Good Name Ltd': 'Good Contact', 'Bad': 5 } }), { 'Good Name Ltd': 'Good Contact' });
});
test('the shipped config maps Focus 4 U Ltd to Focus House (DD)', () => {
  assert.equal(loadSupplierAliases()['Focus 4 U Ltd'], 'Focus House (DD)');
});
test('end to end: a Focus 4 U Ltd invoice is drafted against Focus House (DD), certain, using that contact\'s coding', async () => {
  const pdf = { filename: 'a.pdf', contentType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-example') };
  const candidates = extractInvoiceCandidates('Invoice\nSupplier: Focus 4 U Ltd\nInvoice No: 11350055\nTotal Due: £18.85');
  const accounts = [{ code: '449', name: 'Telephone', type: 'EXPENSE', status: 'ACTIVE' }];
  const command = await buildDraftFromAvailableCandidates({ candidates, contacts, accounts, pdf });
  assert.equal(command.supplierContactId, 'c-focus');
  assert.equal(command.supplierName, 'Focus House (DD)');
  assert.equal(command.supplierMatchScore, 1);
  assert.equal(command.uncertainFields.includes('supplier'), false);
});
test('an invoice from a genuinely unknown supplier still asks for the supplier to be created', async () => {
  const pdf = { filename: 'a.pdf', contentType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-example') };
  const candidates = extractInvoiceCandidates('Invoice\nSupplier: Clark & Hanson Construction Services Ltd\nInvoice No: INV-0234\nTotal Due: £1824.00');
  await assert.rejects(() => buildDraftFromAvailableCandidates({ candidates, contacts, accounts: [], pdf }), /not in Xero/);
});
