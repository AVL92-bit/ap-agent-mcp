import assert from 'node:assert/strict';
import test from 'node:test';
import { billingRecipientCheck, reconcileInvoiceReviewIssues } from '../src/ap-invoice-review-rules.ts';

const evidence={supplierVerified:true,vatPolicyVerified:true,dueDateDefaulted:true};
test('Modulr billing block with individual and surgery passes',()=>{
  assert.equal(billingRecipientCheck('BILLED TO\nMatthew Meyer\nSt Georges Road Surgery'),'practice');
});
test('individual-only billing matches latest historical supplier PDF',()=>{
  const invoice='BILLED TO\nMatthew Meyer\nSome Other Address\nInvoice MOD-1';
  const history='BILLED TO\nMatthew Meyer\nSome Other Address\nInvoice MOD-0';
  assert.equal(billingRecipientCheck(invoice,history),'historical_match');
  assert.equal(billingRecipientCheck(invoice,'BILLED TO\nAnother Person\nSome Other Address'),'unverified');
  assert.equal(billingRecipientCheck(invoice),'unverified');
});
test('verified evidence clears stale supplier, VAT, DD and due-date warnings',()=>{
  const issues=[
    'Payment status: payment initiated by Direct Debit on 03 Nov 2026 - already settled or in progress; junior to confirm',
    'Supplier not matched to a Xero contact; supplier verification required',
    'No net or VAT breakdown on invoice; VAT treatment undetermined',
    'Due date defaults to invoice date + 30 days',
    'Different bank account details; finance must review'
  ];
  assert.deepEqual(reconcileInvoiceReviewIssues(issues,evidence),['Different bank account details; finance must review']);
});
test('unverified supplier warning and unrelated safeguards remain',()=>{
  const issues=['Supplier not matched to a Xero contact','Explicit human hold or rejection','Existing Xero document needs reconciliation'];
  assert.deepEqual(reconcileInvoiceReviewIssues(issues,{...evidence,supplierVerified:false}),issues);
});
