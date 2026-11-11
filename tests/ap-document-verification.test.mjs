import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyInvoiceDocumentText,DocumentNeedsHumanReview} from '../dist/ap-document-verification.js';
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
