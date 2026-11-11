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
  const type = /\b(?:tax\s+invoice|invoice|credit\s+note)\b/i.test(t);
  const reference = /\b(?:invoice|credit\s*note)\s*(?:number|no\.?|#|ref(?:erence)?\.?)\s*[:#-]?\s*[A-Z0-9][A-Z0-9/_-]{1,60}\b/i.test(t);
  const total = /\b(?:grand\s+total|total\s+(?:due|payable|amount)|amount\s+(?:due|payable)|balance\s+due|total\s+to\s+pay)\s*[:=–-]?\s*[£$€]?\s*\d/i.test(t);
  if (!type && !reference && !total) throw new DocumentNeedsHumanReview('not_invoice','No invoice or credit-note identifiers or payable total in document text');
  if (!type || !reference || !total) throw new DocumentNeedsHumanReview('unclear','Insufficient invoice evidence in document body: type, reference and payable total are required');
}
