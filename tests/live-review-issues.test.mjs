import test from 'node:test';
import assert from 'node:assert/strict';
const { liveExtractionIssues } = await import(new URL('../dist/live-review-issues.js', import.meta.url));
const { BALANCE_AMOUNT_NOTE } = await import(new URL('../dist/ap-invoice-review-rules.js', import.meta.url));

test('clean PDF matching the recorded fields raises no issues', () => {
  assert.deepEqual(liveExtractionIssues('Invoice\nInvoice No: AB-1\nInvoice Date: 01/10/2026\nTotal Due: £20.00', { invoice_number: 'AB-1', gross_gbp: 20 }), []);
});
test('damaged separator, credit balance and mismatched total are flagged from the PDF itself', () => {
  const issues = liveExtractionIssues('Invoice\nInvoice number HT1\u000034156\nDate of issue October 1, 2026\nTotal amount -£5.00\nTotal charges for this period £12.00',
    { invoice_number: 'HT1-34156', gross_gbp: 10 });
  assert.ok(issues.some(i => /damaged separator/.test(i)));
  assert.ok(issues.includes(BALANCE_AMOUNT_NOTE));
  assert.ok(issues.some(i => /differs from recorded £10.00/.test(i)));
});
test('stored notes are never inputs: only the PDF, recorded fields and the current extraction', () => {
  assert.equal(liveExtractionIssues.length, 3);
  const issues = liveExtractionIssues('Invoice No: AB-1\nInvoice Date: 01/10/2026\nTotal Due: £20.00', { invoice_number: 'AB-1', gross_gbp: 20 },
    { candidates: { documentType: { value: 'invoice', evidence: '', uncertain: false }, supplier: null,
      reference: { value: 'AB-1', evidence: '', uncertain: false }, invoiceDate: { value: '2026-10-01', evidence: '', uncertain: false },
      dueDate: null, grossAmount: { value: '£20.00', evidence: '', uncertain: false }, currency: { value: 'GBP', evidence: '', uncertain: false },
      accountBalance: null, amountPaid: null, linkedInvoiceReference: null, uncertainFields: [] }, notes: ['Supplier: model read "A", text rules read "B" - verify'] });
  assert.deepEqual(issues, ['Supplier: model read "A", text rules read "B" - verify']);
});
