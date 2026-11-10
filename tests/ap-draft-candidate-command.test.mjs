import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractInvoiceCandidates } from '../src/invoice-candidates.ts';
import { buildDraftCommand } from '../src/ap-draft-candidate-command.ts';
const pdf = { filename:'bill.pdf',bytes:new TextEncoder().encode('%PDF-1.4'),contentType:'application/pdf' };
test('maps extracted invoice and preserves uncertainty without veto',()=>{
 const c=extractInvoiceCandidates('Invoice\nSupplier: Example Limited\nInvoice No: A123\nInvoice Date: 01/11/2026\nTotal: £48.67');
 const x=buildDraftCommand({candidates:c,supplierContactId:'contact',accountCode:'449',pdf});
 assert.equal(x.number,'A123'); assert.equal(x.invoiceDate,'2026-11-01'); assert.equal(x.gross,48.67);
 assert.ok(x.uncertainFields.includes('dueDate')); assert.equal(x.dueDate,'2026-11-01');
});
test('fallback values remain marked for review',()=>{
 const c=extractInvoiceCandidates('Invoice');
 const x=buildDraftCommand({candidates:c,supplierContactId:'contact',accountCode:'449',pdf,fallbackReference:'FRONT-123',fallbackDate:'2026-11-09',fallbackGross:20});
 assert.equal(x.number,'FRONT-123'); assert.equal(x.gross,20);
 for(const f of ['reference','invoiceDate','grossAmount']) assert.ok(x.uncertainFields.includes(f));
});
test('credit note is mapped to CreditNotes',()=>{
 const c=extractInvoiceCandidates('Credit Note\nCredit Note No: CN44\nCredit Note Date: 01/11/2026\nTotal: £10.00');
 const x=buildDraftCommand({candidates:c,supplierContactId:'contact',accountCode:'449',pdf});
 assert.equal(x.kind,'CreditNotes');
});
