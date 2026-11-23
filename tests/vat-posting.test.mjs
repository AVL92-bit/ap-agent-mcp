import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planVatPosting, vatRowsFromExtraction, latestHistoryTaxTypes, taxRatesFromXero, vatLineItems, VatReviewError, NO_HISTORY_NOTE } from '../dist/vat-posting.js';
import { vatPolicyForInbox } from '../dist/inbox-vat-policy.js';

const rates = taxRatesFromXero([
  { Name: '20% (VAT on Expenses)', TaxType: 'INPUT2', Status: 'ACTIVE', CanApplyToExpenses: true, EffectiveRate: 20 },
  { Name: '5% (VAT on Expenses)', TaxType: 'INPUT5', Status: 'ACTIVE', CanApplyToExpenses: true, EffectiveRate: 5 },
  { Name: 'Zero Rated Expenses', TaxType: 'ZERORATEDINPUT', Status: 'ACTIVE', CanApplyToExpenses: true, EffectiveRate: 0 },
  { Name: 'Exempt Expenses', TaxType: 'EXEMPTINPUT', Status: 'ACTIVE', CanApplyToExpenses: true, EffectiveRate: 0 },
  { Name: 'No VAT', TaxType: 'NONE', Status: 'ACTIVE', CanApplyToExpenses: true, EffectiveRate: 0 },
  { Name: 'Reverse Charge Expenses (20%)', TaxType: 'RRINPUT', Status: 'ACTIVE', CanApplyToExpenses: true, EffectiveRate: 20 },
  { Name: '20% (VAT on Capital)', TaxType: 'CAPEXINPUT2', Status: 'ACTIVE', CanApplyToExpenses: true, EffectiveRate: 20 },
]);
const row = (label, rate, net, vat) => ({ label, rate, net, vat });
const plan = (rows, gross, history = []) => planVatPosting({ gross, rows, taxRates: rates, historyTaxTypes: history });

