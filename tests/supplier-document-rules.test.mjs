import test from 'node:test';
import assert from 'node:assert/strict';
import { statementInvoiceSupplier, statementIsInvoiceSuppliers } from '../dist/supplier-document-rules.js';
test('Lantum is configured as a statement-is-invoice supplier', () => {
  assert.ok(statementIsInvoiceSuppliers().includes('Lantum'));
});
test('match on supplier name or document text, not others', () => {
  assert.equal(statementInvoiceSupplier('LANTUM LTD', ''), 'Lantum');
  assert.equal(statementInvoiceSupplier(null, 'Consolidated statement from Lantum Ltd, accounts@lantum.com'), 'Lantum');
  assert.equal(statementInvoiceSupplier('Henry Schein Medical', 'Statement of account'), null);
  assert.equal(statementInvoiceSupplier('Tom White Waste', 'Statement', ['Lantum']), null);
});
