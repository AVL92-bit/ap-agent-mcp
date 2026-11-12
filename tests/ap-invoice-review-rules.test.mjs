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

import { applyPaymentIssuePolicy, BALANCE_AMOUNT_NOTE } from '../dist/ap-invoice-review-rules.js';
test('payment-processing notices are dropped; balances become one amount-uncertainty note', () => {
  const recorded = [
    "Payment-platform risk: Modulr AP 'Invoice processing started' notice (05 Nov 2026) was triggered for this same document (wp-INV13861043) - check no duplicate payment is in progress.",
    'Account shows credit balance -£10.60 after brought-forward credit of -£59.27 and new charges £48.67 - no amount is overdue on this bill.',
    'Amount brought forward to this bill -£59.27',
    'Invoice date read from issue date; confirm',
  ];
  assert.deepEqual(applyPaymentIssuePolicy(recorded), [BALANCE_AMOUNT_NOTE, 'Invoice date read from issue date; confirm']);
});
test('payment policy keeps extraction and coding issues untouched', () => {
  const issues = ['Supplier identity uncertain', 'Historical coding unverified', 'Missing due date'];
  assert.deepEqual(applyPaymentIssuePolicy(issues), issues);
});
test('assessment tools tell recorders not to log payment issues', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(src, /Never record payment status, payment-platform notices/);
  assert.equal((src.match(/\.describe\(EXCEPTIONS_GUIDANCE\)/g) ?? []).length, 2);
});
