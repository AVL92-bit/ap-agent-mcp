import test from 'node:test';
import assert from 'node:assert/strict';
const { extractInvoiceFields, extractFieldsWithModel, isoDate } = await import(new URL('../dist/model-extraction.js', import.meta.url));

const fields = (over = {}) => ({ document_type: 'invoice', supplier_name: 'Healthtech 1', supplier_evidence: 'Healthtech 1 / 91 Belmont Hill',
  invoice_number: 'HT1-34156', invoice_number_evidence: 'Invoice number HT1-34156', invoice_date: '2026-10-01', due_date: '2026-10-01',
  gross_total: 667.92, gross_evidence: 'Amount due £667.92', net_total: 556.6, vat_total: 111.32, currency: 'GBP', account_balance: null,
  billed_to: 'St Georges Road Surgery', low_confidence_fields: [], notes: null, ...over });
const fakeFetch = (f, capture = {}) => async (url, init) => { capture.url = url; capture.body = JSON.parse(init.body); capture.headers = init.headers;
  return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(f) }] }) }; };
const healthtech = 'Invoice\nInvoice number HT1\u000034156\nDate of issue October 1, 2026\nDate due October 1, 2026\nHealthtech 1\n91 Belmont Hill\nLondon\nSE13 5AX\nBill to\nSt Georges Road Surgery\nAmount due £667.92';

test('without an API key the text rules are used and that is noted', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const r = await extractInvoiceFields({ text: healthtech, filename: 'x.pdf' });
  assert.equal(r.source, 'text');
  assert.match(r.notes[0], /no ANTHROPIC_API_KEY/);
});
test('model and text rules agree: fields become confident (damaged dash confirmed)', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const cap = {};
  const r = await extractInvoiceFields({ text: healthtech, pdf: new Uint8Array([37, 80, 68, 70, 45]), filename: 'x.pdf' }, fakeFetch(fields(), cap));
  assert.equal(r.source, 'model+text');
  assert.equal(cap.body.model, 'claude-sonnet-5-5');
  assert.equal(cap.body.messages[0].content[0].type, 'document');
  assert.equal(cap.headers['x-api-key'], 'test-key');
  assert.equal(cap.body.output_config.format.type, 'json_schema'); assert.equal(cap.body.tool_choice, undefined);
  assert.equal(r.candidates.reference.value, 'HT1-34156'); assert.equal(r.candidates.reference.uncertain, false);
  assert.equal(r.candidates.invoiceDate.value, '2026-10-01'); assert.equal(r.candidates.invoiceDate.uncertain, false);
  assert.equal(r.candidates.grossAmount.value, '£667.92'); assert.equal(r.candidates.grossAmount.uncertain, false);
  assert.deepEqual(r.notes, []);
});
test('disagreement is a note and the field is uncertain, never a block', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const r = await extractInvoiceFields({ text: healthtech, filename: 'x.pdf' }, fakeFetch(fields({ gross_total: 556.6 })));
  assert.equal(r.candidates.grossAmount.value, '£556.60'); assert.equal(r.candidates.grossAmount.uncertain, true);
  assert.ok(r.notes.some(n => /Gross total: model read "£556.60", text rules read "£667.92"/.test(n)));
});
test('table layouts: model supplies what the text rules cannot', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const r = await extractInvoiceFields({ text: 'Invoice\nInvoice Date\nTotal Invoice\n1633437\n£172.81', filename: 'x.pdf' },
    fakeFetch(fields({ supplier_name: 'Wavenet Ltd', invoice_number: '1633437', gross_total: 172.81, invoice_date: '2026-11-01' })));
  assert.equal(r.candidates.reference.value, '1633437'); assert.equal(r.candidates.grossAmount.value, '£172.81');
});
test('an account balance keeps gross as this period charges and flags it', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const r = await extractInvoiceFields({ text: 'Invoice wp-INV1\nTotal charges for this period £48.67\nTotal amount -£10.60', filename: 'x.pdf' },
    fakeFetch(fields({ supplier_name: 'Water Plus Limited', invoice_number: 'wp-INV1', gross_total: 48.67, account_balance: -10.6 })));
  assert.equal(r.candidates.grossAmount.value, '£48.67'); assert.equal(r.candidates.grossAmount.uncertain, true);
  assert.equal(r.candidates.accountBalance.value, '-£10.60');
});
test('the practice is never accepted as the supplier', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const r = await extractInvoiceFields({ text: 'Invoice No: A1\nTotal Due: £1.00', filename: 'x.pdf' }, fakeFetch(fields({ supplier_name: "St George's Road Surgery" })));
  assert.equal(r.candidates.supplier, null);
});
test('API failure falls back to text rules with a note', async () => {
  process.env.ANTHROPIC_API_KEY = 'bad';
  const r = await extractFieldsWithModel({ text: 'x', filename: 'x.pdf' }, async () => ({ ok: false, status: 401, text: async () => 'invalid x-api-key' }));
  assert.equal(r.ok, false); assert.match(r.reason, /HTTP 401, API key rejected/);
});
test('text-rule date styles normalise to ISO', () => {
  assert.equal(isoDate('October 1, 2026'), '2026-10-01');
  assert.equal(isoDate('03 November 2026'), '2026-11-03');
  assert.equal(isoDate('3rd November 2026'), '2026-11-03');
  assert.equal(isoDate('07/10/26'), '2026-10-07');
});

test('Anthropic error type and message are reported (e.g. low credit balance)', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  const r = await extractFieldsWithModel({ text: 'x', filename: 'x.pdf' }, async () => ({ ok: false, status: 400,
    text: async () => JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }) }));
  assert.match(r.reason, /HTTP 400, invalid_request_error: Your credit balance is too low/);
});

import { mergeModelAndText as mergeForAccount } from '../dist/model-extraction.js';
import { extractInvoiceCandidates as textForAccount } from '../dist/invoice-candidates.js';
test('customer account number from the model is carried through the merge', () => {
  const fields = { document_type:'invoice', supplier_name:'Wavenet Ltd', supplier_evidence:'Wavenet Ltd', invoice_number:'1576614', invoice_number_evidence:'1576614',
    invoice_date:'2026-07-01', due_date:null, gross_total:235.81, gross_evidence:'235.81', net_total:null, vat_total:null, currency:'GBP', account_balance:null,
    billed_to:null, customer_account_number:'XLS000708', low_confidence_fields:[], notes:null };
  const merged = mergeForAccount(textForAccount('Wavenet Ltd\nInvoice 1576614\nTotal £235.81'), { ok:true, fields, model:'m' });
  assert.equal(merged.customerAccountNumber, 'XLS000708');
});
