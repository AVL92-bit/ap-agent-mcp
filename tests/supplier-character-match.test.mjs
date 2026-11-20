import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseSupplier, characterScore, CHARACTER_MATCH_THRESHOLD } from '../dist/ap-best-candidate-selection.js';
import { buildDraftFromAvailableCandidates } from '../dist/ap-draft-candidate-command.js';
import { extractInvoiceCandidates } from '../dist/invoice-candidates.js';

const c = (id, name) => ({ id, name });

test('the threshold is 50%, strictly over, on characters', () => {
  assert.equal(CHARACTER_MATCH_THRESHOLD, 0.5);
});
test('"Focus 4 U Ltd" now matches "Focus House (DD)": over 50% on characters, and marked uncertain for finance', () => {
  const r = chooseSupplier('Focus 4 U Ltd', [c('1', 'Focus House (DD)'), c('2', 'Wavenet (DD)')]);
  assert.equal(r.value.id, '1');
  assert.ok(r.score > 0.5 && r.score < 1);
  assert.deepEqual(r.uncertainFields, ['supplier']);
  assert.match(r.explanation, /Character-similarity/);
});
test('a name that shares nothing meaningful still finds no supplier (Clark & Hanson is genuinely missing)', () => {
  const contacts = [c('1', 'Focus House (DD)'), c('2', 'Wavenet (DD)'), c('3', 'Henry Schein'), c('4', 'British Gas (DD)')];
  assert.equal(chooseSupplier('Clark & Hanson Construction Services Ltd', contacts), null);
});
test('the word rule is unchanged and takes priority: same matches, same scores, same certainty as before', () => {
  const contacts = [c('1', 'Henry Schein'), c('2', 'Focus House (DD)')];
  const r = chooseSupplier('Henry Schein Medical', contacts);
  assert.equal(r.value.id, '1');
  assert.equal(r.score, 2 / 3);
  assert.deepEqual(r.uncertainFields, []);                                  // unique containment: still certain
  assert.deepEqual(chooseSupplier('Wavenet Limited', [c('9', 'Wavenet (DD)')]).uncertainFields, []);
  assert.equal(chooseSupplier('Wavenet Limited', [c('9', 'Wavenet (DD)')]).score, 1);
});
test('a word match beats a better-looking character match (the word rule is tried first)', () => {
  const r = chooseSupplier('Focus Business Services', [c('1', 'Focus Business Group'), c('2', 'Focus Business Services Ltd')]);
  assert.equal(r.value.id, '2');
});
test('boundary: a score of exactly 50% does not match; very short names never match on characters', () => {
  assert.equal(characterScore('abcd', 'abcd'), 1);
  assert.equal(characterScore('ab', 'ac'), 0);                              // too short to compare
  assert.equal(characterScore('', 'Focus House'), 0);
  // "abcd" vs "abxy": pairs ab,bc,cd vs ab,bx,xy -> shared 1, total 6 -> 0.333; "abcde" vs "abcxy": ab,bc,cd,de vs ab,bc,cx,xy -> 4/... = 0.5 exactly
  assert.equal(characterScore('abcde', 'abcxy'), 0.5);
  assert.equal(chooseSupplier('abcde', [c('1', 'abcxy')]), null);
});
test('real regression: across 27 real supplier names, only variants of the SAME supplier match each other', () => {
  const names = ['Bison Assist Ltd','City Gas & Heating Services','Henry Schein','iGPR Technologies Limited','JP Medassist','Nationwide Cleaning Solutions Ltd',
    'Quills Office Supplies Ltd','Seqirus UK Ltd','AMS Accountants (DD)','Aquacool Limited (DD)','Aventis Pharma/ Sanofi (DD)','British Gas (DD)','Lantum (DD)',
    'Modulr (DD)','Tom White (DD)','Wavenet (DD)','Healthtech-1 (DD)','Focus House (DD)','Water Plus','Siemens Financial','Alliance Healthcare','Medisave',
    'Clark & Hanson Construction Services Ltd','Wavenet Limited','Healthtech 1','Henry Schein Medical','Water Plus Group Limited'];
  const sameSupplier = new Set(['Wavenet (DD)|Wavenet Limited', 'Healthtech-1 (DD)|Healthtech 1', 'Water Plus|Water Plus Group Limited', 'Henry Schein|Henry Schein Medical']);
  const hits = [];
  for (let i = 0; i < names.length; i++) for (let j = 0; j < names.length; j++) {
    if (i === j) continue;
    if (chooseSupplier(names[i], [c('x', names[j])])) hits.push([names[i], names[j]].sort().join('|'));
  }
  for (const h of new Set(hits)) assert.ok(sameSupplier.has(h) || sameSupplier.has(h.split('|').reverse().join('|')), `unexpected match: ${h}`);
});
test('end to end: a Focus 4 U Ltd invoice is drafted against Focus House (DD) with the supplier flagged for review', async () => {
  const pdf = { filename: 'a.pdf', contentType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-example') };
  const candidates = extractInvoiceCandidates('Invoice\nSupplier: Focus 4 U Ltd\nInvoice No: 11350055\nTotal Due: £18.85');
  const accounts = [{ code: '449', name: 'Telephone', type: 'EXPENSE', status: 'ACTIVE' }];
  const command = await buildDraftFromAvailableCandidates({ candidates, contacts: [{ id: 'c-focus', name: 'Focus House (DD)', defaultPurchaseCode: '449' }], accounts, pdf });
  assert.equal(command.supplierContactId, 'c-focus');
  assert.equal(command.supplierName, 'Focus House (DD)');
  assert.ok(command.uncertainFields.includes('supplier'));
});
test('an invoice from a genuinely unknown supplier still asks for the supplier to be created', async () => {
  const pdf = { filename: 'a.pdf', contentType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-example') };
  const candidates = extractInvoiceCandidates('Invoice\nSupplier: Clark & Hanson Construction Services Ltd\nInvoice No: INV-0234\nTotal Due: £1824.00');
  await assert.rejects(() => buildDraftFromAvailableCandidates({ candidates, contacts: [c('1', 'Focus House (DD)'), c('2', 'Wavenet (DD)')], accounts: [], pdf }), /not in Xero/);
});
