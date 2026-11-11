/** Fail-closed document-body evidence gate before any Xero/PG write. */
export type DocumentReviewKind = 'not_invoice' | 'unclear';
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
    throw new DocumentNeedsHumanReview('not_invoice','Document is headed Receipt; an invoice reference on payment evidence does not make it an invoice');
  }
  if (/^(?:payment\s+)?receipt\b/i.test(firstLines[0]??'') && invoiceHeading) {
    throw new DocumentNeedsHumanReview('unclear','Conflicting receipt and invoice headings; human review required');
  }
  // A carried-forward credit or negative account balance is not the new
  // invoice total. Avoid choosing the wrong amount until the bill is reviewed.
  if (/\b(?:account\s+(?:is\s+)?in\s+credit|balance\s+(?:brought|carried)\s+forward|credit\s+brought\s+forward)\b/i.test(t)
      || /\b(?:account\s+balance|balance\s+due)\s*[:=–-]?\s*(?:-\s*[£$€]?|[£$€]\s*-|\(\s*[£$€])/i.test(t)) {
    throw new DocumentNeedsHumanReview('unclear','Account credit or carried-forward balance requires human verification of new charges versus account balance');
  }
  const type = /\b(?:tax\s+invoice|invoice|credit\s+note)\b/i.test(t);
  const reference = /\b(?:invoice|credit\s*note)\s*(?:number|no\.?|#|ref(?:erence)?\.?)\s*[:#-]?\s*[A-Z0-9][A-Z0-9/_-]{1,60}\b/i.test(t);
  const total = /\b(?:grand\s+total|total\s+(?:due|payable|amount)|amount\s+(?:due|payable)|balance\s+due|total\s+to\s+pay)\s*[:=–-]?\s*[£$€]?\s*\d/i.test(t);
  if (!type && !reference && !total) throw new DocumentNeedsHumanReview('not_invoice','No invoice or credit-note identifiers or payable total in document text');
  if (!type || !reference || !total) throw new DocumentNeedsHumanReview('unclear','Insufficient invoice evidence in document body: type, reference and payable total are required');
}

/** Critical PDF-derived fields must be certain before any live Xero access. */
export function requireVerifiedCriticalFields(candidates: {
  supplier: {uncertain:boolean}|null;
  reference: {uncertain:boolean}|null;
  grossAmount: {uncertain:boolean}|null;
  documentType: {uncertain:boolean}|null;
  currency: {uncertain:boolean}|null;
  uncertainFields: string[];
}): void {
  const critical = ['reference','grossAmount','documentType','currency'] as const;
  const missing = critical.filter(key=>!candidates[key] || candidates[key]!.uncertain);
  const flagged = candidates.uncertainFields.filter(key=>critical.some(k=>k===key));
  if (missing.length || flagged.length) throw new DocumentNeedsHumanReview('unclear',
    `Critical invoice fields require verification before Xero access: ${[...new Set([...missing,...flagged])].join(', ')}`);
}
