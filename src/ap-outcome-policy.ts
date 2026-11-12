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
  // Direct Debit collection notices need no AP action (payment is handled by people).
  if (/\bdirect\s+debit\b/i.test(text) &&
    /\b(?:upcoming|advance\s+notice|will\s+be\s+(?:collected|taken|debited)|due\s+to\s+be\s+(?:collected|taken)|collection\s+date|payment\s+(?:collection|will\s+be))\b/i.test(text))
    return 'non_finance_no_attachment';
  return /\b(invoice|statement|reminder|overdue|credit note|payment due|bill|accounts payable)\b/i.test(text)
    ? 'finance_no_attachment' : 'non_finance_no_attachment';
}
