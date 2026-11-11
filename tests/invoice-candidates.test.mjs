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

test('damaged receipt reference is partial and uncertain, with payment evidence retained',()=>{
 const r=extractInvoiceCandidates('Healthtech 1\nReceipt\nReceipt number 2874\u00006222\nInvoice Number HT1\u000035587\nAmount paid £771.12');
 assert.equal(r.documentType.value,'receipt');
 assert.equal(r.reference.value,'2874');
 assert.equal(r.reference.uncertain,true);
 assert.equal(r.linkedInvoiceReference.value,'HT1');
 assert.equal(r.linkedInvoiceReference.uncertain,true);
 assert.equal(r.amountPaid.value,'£771.12');
 assert.equal(r.supplier.value,'Healthtech 1');
 assert.equal(r.supplier.uncertain,true);
 assert.ok(r.uncertainFields.includes('reference'));
});
test('Water Plus review fields include issue date, supplier and signed credit balance',()=>{
 const r=extractInvoiceCandidates('Water Plus Limited\nSummary of Charges: invoice wp-INV13861043\nIssue date: 03 November 2026\nCredit brought forward -£59.27\nTotal charges for this period £48.67\nTotal amount -£10.60');
 assert.equal(r.reference.value,'wp-INV13861043');
 assert.equal(r.invoiceDate.value,'03 November 2026');
 assert.equal(r.supplier.value,'Water Plus Limited');
 assert.equal(r.supplier.uncertain,true);
 assert.equal(r.grossAmount.value,'£48.67');
 assert.equal(r.grossAmount.uncertain,true);
 assert.equal(r.accountBalance.value,'-£10.60');
});
test('ordinary explicit supplier and numeric dates remain verified',()=>{
 const r=extractInvoiceCandidates('Supplier: Example Ltd\nInvoice No: A123\nInvoice Date: 01/11/2026\nTotal Due: £20.00');
 assert.equal(r.supplier.uncertain,false);
 assert.equal(r.invoiceDate.uncertain,false);
});