test('standard rate from the invoice, with history: net line, invoice VAT, no uncertainty note', () => {
  const p = plan([row('standard', 20, 100, 20)], 120, ['INPUT2']);
  assert.deepEqual(p.lines.map(l => [l.net, l.vat, l.taxType, l.reverseCharge]), [[100, 20, 'INPUT2', false]]);
  assert.deepEqual(p.notes, []);
});
test('no invoice history: still posted from the invoice, and the sheet note is exactly the agreed text', () => {
  const p = plan([row('standard', 20, 100, 20)], 120, []);
  assert.equal(p.lines[0].taxType, 'INPUT2');
  assert.deepEqual(p.notes, ['VAT uncertain due to no invoice history']);
  assert.equal(NO_HISTORY_NOTE, 'VAT uncertain due to no invoice history');
});
test('the capital and reverse charge 20% rates are never chosen for an ordinary 20% invoice', () => {
  assert.equal(plan([row('standard', null, 50, 10)], 60, []).lines[0].taxType, 'INPUT2');
});
test('mixed rates post one line per rate', () => {
  const p = plan([row('standard', 20, 100, 20), row('zero', 0, 40, 0), row('reduced', 5, 20, 1)], 181, ['INPUT2']);
  assert.deepEqual(p.lines.map(l => l.taxType), ['INPUT2', 'ZERORATEDINPUT', 'INPUT5']);
  assert.ok(p.notes.some(n => /differs from this supplier's previous invoice/.test(n)));
});
test('zero rated and exempt follow the invoice label; an unlabelled 0% follows history or is refused', () => {
  assert.equal(plan([row('exempt', 0, 30, 0)], 30, ['ZERORATEDINPUT']).lines[0].taxType, 'EXEMPTINPUT');
  assert.equal(plan([row('unknown', null, 30, 0)], 30, ['EXEMPTINPUT']).lines[0].taxType, 'EXEMPTINPUT');
  assert.throws(() => plan([row('unknown', null, 30, 0)], 30, []), VatReviewError);
});
test('reverse charge only when the supplier was reverse charged before and no VAT is charged', () => {
  const p = plan([row('unknown', null, 200, 0)], 200, ['RRINPUT']);
  assert.deepEqual(p.lines.map(l => [l.taxType, l.reverseCharge]), [['RRINPUT', true]]);
  assert.equal('TaxAmount' in vatLineItems(p, { description: 'd', accountCode: '400' })[0], false);
  assert.throws(() => plan([row('reverse_charge', null, 200, 0)], 200, ['INPUT2']), /no previous reverse charge/);
  assert.throws(() => plan([row('reverse_charge', null, 200, 0)], 200, []), VatReviewError);
  // history says reverse charge but the invoice now charges UK VAT: post what the invoice says
  assert.equal(plan([row('standard', 20, 100, 20)], 120, ['RRINPUT']).lines[0].taxType, 'INPUT2');
});
test('net plus VAT must equal the invoice total (1p tolerance); a larger gap is refused; the pence is carried', () => {
  assert.throws(() => plan([row('standard', 20, 100, 20)], 125, ['INPUT2']), /does not equal the invoice total/);
  const p = plan([row('standard', 20, 33.33, 6.67)], 40.01, ['INPUT2']);
  assert.equal(Math.round((p.lines[0].net + p.lines[0].vat) * 100), 4001);
});
test('a rate with no unique active Xero tax rate is refused rather than guessed', () => {
  assert.throws(() => plan([row('standard', 12.5, 100, 12.5)], 112.5, []), /will not choose/);
  const noExpense = taxRatesFromXero([{ Name: '20%', TaxType: 'A', Status: 'ACTIVE', CanApplyToExpenses: false, EffectiveRate: 20 }]);
  assert.throws(() => planVatPosting({ gross: 120, rows: [row('standard', 20, 100, 20)], taxRates: noExpense, historyTaxTypes: [] }), VatReviewError);
});
test('rows come from the printed breakdown, else from net and VAT totals, else the invoice is refused', () => {
  assert.equal(vatRowsFromExtraction({ breakdown: [row('standard', 20, 10, 2)] }).length, 1);
  assert.deepEqual(vatRowsFromExtraction({ breakdown: null, netTotal: 10, vatTotal: 2 }), [{ label: 'unknown', rate: null, net: 10, vat: 2 }]);
  assert.throws(() => vatRowsFromExtraction({ breakdown: [], netTotal: null, vatTotal: null }), VatReviewError);
});
test('history is the supplier\'s newest approved or paid bill only; drafts and other suppliers do not count', () => {
  const bills = [
    { Type: 'ACCPAY', Status: 'PAID', DateString: '2026-01-01', InvoiceID: 'a', Contact: { ContactID: 'c' }, LineItems: [{ TaxType: 'OLD' }] },
    { Type: 'ACCPAY', Status: 'AUTHORISED', DateString: '2026-03-01', InvoiceID: 'b', Contact: { ContactID: 'c' }, LineItems: [{ TaxType: 'INPUT2' }, { TaxType: 'INPUT2' }, { TaxType: 'ZERORATEDINPUT' }] },
    { Type: 'ACCPAY', Status: 'DRAFT', DateString: '2026-04-01', InvoiceID: 'd', Contact: { ContactID: 'c' }, LineItems: [{ TaxType: 'NONE' }] },
    { Type: 'ACCPAY', Status: 'PAID', DateString: '2026-05-01', InvoiceID: 'e', Contact: { ContactID: 'other' }, LineItems: [{ TaxType: 'NONE' }] },
  ];
  assert.deepEqual(latestHistoryTaxTypes(bills, 'c'), ['INPUT2', 'ZERORATEDINPUT']);
  assert.deepEqual(latestHistoryTaxTypes(bills, 'nobody'), []);
});
test('line items: net amount, tax type and the invoice VAT amount on each line', () => {
  const li = vatLineItems(plan([row('standard', 20, 100, 20)], 120, ['INPUT2']), { description: 'Service', accountCode: '410' });
  assert.deepEqual(li, [{ Description: 'Service', Quantity: 1, UnitAmount: 100, AccountCode: '410', TaxType: 'INPUT2', TaxAmount: 20 }]);
});

// ---- policy and wiring ----
test('the recoverable policy is accepted only in its exact form; "none" still works; anything else is blocked', () => {
  const cfg = JSON.parse(readFileSync(new URL('../config/coding-policies.json', import.meta.url), 'utf8'));
  assert.equal(vatPolicyForInbox('inb_bys7q').recoverInputVat, false);
  const src = readFileSync(new URL('../src/inbox-vat-policy.ts', import.meta.url), 'utf8');
  assert.match(src, /entry\.vat_recovery==='recoverable' && entry\.xero_purchase_tax_type==='FROM_INVOICE' && entry\.expense_amount_basis==='net_invoice_amount'/);
  assert.equal(JSON.stringify(cfg).includes('"recoverable"'), cfg.inbox_vat_policies.inb_debo6?.vat_recovery === 'recoverable');
});
test('the live port posts the plan for recovering inboxes, the gross for the others, and checks Xero\'s total', () => {
  const src = readFileSync(new URL('../src/ap-xero-live-port.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(policy\.recoverInputVat\)/);
  assert.match(src, /no VAT plan on the draft; nothing created/);
  assert.match(src, /Unexpected VAT plan for a non-recovering inbox/);
  assert.match(src, /command\.vatPlan && \(typeof created\.Total !== 'number'/);
});
test('the plan is built only for recovering inboxes and failures become Human review, never a guess', () => {
  const src = readFileSync(new URL('../src/ap-live-document-ports.ts', import.meta.url), 'utf8');
  assert.match(src, /vatPolicyForInbox\(company\.frontInboxId\)\.recoverInputVat/);
  assert.match(src, /new DocumentNeedsHumanReview\('unclear', `VAT not posted: /);
  assert.match(src, /command\.reviewNotes = \[\.\.\.\(command\.reviewNotes \?\? \[\]\), \.\.\.plan\.notes\]/);
});
