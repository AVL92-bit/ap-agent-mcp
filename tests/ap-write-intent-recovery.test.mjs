import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileCreateAndAttach } from '../src/ap-xero-document-coordinator.ts';
const pdf={filename:'source.pdf',contentType:'application/pdf',bytes:new TextEncoder().encode('%PDF-1.7')};
const command={kind:'Invoices',number:'TEST-123',supplierContactId:'supplier',accountCode:'400',invoiceDate:'2026-11-01',dueDate:'2026-11-30',gross:123,pdf,uncertainFields:[]};
test('ambiguous write cannot be retried after durable intent claimed',async()=>{
 let claimed=false,writes=0;
 const port={lookup:async()=>[],beforeCreate:async()=>{if(claimed)return false;claimed=true;return true},createDraft:async()=>{writes++;throw Error('network timeout')},attachOriginal:async()=>{}};
 assert.equal((await reconcileCreateAndAttach(command,port)).status,'reconciliation_required');
 assert.equal((await reconcileCreateAndAttach(command,port)).status,'reconciliation_required');
 assert.equal(writes,1);
});
test('existing Xero document is reconciled even when intent is already claimed',async()=>{
 let writes=0,claims=0;
 const outcome=await reconcileCreateAndAttach(command,{lookup:async()=>[{kind:'Invoices',id:'existing',number:'TEST-123',exact:true}],beforeCreate:async()=>{claims++;return false},createDraft:async()=>{writes++;return 'new'},attachOriginal:async()=>{},verifyOriginal:async()=>true});
 assert.equal(outcome.status,'already_in_xero');assert.equal(writes,0);assert.equal(claims,0);
});
