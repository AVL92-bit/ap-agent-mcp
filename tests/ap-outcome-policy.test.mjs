import assert from 'node:assert/strict';
import test from 'node:test';
import {FRONT_OUTCOME_POLICY,classifyNoAttachment} from '../src/ap-outcome-policy.ts';
test('only three approved Front tags are used',()=>{
 assert.deepEqual(new Set(Object.values(FRONT_OUTCOME_POLICY).map(x=>x.tag)),
 new Set(['AP Agent reviewed','Human review','No attachment - Human review']));
});
test('uncertain draft and failure stay open and are reported',()=>{
 for(const x of ['draft_uncertain','technical_failure']) {
  assert.equal(FRONT_OUTCOME_POLICY[x].archive,false);
  assert.equal(FRONT_OUTCOME_POLICY[x].sheet,true);
 }
});
test('existing Xero document is archived without Sheet entry',()=>{
 assert.deepEqual(FRONT_OUTCOME_POLICY.xero_existing,{tag:'AP Agent reviewed',archive:true,sheet:false});
});
test('finance messages without attachments remain open',()=>{
 for(const text of ['Invoice 123','OVERDUE payment','Your statement','Credit note enclosed'])
 assert.equal(classifyNoAttachment(text),'finance_no_attachment');
 assert.equal(classifyNoAttachment('Hello, thank you for your message'),'non_finance_no_attachment');
});
