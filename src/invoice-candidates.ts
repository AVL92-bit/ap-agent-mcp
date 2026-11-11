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
  accountBalance: CandidateField | null;
  amountPaid: CandidateField | null;
  linkedInvoiceReference: CandidateField | null;
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
  const receipt = header.some(line=>/^(?:payment\s+)?receipt(?:\s*(?:number|no\.?|#|[:#-]).*)?$/i.test(line))
    || /^(?:payment\s+)?receipt\b/i.test(header[0]??'');
  const isCredit=/\bcredit\s+note\b/i.test(text);
  const documentType=field(receipt?'receipt':isCredit?'credit_note':'invoice',
    receipt?'Receipt heading found':isCredit?'Credit note wording found':'Invoice wording assessed',
    receipt || (!isCredit && !/\binvoice\b/i.test(text)));
  const reference=receipt
    ? matchField(lines,/\breceipt\s*(?:number|no\.?|#|ref(?:erence)?\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_-]{1,60})\b/i)
    : matchField(lines,/\b(?:invoice|credit\s*note)\s*(?:number|no\.?|#|ref(?:erence)?\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_-]{1,60})\b/i)
      ?? matchField(lines,/\b(?:summary\s+of\s+charges\s*:\s*)?invoice\s+([A-Z][A-Z0-9/_-]{3,60})\b/i);
  // Embedded PDF text may contain a control character in place of a reference separator.
  // Do not invent the missing character or present a partial identifier as certain.
  if (reference) {
    const evidenceLine = text.split(/\r?\n/).find(line => clean(line) === reference.evidence);
    if (evidenceLine && /[\x00-\x1f\x7f]/.test(evidenceLine)) reference.uncertain = true;
  }
  const linkedInvoiceReference=receipt
    ? matchField(lines,/\binvoice\s*(?:number|no\.?|#|ref(?:erence)?\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_-]{1,60})\b/i)
    : null;
  if (linkedInvoiceReference) {
    const raw = text.split(/\r?\n/).find(line => clean(line) === linkedInvoiceReference.evidence);
    if (raw && /[\x00-\x1f\x7f]/.test(raw)) linkedInvoiceReference.uncertain=true;
  }
  const invoiceDate=matchField(lines,/\b(?:invoice\s*date|date\s*of\s*invoice|credit\s*note\s*date|issue\s*date)\s*[:#-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]+\s+\d{4})\b/i);
  if (invoiceDate && /[A-Za-z]/.test(invoiceDate.value)) invoiceDate.uncertain=true;
  const dueDate=matchField(lines,/\b(?:due\s*date|payment\s*due)\s*[:#-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/i);
  // Prefer explicitly payable/gross totals. Never infer gross from a VAT, subtotal,
  // unit price or arbitrary line-item amount. Accept whole-pound and UK comma amounts.
  const money = '([£$€]?\\s*[+-]?\\s*(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?)';
  const accountCredit=/\b(?:credit\s+brought\s+forward|balance\s+carried\s+forward|account\s+in\s+credit)\b|\b(?:total\s+amount|account\s+balance)\s*[:=–-]?\s*-£/i.test(text);
  const totalLabels = accountCredit
    ? /\b(?:total\s+charges\s+for\s+(?:this|the)\s+period|total\s+invoice\s+charges)\b/i
    : /\b(?:total\s+charges\s+for\s+(?:this|the)\s+period|grand\s+total|total\s+(?:due|payable|amount|inc(?:luding)?\.?\s*vat|gross)|amount\s+(?:due|payable)|balance\s+due|total\s+to\s+pay)\b/i;
  let grossAmount: CandidateField | null = null;
  if (!receipt) for (const line of lines) {
    const label = totalLabels.exec(line);
    if (!label) continue;
    const after = line.slice(label.index + label[0].length).replace(/^\s*[:=–]\s*/, '').trim();
    const m = after.match(new RegExp('^' + money + '(?=\\s|$)', 'i'));
    if (!m) continue;
    const signed = Number(m[1].replace(/[^\d.+-]/g,''));
    if (Number.isFinite(signed) && signed > 0) {
      grossAmount = field(clean(m[1]),line,accountCredit); break;
    }
  }
  // An unqualified TOTAL is common but potentially ambiguous when VAT is separate.
  // Retain it as a candidate and explicitly flag the uncertainty.
  if (!grossAmount && !accountCredit && !receipt) {
    for (const line of lines) {
      const m = line.match(new RegExp('^total\\s*[:=–-]\\s*' + money + '(?=\\s|$)', 'i'));
      if (m && Number(m[1].replace(/[^\d.]/g,'')) > 0) {
        grossAmount = field(clean(m[1]),line,true); break;
      }
    }
  }
  const amountPaid=receipt?matchField(lines,/\bamount\s+paid\s*[:=]?\s*([£$€]?\s*\d[\d,]*(?:\.\d{1,2})?)\b/i):null;
  const accountBalance=matchField(lines,/\b(?:total\s+amount|account\s+balance|balance\s+carried\s+forward)\s*[:=]?\s*([-−]?[£$€]?\s*\d[\d,]*(?:\.\d{1,2})?)\b/i);
  const supplierLine=header.find(x=> /^(?:from|supplier|vendor|issued\s+by)\s*:/i.test(x));
  const supplier=supplierLine
    ? field(clean(supplierLine.replace(/^(?:from|supplier|vendor|issued\s+by)\s*:/i,'')),supplierLine)
    : (()=>{const name=header.find(line=>/^[A-Z][A-Za-z0-9 &'().-]{2,80}\s+(?:Limited|Ltd|LLP|PLC)$/i.test(line) || (receipt && /^[A-Z][A-Za-z]+(?:\s+[A-Za-z0-9]+){1,3}$/.test(line) && !/^(?:payment\s+)?receipt\b/i.test(line)));return name?field(name,name,true):null;})();
  const currency=field(/€|\bEUR\b/i.test(text)?'EUR':/\$|\bUSD\b/i.test(text)?'USD':'GBP','Currency inferred from document symbols or default GBP',!/£|\bGBP\b|€|\bEUR\b|\$|\bUSD\b/i.test(text));
  const result={documentType,supplier,reference,invoiceDate,dueDate,grossAmount,currency,accountBalance,amountPaid,linkedInvoiceReference};
  const critical={documentType,supplier,reference,invoiceDate,dueDate,grossAmount,currency};
  const uncertainFields=Object.entries(critical).filter(([k,v])=>v===null || v.uncertain).map(([k])=>k);
  for(const [key,value] of Object.entries({accountBalance,amountPaid,linkedInvoiceReference})) if(value?.uncertain) uncertainFields.push(key);
  return {...result,uncertainFields};
}
