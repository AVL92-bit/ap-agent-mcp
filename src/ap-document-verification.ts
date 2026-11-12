/** Fail-closed document-body evidence gate before any Xero/PG write. */
/** supporting_document: payment evidence such as a receipt. Never drafted, never a failure. */
export type DocumentReviewKind = 'not_invoice' | 'unclear' | 'supporting_document';
export class DocumentNeedsHumanReview extends Error {
  constructor(public readonly kind: DocumentReviewKind, reason: string) {
    super(reason); this.name = 'DocumentNeedsHumanReview';
  }
}
export function verifyInvoiceDocumentText(text: string): void {
  const t = text.trim();
  if (!t) throw new DocumentNeedsHumanReview('unclear','Document contains no extractable text');
  // The document's own heading outranks incidental invoice references on receipts.
  // A receipt can quote an invoice number, total and payment status without
  // being an invoice. Do not let those references authorise Xero writes.
  const firstLines = t.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).slice(0,8);
  const receiptHeading = firstLines.some(line=>/^(?:payment\s+)?receipt\b(?:\s*(?:number|no\.?|#|ref(?:erence)?\.?|[:#-]).*)?$/i.test(line))
    || /^(?:payment\s+)?receipt\b/i.test(firstLines[0]??'');
  const invoiceHeading = firstLines.some(line=>/^(?:(?:tax\s+)?invoice|credit\s+note)\s*[:#-]?\s*$/i.test(line));
  if (receiptHeading && !invoiceHeading) {
    throw new DocumentNeedsHumanReview('supporting_document','Receipt: supporting document only; never posted to Xero');
  }
  if (/^(?:payment\s+)?receipt\b/i.test(firstLines[0]??'') && invoiceHeading) {
    throw new DocumentNeedsHumanReview('unclear','Conflicting receipt and invoice headings; human review required');
  }
  // Carried-forward credits are not the new invoice amount. Permit drafting only
  // when an explicitly labelled positive current-period charge is present;
  // the extraction layer marks that amount uncertain for human review.
  const accountCredit=/\b(?:account\s+(?:is\s+)?in\s+credit|balance\s+(?:brought|carried)\s+forward|credit\s+brought\s+forward)\b/i.test(t)
    || /\b(?:account\s+balance|balance\s+due)\s*[:=–-]?\s*(?:-\s*[£$€]?|[£$€]\s*-|\(\s*[£$€])/i.test(t);
  const periodCharge=/\b(?:total\s+charges\s+for\s+(?:this|the)\s+period|total\s+invoice\s+charges)\s*[:=–-]?\s*[£$€]?\s*\d+(?:[,.]\d+)*\b/i.test(t);
  if(accountCredit && !periodCharge) throw new DocumentNeedsHumanReview('unclear',
    'Carried-forward credit present but no explicit positive current-period charges; human review required');
  const type = /\b(?:tax\s+invoice|invoice|credit\s+note)\b/i.test(t);
  const reference = /\b(?:invoice|credit\s*note)\s*(?:number|no\.?|#|ref(?:erence)?\.?)\s*[:#-]?\s*[A-Z0-9][A-Z0-9/_-]{1,60}\b/i.test(t);
  const total = /\b(?:grand\s+total|total\s+(?:due|payable|amount)|amount\s+(?:due|payable)|balance\s+due|total\s+to\s+pay)\s*[:=–-]?\s*[£$€]?\s*\d/i.test(t);
  if (!type && !reference && !total) throw new DocumentNeedsHumanReview('not_invoice','No invoice or credit-note identifiers or payable total in document text');
  if (!type || !reference || !(total || (accountCredit && periodCharge))) throw new DocumentNeedsHumanReview('unclear','Insufficient invoice evidence in document body: type, reference and payable total are required');
}

/** Critical PDF-derived fields must be certain before any live Xero access. */
export function requireVerifiedCriticalFields(candidates: {
  supplier: {uncertain:boolean}|null;
  reference: {uncertain:boolean}|null;
  grossAmount: {uncertain:boolean; evidence?:string}|null;
  accountBalance?: {value:string}|null;
  documentType: {uncertain:boolean}|null;
  currency: {uncertain:boolean}|null;
  uncertainFields: string[];
}): void {
  const critical = ['reference','grossAmount','documentType','currency'] as const;
  const creditPeriodAmount=!!candidates.accountBalance && !!candidates.grossAmount?.uncertain &&
    /\b(?:total\s+charges\s+for\s+(?:this|the)\s+period|total\s+invoice\s+charges)\b/i.test(candidates.grossAmount.evidence??'');
  const missing = critical.filter(key=>!candidates[key] || (candidates[key]!.uncertain && !(key==='grossAmount' && creditPeriodAmount)));
  const flagged = candidates.uncertainFields.filter(key=>critical.some(k=>k===key) && !(key==='grossAmount' && creditPeriodAmount));
  if (missing.length || flagged.length) throw new DocumentNeedsHumanReview('unclear',
    `Critical invoice fields require verification before Xero access: ${[...new Set([...missing,...flagged])].join(', ')}`);
}
