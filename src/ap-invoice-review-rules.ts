/** Current evidence supersedes stale assessment warnings; original assessment stays immutable. */
export type ReviewEvidence = {supplierVerified:boolean;vatPolicyVerified:boolean;dueDateDefaulted:boolean};
export function reconcileInvoiceReviewIssues(issues:readonly string[], evidence:ReviewEvidence):string[] {
  return issues.filter(issue=>{
    if (/direct[ -]?debit|\bDD\b|payment initiated by direct debit/i.test(issue)) return false;
    if (evidence.vatPolicyVerified && /\bVAT\b|tax treatment|tax rate|net or VAT breakdown/i.test(issue)) return false;
    if (evidence.dueDateDefaulted && /due date defaults?|due date defaulted|30.day default/i.test(issue)) return false;
    if (evidence.supplierVerified && /supplier (?:not matched|unmatched|identity|verification required)|no matching (?:xero )?contact/i.test(issue)) return false;
    return true;
  });
}
/** Payment is handled at human review, never by the AP agent. Payment-processing
 * notices (payment platforms, duplicate-payment warnings, paid/overdue status) are
 * not invoice issues and are dropped. A credit, brought-forward or account balance
 * is kept only as ONE standard amount-uncertainty note. Neither ever blocks a draft.
 */
export const BALANCE_AMOUNT_NOTE='Amount uncertain: document shows a credit, brought-forward or account balance; gross taken from current-period charges - finance to confirm';
const BALANCE_ISSUE=/credit balance|\bin credit\b|brought[- ]forward|carried[- ]forward|account balance|negative balance|total amount\s*-\s*£/i;
const PAYMENT_ISSUE=/\bmodulr\b|payment[- ]platform|duplicate payment|invoice processing started|payment (?:is |may be )?(?:already )?in progress|already (?:been )?paid|payment (?:status|received|run|scheduled|processing|confirmation)|remittance advice|\boverdue\b/i;
export function applyPaymentIssuePolicy(issues:readonly string[]):string[] {
  const out:string[]=[];
  for (const issue of issues) {
    if (typeof issue!=='string' || !issue.trim()) continue;
    if (BALANCE_ISSUE.test(issue)) { if (!out.includes(BALANCE_AMOUNT_NOTE)) out.push(BALANCE_AMOUNT_NOTE); continue; }
    if (PAYMENT_ISSUE.test(issue)) continue;
    out.push(issue);
  }
  return out;
}
/** A named practice passes even with an individual above it. Historical fallback is
 * only accepted when both billing blocks can be identified and agree. */
export function billingRecipientCheck(incoming:string,historical?:string):'practice'|'historical_match'|'unverified' {
  const practice=/st\s*george[’'s\s.-]*road\s*surgery/i;
  if(practice.test(incoming)) return 'practice';
  if(!historical) return 'unverified';
  const extract=(text:string)=>{
    const m=text.match(/\bbilled[ \t]+to\b[ \t]*:?[ \t]*\r?\n[ \t]*([^\r\n]+)(?:\r?\n[ \t]*([^\r\n]+))?/i);
    return m ? [m[1],m[2]??''].map(v=>v.trim().toLowerCase().replace(/[^a-z0-9]/g,'')).filter(Boolean).join('|') : '';
  };
  const a=extract(incoming),b=extract(historical);
  return a && b && a===b ? 'historical_match' : 'unverified';
}
