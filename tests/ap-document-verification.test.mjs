import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyInvoiceDocumentText,DocumentNeedsHumanReview} from '../dist/ap-document-verification.js';
import {extractInvoiceCandidates} from '../dist/invoice-candidates.js';
import {runApInbox} from '../dist/ap-inbox-runner.js';

test('non-invoice letter is rejected without invoice evidence',()=>{
  assert.throws(()=>verifyInvoiceDocumentText('Dear team, this letter confirms the account address.'),e=>e instanceof DocumentNeedsHumanReview&&e.kind==='not_invoice');
});
test('invoice keyword alone passes the text check; a missing gross amount is the blocker later',()=>{
  assert.doesNotThrow(()=>verifyInvoiceDocumentText('Please find invoice attached.'));
});
test('invoice body with reference and total can proceed to further checks',()=>{
  assert.doesNotThrow(()=>verifyInvoiceDocumentText('Invoice Number: INV-123\nTotal Due: £120.00'));
});
test('review-only document does not invoke Xero or journal and remains open',async()=>{
  const actions=[];
  const port={
    listAllOpenConversations:async()=>[{id:'cnv_test',subject:'Account letter',body:'Please see attached',attachments:[{id:'fil_test',messageId:'msg_test',filename:'letter.pdf'}]}],
    makeDraftCommand:async()=>{throw new DocumentNeedsHumanReview('not_invoice','Account letter, not an invoice');},
    applyTag:async(id,tag)=>actions.push(['tag',tag]),
    archive:async()=>{throw new Error('MUST NOT ARCHIVE');},
    reportReview:async(row)=>actions.push(['sheet',row.outcome,row.filename]),
    journal:{begin:async()=>{throw new Error('MUST NOT JOURNAL');},complete:async()=>{throw new Error('MUST NOT JOURNAL');}}
  };
  const xero=new Proxy({}, {get:()=>()=>{throw new Error('MUST NOT CALL XERO');}});
  const report=await runApInbox(port,xero);
  assert.deepEqual(actions,[['sheet','not_invoice','letter.pdf'],['tag','Human review']]);
  assert.equal(report.archived,0);
});

test('Healthtech payment receipt referencing an invoice cannot pass the evidence gate',()=>{
  const body='Receipt\nHealthtech 1\nReceipt Number: 2874-6222\nPaid by Bacs Direct Debit\nInvoice Number: HT1-35587\nTotal Due: £771.12';
  assert.throws(()=>verifyInvoiceDocumentText(body),e=>e instanceof DocumentNeedsHumanReview&&e.kind==='supporting_document');
});
test('ordinary Healthtech invoice with payable total still passes evidence gate',()=>{
  assert.doesNotThrow(()=>verifyInvoiceDocumentText('Invoice\nHealthtech 1\nInvoice Number: HT1-35587\nTotal Due: £771.12'));
});
test('a credit or brought-forward balance never blocks: it is a review note',()=>{
  const body='Summary of Charges: invoice wp-INV13861043\nCurrent charges £48.67\nCredit brought forward £59.27\nAccount balance -£10.60';
  assert.doesNotThrow(()=>verifyInvoiceDocumentText(body));
});
test('receipt plus invoice headings: not treated as a receipt; extraction decides the type',()=>{
  assert.doesNotThrow(()=>verifyInvoiceDocumentText('Receipt\nInvoice Number: HT1-35587\nInvoice\nTotal Due: £771.12'));
});
test('Bison tax invoice with ordinary total remains eligible for subsequent checks',()=>{
  assert.doesNotThrow(()=>verifyInvoiceDocumentText('Tax Invoice\nInvoice Number: INV/38652\nTotal Due: £420.00'));
});



test('credit balance without explicit period charges is no longer a text-level block',()=>{
 const body='Invoice\\nInvoice Number: INV-1\\nTotal amount -£10.60\\nCredit brought forward £59.27';
 assert.doesNotThrow(()=>verifyInvoiceDocumentText(body));
});

test('a receipt is a supporting document, never an invoice', () => {
  assert.throws(() => verifyInvoiceDocumentText('Page 1 of 1\nReceipt\nInvoice number HT1-34156\nReceipt number 2439-6527\nAmount paid £667.92'),
    e => e instanceof DocumentNeedsHumanReview && e.kind === 'supporting_document');
});
