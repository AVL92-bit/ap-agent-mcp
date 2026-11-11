import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyInvoiceDocumentText,DocumentNeedsHumanReview,requireVerifiedCriticalFields} from '../dist/ap-document-verification.js';
import {extractInvoiceCandidates} from '../dist/invoice-candidates.js';
import {runApInbox} from '../dist/ap-inbox-runner.js';

test('non-invoice letter is rejected without invoice evidence',()=>{
  assert.throws(()=>verifyInvoiceDocumentText('Dear team, this letter confirms the account address.'),e=>e instanceof DocumentNeedsHumanReview&&e.kind==='not_invoice');
});
test('invoice keyword alone is not enough',()=>{
  assert.throws(()=>verifyInvoiceDocumentText('Please find invoice attached.'),e=>e instanceof DocumentNeedsHumanReview&&e.kind==='unclear');
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
  assert.throws(()=>verifyInvoiceDocumentText(body),e=>e instanceof DocumentNeedsHumanReview&&e.kind==='not_invoice');
});
test('ordinary Healthtech invoice with payable total still passes evidence gate',()=>{
  assert.doesNotThrow(()=>verifyInvoiceDocumentText('Invoice\nHealthtech 1\nInvoice Number: HT1-35587\nTotal Due: £771.12'));
});
test('Water Plus carried-forward credit permits draft with explicitly labelled period charges',()=>{
  const body='Summary of Charges: invoice wp-INV13861043\nInvoice Number: wp-INV13861043\nTotal Due: £48.67\nCredit brought forward £59.27\nAccount balance -£10.60';
  assert.throws(()=>verifyInvoiceDocumentText(body),e=>e instanceof DocumentNeedsHumanReview&&e.kind==='unclear');
});
test('conflicting receipt and invoice headings require human review',()=>{
  assert.throws(()=>verifyInvoiceDocumentText('Receipt\nInvoice Number: HT1-35587\nInvoice\nTotal Due: £771.12'),e=>e instanceof DocumentNeedsHumanReview&&e.kind==='unclear');
});
test('Bison tax invoice with ordinary total remains eligible for subsequent checks',()=>{
  assert.doesNotThrow(()=>verifyInvoiceDocumentText('Tax Invoice\nInvoice Number: INV/38652\nTotal Due: £420.00'));
});

test('missing PDF supplier does not by itself block Xero contact matching',()=>{
  const candidates={supplier:null,reference:{uncertain:false},grossAmount:{uncertain:false},documentType:{uncertain:false},currency:{uncertain:false},uncertainFields:['supplier']};
  assert.doesNotThrow(()=>requireVerifiedCriticalFields(candidates));
});
test('uncertain gross amount blocks Xero access rather than creating a draft',()=>{
  const candidates={supplier:{uncertain:false},reference:{uncertain:false},grossAmount:{uncertain:true},documentType:{uncertain:false},currency:{uncertain:false},uncertainFields:['grossAmount']};
  assert.throws(()=>requireVerifiedCriticalFields(candidates),e=>e instanceof DocumentNeedsHumanReview&&e.kind==='unclear'&&/grossAmount/.test(e.message));
});
test('verified critical PDF fields pass the Xero preflight guard',()=>{
  const certain={uncertain:false};
  assert.doesNotThrow(()=>requireVerifiedCriticalFields({supplier:certain,reference:certain,grossAmount:certain,documentType:certain,currency:certain,uncertainFields:[]}));
});

test('credit balance without explicit period charges remains blocked',()=>{
 const body='Invoice\\nInvoice Number: INV-1\\nTotal amount -£10.60\\nCredit brought forward £59.27';
 assert.throws(()=>verifyInvoiceDocumentText(body),e=>e instanceof DocumentNeedsHumanReview&&e.kind==='unclear');
});
