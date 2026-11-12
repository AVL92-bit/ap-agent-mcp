import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const moduleUrl=new URL('../dist/invoice-candidates.js',import.meta.url);
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
 assert.match(source,/extractionResponse\(\{text:invoiceText/);
});

test('damaged receipt reference separator is reconstructed but stays uncertain, with payment evidence retained',()=>{
 const r=extractInvoiceCandidates('Healthtech 1\nReceipt\nReceipt number 2874\u00006222\nInvoice Number HT1\u000035587\nAmount paid £771.12');
 assert.equal(r.documentType.value,'receipt');
 assert.equal(r.reference.value,'2874-6222');
 assert.equal(r.reference.uncertain,true);
 assert.match(r.reference.evidence,/separator reconstructed/);
 assert.equal(r.linkedInvoiceReference.value,'HT1-35587');
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

test('receipt pagination cannot be a supplier',()=>{
 const c=extractInvoiceCandidates('Page 1 of 1\nReceipt\nHealthtech 1\nReceipt number 2874\u00006222\nInvoice number HT1\u000035587\nAmount paid £771.12');
 assert.equal(c.supplier?.value,'Healthtech 1');
 assert.equal(c.supplier?.uncertain,true);
 assert.equal(c.reference?.uncertain,true);
});
test('split issue date and full-document legal supplier are advisory',()=>{
 const c=extractInvoiceCandidates('Page 1 of 4\nSummary of Charges: invoice wp-INV13861043\nIssue date:\t\n03 November 2026\nTotal charges for this period £48.67\n'+Array(22).fill('Account information').join('\n')+'\nWater Plus Limited\nTotal amount -£10.60');
 assert.equal(c.invoiceDate?.value,'03 November 2026');
 assert.equal(c.invoiceDate?.uncertain,true);
 assert.equal(c.supplier?.value,'Water Plus Limited');
 assert.equal(c.supplier?.uncertain,true);
 assert.equal(c.reference?.uncertain,false);
});
test('unrelated tab characters do not taint intact invoice references',()=>{
 const c=extractInvoiceCandidates('Invoice No: ABC-123\tAccount details\nSupplier: Acme Ltd\nInvoice Date: 01/11/2026\nTotal Due: £20.00');
 assert.equal(c.reference?.value,'ABC-123');
 assert.equal(c.reference?.uncertain,false);
});

test('Water Plus tab-separated company number and cheque payee identify uncertain supplier',()=>{
 const c=extractInvoiceCandidates('Summary of Charges: invoice wp-INV13861043\nIssue date:\n03 November 2026\nTotal charges for this period £48.67\nWater\tPlus\tLimited (company number 04141390)\nCheques should be made payable to Water\tPlus\tLimited\nTotal amount -£10.60');
 assert.equal(c.supplier?.value,'Water Plus Limited');
 assert.equal(c.supplier?.uncertain,true);
 assert.match(c.supplier?.evidence,/Cheques should be made payable to Water Plus Limited/);
 assert.equal(c.grossAmount?.value,'£48.67');
 assert.equal(c.accountBalance?.value,'-£10.60');
});
test('cheque payee is usable evidence without standalone company line',()=>{
 const c=extractInvoiceCandidates('Invoice No: B22\nCheques should be made payable to Water\tPlus\tLimited\nTotal Due: £20.00');
 assert.equal(c.supplier?.value,'Water Plus Limited');
 assert.equal(c.supplier?.uncertain,true);
});
test('payee takes precedence over a conflicting legal-name footer',()=>{
 const c=extractInvoiceCandidates('Invoice No: B22\nWater Plus Limited (company number 04141390)\nCheques should be made payable to Other Company Limited\nTotal Due: £20.00');
 assert.equal(c.supplier?.value,'Other Company Limited');
 assert.equal(c.supplier?.uncertain,true);
});

test('three registered group entities do not override the cheque payee',()=>{
 const c=extractInvoiceCandidates('Summary of Charges: invoice wp-INV13861043\nWater Plus Group Limited (company number 10012579), Water Plus Limited (company number 04141390) and Water Plus Select Limited (company number 03511659).\nCheques should be made payable to Water Plus Limited\nTotal charges for this period £48.67');
 assert.equal(c.supplier?.value,'Water Plus Limited');
 assert.equal(c.supplier?.uncertain,true);
 assert.match(c.supplier?.evidence,/Cheques should be made payable/);
});
test('group registration list without payee supplies uncertain candidate',()=>{
 const c=extractInvoiceCandidates('Invoice No: 123\nWater Plus Group Limited (company number 10012579), Water Plus Limited (company number 04141390) and Water Plus Select Limited (company number 03511659).');
 assert.equal(c.supplier?.uncertain,true);
 assert.ok(c.supplier?.value);
});

test('general payable-to and payment recipient wording outranks group footer',()=>{
 for(const instruction of ['Payable to: Water Plus Limited','Payments should be made payable to Water Plus Limited','Please make payment to Water Plus Limited','Remittance to: Water Plus Limited']) {
  const c=extractInvoiceCandidates('Invoice No: WP-123\nWater Plus Group Limited (company number 10012579), Water Plus Limited (company number 04141390) and Water Plus Select Limited (company number 03511659).\n'+instruction+'\nTotal Due: £48.67');
  assert.equal(c.supplier?.value,'Water Plus Limited',instruction);
  assert.equal(c.supplier?.uncertain,true,instruction);
  assert.equal(c.supplier?.evidence,instruction);
 }
});


test('Water Plus real PDF payee split across lines outranks registration footer',()=>{
 const body='Summary \t of \t Charges: invoice wp-INV13861043\nTotal \tcharges \tfor \tthis \tperiod \t£48.67\nTotal \tamount \t-£10.60\nRegistered \tin \tEngland \t& \tWales.\nWater \tPlus \tGroup \tLimited \t(company \tnumber \t10012579), \tWater \tPlus \tLimited \t(company \tnumber \t04141390) \tand \tWater \tPlus \tSelect \tLimited \t(company \tnumber \t03511659).\nIf \tyou \thave \tnot \talready \tagreed \ta \tspecific \tcontract \twith \tWater \tPlus\nLimited \t(we \t/ \tus \t/ \tour)\nCheques \tshould \tbe \tmade \tpayable \tto \tWater\nPlus \tLimited. \tThis \tservice \tis \tfree';
 const c=extractInvoiceCandidates(body);
 assert.equal(c.supplier?.value,'Water Plus Limited');
 assert.equal(c.supplier?.uncertain,true);
 assert.match(c.supplier?.evidence,/Cheques should be made payable to Water Plus Limited/);
 assert.equal(c.grossAmount?.value,'£48.67');
});

// Healthtech 1 HT1-34156 (cnv_1d0657fa) - real extracted text, damaged dashes kept as \u0000.
const healthtech='Page 1 of 1\nInvoice\nInvoice number HT1\u000034156\nDate of issue October 1, 2026\nDate due \tOctober 1, 2026\nPractice name St Georges Road Surgery\nHealthtech 1\n91 Belmont Hill\nLondon\nSE13 5AX\nUnited Kingdom\nsupport@healthtech1.uk\nBill to\nSt Georges Road Surgery\nfinance_stgeorges@archvale.co.uk\n£667.92 due October 1, 2026\nPay online\nHealthtech-1 Automation\nDescription \tQty \tUnit price \tTax \tAmount\nAutomated lab reports\nSep 1\u0000Sep 30, 2026\n513 \t£0.20 \t20% \t£102.60\nAutomated registrations\nSep 1\u0000Sep 30, 2026\n227 \t£2.00 \t20% \t£454.00\nSubtotal \t£556.60\nTotal excluding tax \t£556.60\nVAT \u000020% on £556.60\u0000 \t£111.32\nTotal \t£667.92\nAmount due \t£667.92\nVAT Number: 406614417\n\n-- 1 of 1 --';
test('Healthtech: masthead supplier above address, never the practice',()=>{
 const c=extractInvoiceCandidates(healthtech);
 assert.equal(c.supplier?.value,'Healthtech 1');
 assert.equal(c.supplier?.uncertain,true);
 assert.match(c.supplier?.evidence,/SE13 5AX/);
});
test('Healthtech: damaged dash in invoice number reconstructed and flagged',()=>{
 const c=extractInvoiceCandidates(healthtech);
 assert.equal(c.reference?.value,'HT1-34156');
 assert.equal(c.reference?.uncertain,true);
});
test('Healthtech: "Date of issue" and "Date due" in Month D, YYYY style',()=>{
 const c=extractInvoiceCandidates(healthtech);
 assert.equal(c.invoiceDate?.value,'October 1, 2026');
 assert.equal(c.dueDate?.value,'October 1, 2026');
 assert.equal(c.grossAmount?.value,'£667.92');
});
test('a town line directly above the customer postcode is never the supplier',()=>{
 const c=extractInvoiceCandidates('Issue date:\n03 November 2026\nDr Sufian Ali\n102 St Georges Road\nCOVENTRY\nCV1 2DL\nInvoice wp-INV1\nTotal Due: £1.00');
 assert.equal(c.supplier,null);
});
test('date variants: 1 Oct 2026, 3rd November 2026, Tax point date',()=>{
 assert.equal(extractInvoiceCandidates('Invoice No: A1\nInvoice Date: 1 Oct 2026\nTotal Due: £1.00').invoiceDate?.value,'1 Oct 2026');
 assert.equal(extractInvoiceCandidates('Invoice No: A1\nTax point date 3rd November 2026\nTotal Due: £1.00').invoiceDate?.value,'3rd November 2026');
 assert.equal(extractInvoiceCandidates('Invoice No: A1\nInvoice Date: 01/10/2026\nDue by 31/10/2026\nTotal Due: £1.00').dueDate?.value,'31/10/2026');
});

test('a column label after "Invoice" is never the reference',()=>{
 const c=extractInvoiceCandidates('Invoice\nInvoice Date\nInvoice Period\nTotal Invoice\n1633437\n01/11/2026');
 assert.equal(c.reference,null);
 const d=extractInvoiceCandidates('INVOICE TO: SHIP TO: INVOICE DATE:\nInvoice No: 65930654\nTotal Due: £1.00');
 assert.equal(d.reference?.value,'65930654');
});
test('Henry Schein: currency line above a terms/website block is never the supplier',()=>{
 const c=extractInvoiceCandidates('GBP\nFor full Terms & Conditions visit\nhenryscheinmedical.co.uk\nMedcare House, Centurion Close, Gillingham Business Park, Gillingham, Kent, ME8 0SB\nINVOICE\nINVOICE TO: SHIP TO: INVOICE DATE:\nDr M Dadhania\n102 St. George Road\nCOVENTRY\nCV1 2DL\nA Division of Henry Schein UK Holdings Ltd.\nRegistered No: 11584480');
 assert.equal(c.supplier?.value,'Henry Schein UK Holdings Ltd');
});
test('Wavenet: "Customer Information" and customer.services@ are not bill-to blocks',()=>{
 const c=extractInvoiceCandidates('Invoice\nCustomer Information\nContact Us:\nWavenet Limited\nOne Central Boulevard\nShirley\nSolihull West Midlands B90 8BG\ncustomer.services@wavenet.co.uk\nCheque Please make cheques payable to Wavenet Ltd and send them to\nWavenet Ltd, One Central Boulevard\nTotal Invoice £172.81');
 assert.equal(c.supplier?.value,'Wavenet Ltd');
});
test('a real "Bill to:" block is still excluded from supplier evidence',()=>{
 const c=extractInvoiceCandidates('Invoice No: 1\nBill to:\nHarbour Medical Services Ltd\n1 High Street\nTotal Due: £1.00\nKestrel Office Supplies Limited');
 assert.equal(c.supplier?.value,'Kestrel Office Supplies Limited');
});
