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

// ---- remittance emails with no attachment go to a person (owner decision 2026-11-20) ----
test('a remittance query with nothing attached is "No attachment - Human review", not archived', () => {
  for (const text of ['Re: Remittance missing: ', 'Re: Remittance missing:\nHi, we have not received a remittance for last month', 'Remittance advice for payment 4471',
    'Payment advice from Wavenet', 'REMITTANCE REQUEST', 'Subject: Our remittance details']) {
    assert.equal(classifyNoAttachment(text), 'finance_no_attachment', text);
  }
  assert.equal(FRONT_OUTCOME_POLICY.finance_no_attachment.tag, 'No attachment - Human review');
  assert.equal(FRONT_OUTCOME_POLICY.finance_no_attachment.archive, false);
});
test('direct debit collection notices are still archived: they are decided first, on the subject', () => {
  assert.equal(classifyNoAttachment('Upcoming Direct Debit payment to Lantum\nYour payment will be collected on 1 Dec. Remittance advice follows.'), 'non_finance_no_attachment');
  assert.equal(classifyNoAttachment('Upcoming Direct Debit payment to iGPR'), 'non_finance_no_attachment');
});
test('ordinary marketing with no finance wording is still archived', () => {
  for (const text of ['Why pay to advertise healthcare jobs?', 'STAY READY', 'Welcome to My Account at Wave', 'Supporting Your Compliance', 'Choose your free advent calendar']) {
    assert.equal(classifyNoAttachment(text), 'non_finance_no_attachment', text);
  }
});
