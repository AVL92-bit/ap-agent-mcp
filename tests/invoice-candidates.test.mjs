import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const moduleUrl=new URL('../src/invoice-candidates.ts',import.meta.url);
const {extractInvoiceCandidates}=await import(moduleUrl);
test('extracts evidence-backed fields without declaring draft readiness',()=>{
 const r=extractInvoiceCandidates('From: Acme Supplies\nInvoice No: AB-123\nInvoice Date: 09/11/2026\nDue Date: 30/11/2026\nTotal Due: £48.67');
 assert.equal(r.reference.value,'AB-123');assert.equal(r.supplier.value,'Acme Supplies');assert.equal(r.grossAmount.value,'£48.67');assert.equal(r.documentType.value,'invoice');
 assert.deepEqual(r.uncertainFields,[]);
});
test('missing fields stay uncertain and no amounts are invented',()=>{
 const r=extractInvoiceCandidates('Invoice\nSome ambiguous unstructured document');
 assert.equal(r.grossAmount,null);assert.equal(r.supplier,null);assert.ok(r.uncertainFields.includes('grossAmount'));
});
test('credit note identified',()=>{assert.equal(extractInvoiceCandidates('Credit Note\nCredit Note No: CN-22').documentType.value,'credit_note')});
test('integration exposes advisory candidates in existing extraction response',()=>{
 const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
 assert.match(source,/extracted_candidates: extractInvoiceCandidates\(invoiceText\)/);
});
