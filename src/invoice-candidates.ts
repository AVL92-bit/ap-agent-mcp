/** Deterministic, advisory extraction of candidate invoice fields from embedded document text.
 * These candidates never authorise or veto a Xero draft. Preserve raw evidence and
 * surface uncertainty; Xero contact/coding selection and document reconciliation
 * are separate application-controlled steps.
 */
export type CandidateField = { value: string; evidence: string; uncertain: boolean };
export type InvoiceCandidates = {
  documentType: CandidateField;
  supplier: CandidateField | null;
  reference: CandidateField | null;
  invoiceDate: CandidateField | null;
  dueDate: CandidateField | null;
  grossAmount: CandidateField | null;
  currency: CandidateField;
  uncertainFields: string[];
};
const field = (value:string,evidence:string,uncertain=false):CandidateField => ({value,evidence,uncertain});
const clean = (s:string)=>s.replace(/\s+/g,' ').trim();
const matchField = (lines:string[],regex:RegExp):CandidateField|null => {
  for(const line of lines){const match=line.match(regex); if(match?.[1])return field(clean(match[1]),clean(line));}
  return null;
};
export function extractInvoiceCandidates(text:string):InvoiceCandidates {
  const lines=text.split(/\r?\n/).map(clean).filter(Boolean);
  const header=lines.slice(0,18);
  const isCredit=/\bcredit\s+note\b/i.test(text);
  const documentType=field(isCredit?'credit_note':'invoice',isCredit?'Credit note wording found':'No credit note wording found',!isCredit && !/\binvoice\b/i.test(text));
  const reference=matchField(lines,/\b(?:invoice|credit\s*note)\s*(?:number|no\.?|#|ref(?:erence)?\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_-]{1,60})\b/i);
  const invoiceDate=matchField(lines,/\b(?:invoice\s*date|date\s*of\s*invoice|credit\s*note\s*date)\s*[:#-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i);
  const dueDate=matchField(lines,/\b(?:due\s*date|payment\s*due)\s*[:#-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i);
  // Prefer explicitly payable/gross totals. Never infer gross from a VAT, subtotal,
  // unit price or arbitrary line-item amount. Accept whole-pound and UK comma amounts.
  const money = '([£$€]?\\s*(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?)';
  const totalLabels = /\b(?:grand\s+total|total\s+(?:due|payable|amount|inc(?:luding)?\.?\s*vat|gross)|amount\s+(?:due|payable)|balance\s+due|total\s+to\s+pay)\b/i;
  let grossAmount: CandidateField | null = null;
  for (const line of lines) {
    const label = totalLabels.exec(line);
    if (!label) continue;
    const after = line.slice(label.index + label[0].length).replace(/^\s*[:=–-]\s*/, '');
    const m = after.match(new RegExp('^' + money + '(?=\\s|$|\\b)', 'i'));
    if (m && Number(m[1].replace(/[^\d.]/g,'')) > 0) {
      grossAmount = field(clean(m[1]),line); break;
    }
  }
  // An unqualified TOTAL is common but potentially ambiguous when VAT is separate.
  // Retain it as a candidate and explicitly flag the uncertainty.
  if (!grossAmount) {
    for (const line of lines) {
      const m = line.match(new RegExp('^total\\s*[:=–-]\\s*' + money + '(?=\\s|$)', 'i'));
      if (m && Number(m[1].replace(/[^\d.]/g,'')) > 0) {
        grossAmount = field(clean(m[1]),line,true); break;
      }
    }
  }
  const supplierLine=header.find(x=> /^(?:from|supplier|vendor|issued\s+by)\s*:/i.test(x));
  const supplier=supplierLine?field(clean(supplierLine.replace(/^(?:from|supplier|vendor|issued\s+by)\s*:/i,'')),supplierLine):null;
  const currency=field(/€|\bEUR\b/i.test(text)?'EUR':/\$|\bUSD\b/i.test(text)?'USD':'GBP','Currency inferred from document symbols or default GBP',!/£|\bGBP\b|€|\bEUR\b|\$|\bUSD\b/i.test(text));
  const result={documentType,supplier,reference,invoiceDate,dueDate,grossAmount,currency};
  const uncertainFields=Object.entries(result).filter(([k,v])=>v===null || v.uncertain).map(([k])=>k);
  return {...result,uncertainFields};
}
