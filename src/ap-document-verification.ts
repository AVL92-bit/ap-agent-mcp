/** Fail-closed document-body evidence gate before any Xero/PG write. */
/** supporting_document: payment evidence such as a receipt. Never drafted, never a failure. */
export type DocumentReviewKind = 'not_invoice' | 'unclear' | 'supporting_document';
export class DocumentNeedsHumanReview extends Error {
  constructor(public readonly kind: DocumentReviewKind, reason: string) {
    super(reason); this.name = 'DocumentNeedsHumanReview';
  }
}
/** Text-level document check. Policy: only the agreed blockers stop a draft; everything
 * else (credit balances, uncertain fields, unusual layouts) is a review note.
 * - A document headed "Receipt" is a supporting document: never posted, never a failure.
 * - Text-only fallback (model unavailable): a document with no invoice/credit wording,
 *   no reference and no payable total is not an invoice.
 * Whether a document is an invoice is otherwise decided by model extraction. */
export function verifyInvoiceDocumentText(text: string, options: { textOnly?: boolean } = { textOnly: true }): void {
  const t = text.trim();
  if (!t) return; // scans: model extraction reads the page images
  const firstLines = t.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).slice(0,8);
  const receiptHeading = firstLines.some(line=>/^(?:payment\s+)?receipt\b(?:\s*(?:number|no\.?|#|ref(?:erence)?\.?|[:#-]).*)?$/i.test(line))
    || /^(?:payment\s+)?receipt\b/i.test(firstLines[0]??'');
  const invoiceHeading = firstLines.some(line=>/^(?:(?:tax\s+)?invoice|credit\s+note)\s*[:#-]?\s*$/i.test(line));
  if (receiptHeading && !invoiceHeading) {
    throw new DocumentNeedsHumanReview('supporting_document','Receipt: supporting document only; never posted to Xero');
  }
  if (!options.textOnly) return;
  const type = /\b(?:tax\s+invoice|invoice|credit\s+note)\b/i.test(t);
  const reference = /\b(?:invoice|credit\s*note)\s*(?:number|no\.?|#|ref(?:erence)?\.?)\s*[:#-]?\s*[A-Z0-9][A-Z0-9/_-]{1,60}\b/i.test(t);
  const total = /\b(?:grand\s+total|total\s+(?:due|payable|amount|charges)|amount\s+(?:due|payable)|balance\s+due|total\s+to\s+pay|total)\s*[:=–-]?\s*[£$€]?\s*\d/i.test(t);
  if (!type && !reference && !total) throw new DocumentNeedsHumanReview('not_invoice','No invoice or credit-note identifiers or payable total in document text');
}

