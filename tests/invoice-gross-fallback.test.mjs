import test from 'node:test';
import assert from 'node:assert/strict';
import { extractInvoiceCandidates } from '../dist/invoice-candidates.js';

test('recognises explicit gross including comma-separated and whole amounts', () => {
  assert.equal(extractInvoiceCandidates('Invoice\nGrand Total: £1,234.50').grossAmount.value, '£1,234.50');
  assert.equal(extractInvoiceCandidates('Invoice\nBalance Due: 250').grossAmount.value, '250');
});
test('does not treat net or VAT amounts as gross', () => {
  const r=extractInvoiceCandidates('Invoice\nSubtotal: £100.00\nVAT: £20.00');
  assert.equal(r.grossAmount,null);
  assert.ok(r.uncertainFields.includes('grossAmount'));
});
test('unqualified total remains explicitly uncertain', () => {
  const r=extractInvoiceCandidates('Invoice\nTotal: £120.00');
  assert.equal(r.grossAmount.value,'£120.00');
  assert.ok(r.uncertainFields.includes('grossAmount'));
});
