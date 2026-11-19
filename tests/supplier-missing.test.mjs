import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runApInbox } from '../dist/ap-inbox-runner.js';
import { DocumentNeedsHumanReview } from '../dist/ap-document-verification.js';
import { buildDraftFromAvailableCandidates } from '../dist/ap-draft-candidate-command.js';
import { extractInvoiceCandidates } from '../dist/invoice-candidates.js';

const pdf = { filename: 'Invoice INV-0234.pdf', contentType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-example') };
const field = (value) => ({ value, uncertain: false });

test('a genuine invoice from a supplier not in Xero: Human review tag, no archive, one Sheet row asking for the supplier to be created', async () => {
  const calls = [];
  const port = {
    listAllOpenConversations: async () => [{ id: 'cnv_a', subject: 'Fwd: Reception Works Invoice', body: '', attachments: [{ id: 'fil_a', filename: 'Invoice INV-0234.pdf', messageId: 'msg_a' }] }],
    makeDraftCommand: async () => { throw new DocumentNeedsHumanReview('supplier_missing', 'Supplier "Clark & Hanson Construction Services Ltd" is not in Xero'); },
    applyTag: async (id, tag) => calls.push(['tag', tag]), archive: async (id) => calls.push(['archive', id]),
    reportReview: async (row) => calls.push(['sheet', row.outcome, row.reason]),
  };
  const xero = { lookup: async () => { throw new Error('no Xero call expected'); }, createDraft: async () => { throw new Error('no draft expected'); } };
  const r = await runApInbox(port, xero);
  assert.equal(r.archived, 0);
  assert.deepEqual(calls.map(c => c.slice(0, 2)), [['sheet', 'supplier_missing'], ['tag', 'Human review']]);
  assert.match(calls[0][2], /Clark & Hanson Construction Services Ltd/);
});

test('the draft builder names the supplier it read, the invoice number and the amount, and creates nothing', async () => {
  const candidates = { supplier: field('Clark & Hanson Construction Services Ltd'), reference: field('INV-0234'), grossAmount: field('£1200.00'), documentType: field('invoice'), uncertainFields: [] };
  await assert.rejects(
    () => buildDraftFromAvailableCandidates({ candidates, contacts: [{ id: '1', name: 'Wavenet (DD)' }], accounts: [], pdf }),
    (e) => e instanceof DocumentNeedsHumanReview && e.kind === 'supplier_missing'
      && /Clark & Hanson Construction Services Ltd/.test(e.message) && /INV-0234/.test(e.message) && /1200.00/.test(e.message) && /create it/i.test(e.message));
});

test('a supplier that DOES match is unaffected (no supplier_missing)', async () => {
  const candidates = extractInvoiceCandidates('Invoice\nSupplier: Focus House Limited\nInvoice No: 11350055\nTotal Due: £50.00');
  const accounts = [{ code: '449', name: 'Telephone', type: 'OVERHEADS', status: 'ACTIVE' }];
  const command = await buildDraftFromAvailableCandidates({ candidates, contacts: [{ id: 'c1', name: 'Focus House (DD)', defaultPurchaseCode: '449' }], accounts, pdf });
  assert.equal(command.supplierName, 'Focus House (DD)');
});

test('the Sheet labels the new outcome so finance sees what to do', () => {
  const s = readFileSync(new URL('../src/google-sheets-review.ts', import.meta.url), 'utf8');
  assert.match(s, /'Supplier not in Xero'/);
  assert.match(s, /'Create supplier in Xero'/);
});
