import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractInvoiceCandidates } from '../dist/invoice-candidates.js';
import { buildDraftCommand, buildDraftFromAvailableCandidates } from '../dist/ap-draft-candidate-command.js';
const pdf = { filename:'bill.pdf',bytes:new TextEncoder().encode('%PDF-1.4'),contentType:'application/pdf' };
test('maps extracted invoice and preserves uncertainty without veto',()=>{
 const c=extractInvoiceCandidates('Invoice\nSupplier: Example Limited\nInvoice No: A123\nInvoice Date: 01/11/2026\nTotal: £48.67');
 const x=buildDraftCommand({candidates:c,supplierContactId:'contact',accountCode:'449',pdf});
 assert.equal(x.number,'A123'); assert.equal(x.invoiceDate,'2026-11-01'); assert.equal(x.gross,48.67);
 // No printed due date: invoice date + 30 days, as an informational note (not a review flag).
 assert.ok(!x.uncertainFields.includes('dueDate')); assert.equal(x.dueDate,'2026-12-01');
 assert.deepEqual(x.infoNotes,['Due date not printed; set to invoice date + 30 days']);
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

test('unmatched supplier cannot create provisional Xero contact',async()=>{
 let created=0;
 const candidates=extractInvoiceCandidates('Invoice\nSupplier: Unknown Vendor\nInvoice No: 12345\nTotal Due: £20.00');
 await assert.rejects(buildDraftFromAvailableCandidates({
   candidates,contacts:[{id:'known',name:'Other Supplier'}],
   accounts:[{code:'449',name:'Expenses',type:'EXPENSE',status:'ACTIVE'}],
   preferredAccountCode:'449',pdf,
   createProvisionalContact:async()=>{created++;throw Error('MUST NOT CREATE');}
 }),/Supplier "Unknown Vendor" is not in Xero.*Please create it as a supplier contact.*12345/);
 assert.equal(created,0);
});
test('no supplier history and no contact default: drafted with NO account code (never a guessed account), flagged',async()=>{
 const candidates=extractInvoiceCandidates('Invoice\nSupplier: Example Limited\nInvoice No: 12345\nTotal Due: £20.00');
 const command=await buildDraftFromAvailableCandidates({candidates,contacts:[{id:'known',name:'Example Limited'}],accounts:[{code:'449',name:'Expenses',type:'EXPENSE',status:'ACTIVE'}],pdf});
 assert.equal(command.accountCode,'');
 assert.ok(command.uncertainFields.includes('accountCode'));
 assert.ok(command.reviewNotes.some(n=>/No coding history or default account for Example Limited: drafted with no account code; finance to code it before approving/.test(n)));
});
test('contact default purchase account drafts with account flagged uncertain',async()=>{
 const candidates=extractInvoiceCandidates('Invoice\nSupplier: Example Limited\nInvoice No: 12345\nTotal Due: £20.00');
 const command=await buildDraftFromAvailableCandidates({candidates,contacts:[{id:'known',name:'Example Limited',defaultPurchaseCode:'449'}],accounts:[{code:'449',name:'Expenses',type:'EXPENSE',status:'ACTIVE'}],pdf});
 assert.equal(command.accountCode,'449');
 assert.ok(command.uncertainFields.includes('accountCode'));
});
test('most recent matched supplier invoice code wins over contact default',async()=>{
 const candidates=extractInvoiceCandidates('Invoice\nSupplier: Example Limited\nInvoice No: 12345\nTotal Due: £20.00');
 let matchedId;
 const command=await buildDraftFromAvailableCandidates({candidates,contacts:[{id:'known',name:'Example Limited',defaultPurchaseCode:'449'}],accounts:[{code:'449',name:'Other',type:'EXPENSE',status:'ACTIVE'},{code:'450',name:'Historical',type:'EXPENSE',status:'ACTIVE'}],pdf,
   recentAccountCodeForContact:async(id)=>{matchedId=id;return '450';}});
 assert.equal(matchedId,'known');
 assert.equal(command.accountCode,'450');
 assert.ok(!command.uncertainFields.includes('accountCode'));
});
test('inactive historical account falls to contact default, never a generic account',async()=>{
 const candidates=extractInvoiceCandidates('Invoice\nSupplier: Example Limited\nInvoice No: 12345\nTotal Due: £20.00');
 const accounts=[{code:'449',name:'Other',type:'EXPENSE',status:'ACTIVE'},{code:'450',name:'Inactive',type:'EXPENSE',status:'ARCHIVED'}];
 const uncoded=await buildDraftFromAvailableCandidates({candidates,contacts:[{id:'known',name:'Example Limited'}],accounts,pdf,recentAccountCodeForContact:async()=>'450'});
 assert.equal(uncoded.accountCode,''); // an archived historical account is never used: no code at all
 const command=await buildDraftFromAvailableCandidates({candidates,contacts:[{id:'known',name:'Example Limited',defaultPurchaseCode:'449'}],accounts,pdf,recentAccountCodeForContact:async()=>'450'});
 assert.equal(command.accountCode,'449');
});

test('Healthtech payment receipt is not an invoice and invoice number is not receipt reference',()=>{
 const c=extractInvoiceCandidates('Healthtech 1\nReceipt\nReceipt number: 2874-6222\nInvoice Number: HT1-35587\nDate paid: 10/11/2026\nAmount paid: £771.12');
 assert.equal(c.documentType.value,'receipt');
 assert.equal(c.reference?.value,'2874-6222');
 assert.equal(c.grossAmount,null);
 assert.ok(c.uncertainFields.includes('documentType'));
});
test('Water Plus period charges are distinguished from negative account balance',()=>{
 const c=extractInvoiceCandidates('Water Plus Limited\nSummary of Charges: invoice wp-INV13861043\nCredit brought forward -£59.27\nTotal charges for this period: £48.67\nTotal amount -£10.60');
 assert.equal(c.documentType.value,'invoice');
 assert.equal(c.reference?.value,'wp-INV13861043');
 assert.equal(c.grossAmount?.value,'£48.67');
 assert.ok(c.uncertainFields.includes('grossAmount'));
});
test('negative account balance alone is never extracted as positive gross',()=>{
 const c=extractInvoiceCandidates('Invoice\nInvoice No: A123\nCredit brought forward -£59.27\nTotal amount -£10.60');
 assert.equal(c.grossAmount,null);
});

test('existing Xero contact match carries source and score into draft audit',async()=>{
 const candidates=extractInvoiceCandidates('Invoice\nPayable to: Water Plus Limited\nInvoice No: WP-123\nTotal Due: £48.67');
 const command=await buildDraftFromAvailableCandidates({candidates,contacts:[{id:'approved',name:'Water Plus Ltd'}],accounts:[{code:'449',name:'Expenses',type:'EXPENSE',status:'ACTIVE'}],preferredAccountCode:'449',recentAccountCodeForContact:async()=>'449',pdf});
 assert.equal(command.supplierContactId,'approved');
 assert.equal(command.supplierName,'Water Plus Ltd');
 assert.equal(command.extractedSupplierName,'Water Plus Limited');
 assert.equal(command.supplierMatchScore,1);
 assert.ok(command.uncertainFields.includes('supplier'));
});

// ---- owner decision 2026-11-27: no history and no default account -> a draft with no account code, flagged ----
const noCodeText = 'Invoice\nSupplier: Example Limited\nInvoice No: 12345\nTotal Due: £20.00';
test('a Suspense account in the chart is NOT used: no history and no default means no account code', async () => {
  const candidates = extractInvoiceCandidates(noCodeText);
  const command = await buildDraftFromAvailableCandidates({ candidates, contacts: [{ id: 'known', name: 'Example Limited' }], pdf,
    accounts: [{ code: '449', name: 'Expenses', type: 'EXPENSE', status: 'ACTIVE' }, { code: '999', name: 'Suspense', type: 'CURRENT', status: 'ACTIVE' }] });
  assert.equal(command.accountCode, '');
});
test('supplier history or a contact default still wins: only then is a code posted', async () => {
  const accounts = [{ code: '449', name: 'Expenses', type: 'EXPENSE', status: 'ACTIVE' }];
  const candidates = extractInvoiceCandidates(noCodeText);
  const a = await buildDraftFromAvailableCandidates({ candidates, contacts: [{ id: 'known', name: 'Example Limited' }], accounts, pdf, recentAccountCodeForContact: async () => '449' });
  assert.equal(a.accountCode, '449'); assert.equal((a.reviewNotes ?? []).some(n => /no account code/i.test(n)), false);
  const b = await buildDraftFromAvailableCandidates({ candidates, contacts: [{ id: 'known', name: 'Example Limited', defaultPurchaseCode: '449' }], accounts, pdf });
  assert.equal(b.accountCode, '449');
});
