/** Application-owned Front outcomes. Never treat a PostgreSQL review as Xero completion. */
export type ApOutcome = 'draft_clean' | 'draft_uncertain' | 'xero_existing' |
  'technical_failure' | 'finance_no_attachment' | 'non_finance_no_attachment';
export const FRONT_OUTCOME_POLICY: Record<ApOutcome,{tag:string;archive:boolean;sheet:boolean}> = {
  draft_clean:{tag:'AP Agent reviewed',archive:true,sheet:false},
  draft_uncertain:{tag:'Human review',archive:false,sheet:true},
  xero_existing:{tag:'AP Agent reviewed',archive:true,sheet:false},
  technical_failure:{tag:'Human review',archive:false,sheet:true},
  finance_no_attachment:{tag:'No attachment - Human review',archive:false,sheet:false},
  non_finance_no_attachment:{tag:'AP Agent reviewed',archive:true,sheet:false},
};
export function classifyNoAttachment(text:string):ApOutcome {
  // Direct Debit collection notices need no AP action (payment is handled by people). Judged on
  // the SUBJECT only: an invoice email that merely mentions Direct Debit is not a notice.
  const subject = text.split('\n')[0] ?? '';
  if (/\bdirect\s+debit\b/i.test(subject) && !/\binvoice\b/i.test(subject) &&
    /\b(?:upcoming|advance\s+notice|will\s+be\s+(?:collected|taken|debited)|due\s+to\s+be\s+(?:collected|taken)|collection\s+date|payment\s+(?:collection|will\s+be)|payment\s+to)\b/i.test(subject))
    return 'non_finance_no_attachment';
  return /\b(invoice|statement|reminder|overdue|credit note|payment due|bill|accounts payable)\b/i.test(text)
    ? 'finance_no_attachment' : 'non_finance_no_attachment';
}
