import test from 'node:test';
import assert from 'node:assert/strict';
const { extractInvoiceCandidates } = await import(new URL('../dist/invoice-candidates.js', import.meta.url));
const { assessSupplierEvidence, printedSupplierName } = await import(new URL('../dist/supplier-evidence.js', import.meta.url));

const PRACTICE = /\bst\.?\s*george['’s\s.-]*road\s*surgery\b/i;
const t = s => s.split(' ').join(' \t'); // real PDF text separates words with " \t"

// Water Plus wp-INV13861043 layout: page-1 summary, page-2 group registration footer,
// ~100 lines of terms, then the cheque payee split across a line break (line > 100).
const page1 = [
  'Issue date:', '03 November 2026', 'Account number:', '7003715583', 'W: water-plus.co.uk',
  'Page 1 of 4', 'Dr Sufian Ali', '102 St Georges Road', 'COVENTRY', 'CV1 2DL',
  'Summary of Charges: invoice wp-INV13861043', 'Amount brought forward to this bill -£59.27',
  'Total charges for this period £48.67', 'Total amount -£10.60', '-- 1 of 4 --', 'Page 2 of 4',
  'Registered in England & Wales.',
  'Water Plus Group Limited (company number 10012579), Water Plus Limited (company number 04141390) and Water Plus Select Limited (company number 03511659).',
  'Registered office: Water Plus, Prospect House, Gordon Banks Drive, Trentham Lakes North, Stoke-On-Trent, ST4 4TW.',
].map(t);
const terms = Array.from({ length: 110 }, (_, i) => t(`general terms and service information line ${i + 1} for your account`));
const contract = [t('If you have not already agreed a specific contract with Water Plus'), t('Limited (we / us / our), your arrangement with us is governed by')];
const payee = [t('the counter. Cheques should be made payable to Water'), t('Plus Limited. This service is free if you pay by cheque at any')];
const waterPlus = [...page1, ...contract, ...terms, ...payee, t('-- 2 of 4 --')].join('\n');

test('fixture places the cheque payee beyond line 100', () => {
  const index = waterPlus.split('\n').findIndex(l => /Cheques/.test(l));
  assert.ok(index > 100, `payee at line ${index + 1}`);
});

test('Water Plus: invoice candidates choose the split payee, not the group footer', () => {
  const c = extractInvoiceCandidates(waterPlus);
  assert.equal(c.supplier?.value, 'Water Plus Limited');
  assert.equal(c.supplier?.uncertain, true);
  assert.match(c.supplier?.evidence, /Cheques should be made payable to Water Plus Limited/);
});

test('Water Plus: readiness PDF supplier name agrees with invoice candidates', () => {
  assert.equal(printedSupplierName(waterPlus, { exclude: PRACTICE }), 'water plus limited');
});

test('Water Plus: historical bill PDF in the same format yields the same printed supplier', () => {
  const historical = waterPlus.replace(/wp-INV13861043/g, 'wp-INV13598511').replace(/£48\.67/g, '£217.95');
  assert.equal(printedSupplierName(historical, { exclude: PRACTICE }), printedSupplierName(waterPlus, { exclude: PRACTICE }));
});

test('legal-name fallback searches the whole document, not the first 15 lines', () => {
  const doc = ['INVOICE', 'Invoice No: 7781', 'Total Due: £120.00',
    ...Array.from({ length: 140 }, (_, i) => `service note ${i + 1}`),
    'Thank you for your business.', 'Acme Widgets Ltd'].join('\n');
  const c = extractInvoiceCandidates(doc);
  assert.equal(c.supplier?.value, 'Acme Widgets Ltd');
  assert.equal(c.supplier?.uncertain, true);
  assert.equal(assessSupplierEvidence(doc).selected?.tier, 'legal_name');
  assert.equal(printedSupplierName(doc), 'acme widgets ltd');
});

test('legal-name fallback finds names inside sentences and across line breaks', () => {
  const doc = 'Invoice No: 55\nTotal Due: £10.00\nServices were supplied by Northgate Cleaning\nServices Ltd under your agreement.';
  assert.equal(extractInvoiceCandidates(doc).supplier?.value, 'Northgate Cleaning Services Ltd');
});

test('legal-name fallback prefers the most frequently printed company', () => {
  const doc = 'Invoice No: 9\nTotal Due: £10.00\nPartner Bank PLC processes card payments.\nBrightway Supplies Ltd\nBrightway Supplies Ltd is registered in England.';
  assert.equal(extractInvoiceCandidates(doc).supplier?.value, 'Brightway Supplies Ltd');
});

test('legal-name fallback ignores companies in the bill-to block', () => {
  const doc = 'Invoice No: 10\nBill To:\nHarbour Medical Services Ltd\n1 High Street\nTotal Due: £10.00\nKestrel Office Supplies Limited';
  assert.equal(extractInvoiceCandidates(doc).supplier?.value, 'Kestrel Office Supplies Limited');
});

test('payee and registration evidence still outrank the legal-name fallback', () => {
  const doc = 'Invoice No: 11\nTotal Due: £10.00\nDelivered by Courier Partner Ltd\nPayable to: Main Supplier Limited';
  const c = extractInvoiceCandidates(doc);
  assert.equal(c.supplier?.value, 'Main Supplier Limited');
  assert.equal(assessSupplierEvidence(doc).selected?.tier, 'payee');
});

test('labelled supplier remains the only certain supplier evidence', () => {
  const c = extractInvoiceCandidates('From: Acme Supplies\nInvoice No: AB-1\nTotal Due: £5.00\nOther Company Ltd');
  assert.equal(c.supplier?.value, 'Acme Supplies');
  assert.equal(c.supplier?.uncertain, false);
});

test('readiness fails closed on conflicting payees', () => {
  const doc = 'Invoice No: 12\nCheques payable to Alpha Services Ltd\nRemittance to: Beta Services Ltd\nTotal Due: £1.00';
  assert.equal(printedSupplierName(doc), null);
});

test('readiness never treats the practice as the supplier', () => {
  const doc = "Invoice No: 13\nAccount name: St George's Road Surgery\nTotal Due: £1.00";
  assert.equal(printedSupplierName(doc, { exclude: PRACTICE }), null);
});

const { sameSupplierIgnoringLegalSuffix } = await import(new URL('../dist/supplier-evidence.js', import.meta.url));
test('legal-form suffix alone is not a supplier alias', () => {
  assert.equal(sameSupplierIgnoringLegalSuffix('water plus limited', 'Water Plus'), true);
  assert.equal(sameSupplierIgnoringLegalSuffix('Acme Ltd', 'Acme Limited'), true);
  assert.equal(sameSupplierIgnoringLegalSuffix('The Brightway Group PLC', 'Brightway Group'), true);
});
test('a different trading name is still an alias needing review', () => {
  assert.equal(sameSupplierIgnoringLegalSuffix('Water Plus Group Limited', 'Water Plus'), false);
  assert.equal(sameSupplierIgnoringLegalSuffix('Severn Trent Water Ltd', 'Water Plus'), false);
  assert.equal(sameSupplierIgnoringLegalSuffix('Limited', ''), false);
});
