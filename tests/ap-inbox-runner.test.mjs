import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runApInbox } from '../dist/ap-inbox-runner.js';
const pdf = {filename:'a.pdf',contentType:'application/pdf',bytes:new TextEncoder().encode('%PDF-example')};
function fixture(conversations, uncertainFields=[]) {
  const calls=[];
  const port={listAllOpenConversations:async()=>conversations,makeDraftCommand:async(c,a)=>({kind:'Invoices',number:a.id,supplierContactId:'c',accountCode:'449',invoiceDate:'2026-11-09',dueDate:'2026-11-09',gross:12,pdf,uncertainFields}),applyTag:async(id,tag)=>calls.push(['tag',id,tag]),archive:async(id)=>calls.push(['archive',id]),reportReview:async(row)=>calls.push(['sheet',row.outcome])};
  const xero={lookup:async()=>[],createDraft:async()=> 'xero1',attachOriginal:async()=>{},verifyOriginal:async()=>true};
  return {port,xero,calls};
}
test('clean invoice drafts, tags and archives',async()=>{const f=fixture([{id:'a',subject:'',body:'',attachments:[{id:'i1',filename:'a.pdf',messageId:'m'}]}]);const r=await runApInbox(f.port,f.xero);assert.equal(r.archived,1);assert.equal(r.documents,1);assert.deepEqual(f.calls,[['tag','a','AP Agent reviewed'],['archive','a']]);});
test('uncertain draft reports once and remains open',async()=>{const f=fixture([{id:'a',subject:'',body:'',attachments:[{id:'i1',filename:'a.pdf',messageId:'m'}]}],['supplier']);const r=await runApInbox(f.port,f.xero);assert.equal(r.archived,0);assert.deepEqual(f.calls,[['sheet','draft_uncertain'],['tag','a','Human review']]);});
test('technical failure stays open and reports',async()=>{const f=fixture([{id:'a',subject:'',body:'',attachments:[{id:'i1',filename:'a.pdf',messageId:'m'}]}]);f.port.makeDraftCommand=async()=>{throw Error('PDF download failed')};const r=await runApInbox(f.port,f.xero);assert.equal(r.archived,0);assert.equal(r.items[0].failures.length,1);assert.equal(f.calls[0][1],'technical_failure');});
test('existing Xero invoice archives without new draft',async()=>{const f=fixture([{id:'a',subject:'',body:'',attachments:[{id:'i1',filename:'a.pdf',messageId:'m'}]}]);f.xero.lookup=async()=>[{id:'existing',kind:'Invoices',exact:true}];f.xero.createDraft=async()=>{throw Error('duplicate')};f.xero.verifyOriginal=async()=>true;const r=await runApInbox(f.port,f.xero);assert.equal(r.archived,1);assert.equal(f.calls.some(x=>x[0]==='sheet'),false);});
test('mixed attachments never prematurely archive (Word document not yet auto-drafted)',async()=>{const f=fixture([{id:'a',subject:'',body:'',attachments:[{id:'i1',filename:'a.pdf',messageId:'m'},{id:'i2',filename:'b.docx',messageId:'m'}]}]);const r=await runApInbox(f.port,f.xero);assert.equal(r.archived,0);assert.equal(r.documents,2);});
test('images and other file types are ignored: only PDF, Word and Excel are documents',async()=>{const f=fixture([{id:'a',subject:'',body:'',attachments:[{id:'i1',filename:'a.pdf',messageId:'m'},{id:'i2',filename:'image001.png',messageId:'m'},{id:'i3',filename:'invite.ics',messageId:'m'}]}]);const r=await runApInbox(f.port,f.xero);assert.equal(r.documents,1);});
test('an email with only ignored attachments is handled as a no-attachment email',async()=>{const f=fixture([{id:'a',subject:'hello',body:'',attachments:[{id:'i2',filename:'logo.png',messageId:'m'}]}]);const r=await runApInbox(f.port,f.xero);assert.equal(r.documents,0);assert.equal(r.items[0].tag,'AP Agent reviewed');});
test('finance and non-finance no-attachment outcomes',async()=>{const f=fixture([{id:'a',subject:'invoice overdue',body:'',attachments:[]},{id:'b',subject:'hello',body:'',attachments:[]}]);const r=await runApInbox(f.port,f.xero);assert.equal(r.archived,1);assert.deepEqual(f.calls,[['tag','a','No attachment - Human review'],['tag','b','AP Agent reviewed'],['archive','b']]);});
test('Sheet outage does not undo draft',async()=>{const f=fixture([{id:'a',subject:'',body:'',attachments:[{id:'i1',filename:'a.pdf',messageId:'m'}]}],['supplier']);f.port.reportReview=async()=>{throw Error('unavailable')};const r=await runApInbox(f.port,f.xero);assert.equal(r.archived,0);assert.equal(r.items[0].tag,'Human review');assert.match(r.items[0].failures[0],/Sheet report pending/);});
test('incomplete enumeration aborts before any changes',async()=>{const f=fixture([]);f.port.listAllOpenConversations=async()=>{throw Error('truncated')};await assert.rejects(runApInbox(f.port,f.xero),/truncated/);assert.equal(f.calls.length,0);});

test('supplier uncertainty report preserves extracted name, selected Xero contact and similarity',async()=>{
 const f=fixture([{id:'cnv_a',subject:'',body:'',attachments:[{id:'fil_a',filename:'a.pdf',messageId:'msg_a'}]}],['supplier']);
 f.port.makeDraftCommand=async()=>({kind:'Invoices',number:'WP-123',supplierContactId:'existing-contact',supplierName:'Water Plus Limited',extractedSupplierName:'Water Plus Group Limited',supplierMatchScore:2/3,accountCode:'449',invoiceDate:'2026-11-09',dueDate:'2026-11-09',gross:48.67,pdf,uncertainFields:['supplier']});
 let review;
 f.port.reportReview=async row=>{review=row};
 const r=await runApInbox(f.port,f.xero);
 assert.equal(r.archived,0);
 assert.equal(review.outcome,'draft_uncertain');
 assert.equal(review.supplier,'Water Plus Limited');
 assert.equal(review.extractedSupplier,'Water Plus Group Limited');
 assert.equal(review.supplierMatchScore,2/3);
 assert.match(review.reason,/supplier/);
});
test('a conversation tagged Human Review is never re-tagged or archived; new attachments still processed',async()=>{
 const f=fixture([{id:'a',subject:'',body:'',tags:['Human Review'],attachments:[{id:'i1',filename:'a.pdf',messageId:'m'}]}]);
 const tags=[];f.port.applyTag=async(id,t)=>tags.push(t);let archived=0;f.port.archive=async()=>{archived++};
 const r=await runApInbox(f.port,f.xero);
 assert.equal(r.documents,1);assert.deepEqual(tags,[]);assert.equal(archived,0);assert.match(r.items[0].tag,/unchanged/);
});
test('Direct Debit collection notices are archived as AP Agent reviewed; statement-ready emails stay for review',async()=>{
 const f=fixture([{id:'dd',subject:'Upcoming Direct Debit payment to Lantum',body:'Your payment will be collected on 1 Dec',attachments:[]},
   {id:'st',subject:'Your statement 8053097617 is ready for review',body:'',attachments:[]}]);
 const r=await runApInbox(f.port,f.xero);
 assert.equal(r.items.find(i=>i.conversationId==='dd').tag,'AP Agent reviewed');
 assert.equal(r.items.find(i=>i.conversationId==='st').tag,'No attachment - Human review');
});
test('an invoice email that mentions Direct Debit in its body is not a Direct Debit notice',async()=>{
 const f=fixture([{id:'ig',subject:'Your Monthly iGPR Managed Service Invoice',body:'Payment will be collected by Direct Debit on 1 Dec',attachments:[]}]);
 const r=await runApInbox(f.port,f.xero);
 assert.equal(r.items[0].tag,'No attachment - Human review');
});
test('Xero rate limit stops the run: no Sheet row, tag or archive for that conversation, later ones untouched',async()=>{
 const f=fixture([{id:'a',subject:'',body:'',attachments:[{id:'i1',filename:'a.pdf',messageId:'m'}]},{id:'b',subject:'',body:'',attachments:[{id:'i2',filename:'b.pdf',messageId:'m'}]}]);
 f.xero.lookup=async()=>{throw Error('Xero HTTP 429 rate limit (day); Retry-After: 8181 seconds')};
 const r=await runApInbox(f.port,f.xero);
 assert.match(r.stoppedEarly,/Xero API limit reached at a/);
 assert.deepEqual(f.calls,[]);
 assert.equal(r.items.length,1);
});
