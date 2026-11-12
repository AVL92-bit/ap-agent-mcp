/** Shared supplier-identity evidence for advisory invoice candidates
 * (invoice-candidates.ts) and review/readiness PDF supplier checks
 * (xero-review-drafts.ts pdfSupplierName). One implementation, so a supplier
 * found by get_invoice_attachment is the same supplier readiness verifies.
 *
 * Evidence tiers, strongest first:
 *  1. labelled      - "From:/Supplier:/Seller:/Vendor:/Issued by:" in the document header
 *  2. payee         - payment instructions ("cheques payable to X Ltd", "remit to X Ltd")
 *                     and labelled account-holder/beneficiary/payee names
 *  3. registration  - "X Limited (company number N)"
 *  4. legal_name    - any capitalised company name ending Limited/Ltd/LLP/PLC,
 *                     searched across the WHOLE document (not just the masthead)
 * Payee, registration and legal-name searches run on the whole document with
 * whitespace (including PDF line breaks) collapsed, so split names still match.
 * Nothing here authorises a draft; tiers 2-4 are always uncertain evidence.
 */
export type SupplierTier = 'labelled' | 'payee' | 'registration' | 'legal_name';
export type SupplierEvidence = { value: string; evidence: string; tier: SupplierTier };
export type SupplierAssessment = {
  selected: SupplierEvidence | null;
  tiers: Record<SupplierTier, SupplierEvidence[]>;
};

export const HEADER_LINES = 18;
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
export const supplierComparisonKey = (s: string) =>
  s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

const SUFFIX = '(?:Limited|LIMITED|Ltd|LTD|LLP|PLC|Plc)';
const PAYEE_LEAD = '(?:(?:cheques?|payments?)\\s+(?:should\\s+be\\s+)?(?:made\\s+)?payable\\s+to|(?:please\\s+)?(?:make\\s+)?payments?\\s+to|(?:remit|remittance)\\s+to|payable\\s+to)';
const PAYEE_NAME = `([A-Z][A-Za-z0-9 &'().-]{2,80}?\\s+${SUFFIX})\\b`;
const payeeLine = () => new RegExp(`\\b${PAYEE_LEAD}\\s*[:\\-]?\\s*${PAYEE_NAME}`, 'i');
const payeeGlobal = () => new RegExp(`\\b${PAYEE_LEAD}\\s*[:\\-]?\\s*${PAYEE_NAME}`, 'gi');
const registrationGlobal = () =>
  new RegExp(`\\b([A-Z][A-Za-z0-9 &'().-]{2,80}?\\s+${SUFFIX})\\s*\\(\\s*company\\s+(?:number|no\\.?)\\s+[A-Za-z0-9]+\\s*\\)`, 'gi');
// A run of 1-7 capitalised words (allowing "&", "and", "of" between them) ending in a legal suffix.
// Case-sensitive on purpose: lowercase prose words ("with", "to") end the run.
const legalNameGlobal = () =>
  new RegExp(`\\b((?!${SUFFIX}\\b)[A-Z][A-Za-z0-9'’-]*(?:\\s+(?:&|and|of|(?!${SUFFIX}\\b)[A-Z0-9][A-Za-z0-9'’-]*)){0,6}\\s+${SUFFIX})(?![A-Za-z])`, 'g');

const LABEL = /^(?:from|supplier|seller|vendor|issued\s+by)\s*[:\-]\s*/i;
const ACCOUNT_HOLDER = /^(?:account\s*(?:holder\s*)?name|beneficiary\s*name|payee\s*name)\s*[:\-]\s*/i;
const RECIPIENT = /^(?:bill\s*to|invoice\s*to|sold\s*to|customer|ship\s*to|deliver\s*to|billed\s*to|recipient|to:)\b/i;
const RECIPIENT_BLOCK_LINES = 5;
// A recipient block ends at the first invoice field (amounts, dates, totals, references).
const BLOCK_END = /[£$€]|\b(?:invoice|total|date|due|amount|vat|reference|account\s+number|supplier|from)\b/i;

export function rejectSupplierName(x: string): boolean {
  return /^(?:page\s+\d+\s+of\s+\d+|invoice|receipt|issue\s+date|registered\s+office|cheques?\s+payable|vat\s+(?:registration|number)|company\s+(?:number|registration)|account\s+number|total|amount|summary|date|and|or)\b/i.test(x)
    || /\b(?:road|street|postcode|telephone|email|www\.|@)\b/i.test(x);
}
const isName = (v: string) => v.length >= 2 && v.length <= 110 && /[a-z]/i.test(v)
  && !/^(?:\d|bank:|sort code|account number|vat number)/i.test(v);

export function assessSupplierEvidence(text: string, options: { exclude?: RegExp } = {}): SupplierAssessment {
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  const continuous = clean(text);
  const tiers: Record<SupplierTier, SupplierEvidence[]> = { labelled: [], payee: [], registration: [], legal_name: [] };

  // Names printed in a bill-to/customer block are never supplier evidence.
  const recipientKeys = new Set<string>();
  lines.forEach((line, i) => {
    if (!RECIPIENT.test(line)) return;
    const blockLines = [line.replace(RECIPIENT, '').replace(/^\s*[:\-]\s*/, '')];
    for (const next of lines.slice(i + 1, i + 1 + RECIPIENT_BLOCK_LINES)) {
      if (BLOCK_END.test(next) || RECIPIENT.test(next)) break;
      blockLines.push(next);
    }
    for (const m of clean(blockLines.join(' ')).matchAll(legalNameGlobal())) recipientKeys.add(supplierComparisonKey(m[1]));
    for (const l of blockLines) if (l) recipientKeys.add(supplierComparisonKey(l));
  });
  const allowed = (name: string) => !!name && !rejectSupplierName(name)
    && !recipientKeys.has(supplierComparisonKey(name)) && !(options.exclude && options.exclude.test(name));
  const add = (tier: SupplierTier, value: string, evidence: string) => {
    const v = clean(value).replace(/^(?:and|or)\s+/i, '');
    if (allowed(v)) tiers[tier].push({ value: v, evidence: clean(evidence), tier });
  };

  // 1. Labelled supplier: header only, before any recipient block.
  const header = lines.slice(0, HEADER_LINES);
  for (let i = 0; i < header.length; i++) {
    if (RECIPIENT.test(header[i])) break;
    if (!LABEL.test(header[i])) continue;
    const sameLine = header[i].replace(LABEL, '').trim();
    const value = sameLine || (header[i + 1] ?? '');
    if (isName(value)) add('labelled', value, sameLine ? header[i] : `${header[i]} ${value}`);
  }

  // 2. Payment recipient: per line, then across line breaks; then labelled account holders.
  for (const line of lines) {
    const m = line.match(payeeLine());
    if (m) add('payee', m[1], line);
  }
  for (const m of continuous.matchAll(payeeGlobal())) add('payee', m[1], m[0]);
  lines.forEach((line, i) => {
    if (!ACCOUNT_HOLDER.test(line)) return;
    const sameLine = line.replace(ACCOUNT_HOLDER, '').trim();
    const value = sameLine || (lines[i + 1] ?? '');
    if (isName(value)) add('payee', value, sameLine ? line : `${line} ${value}`);
  });

  // 3. Company registration statements (may list several group entities).
  for (const m of continuous.matchAll(registrationGlobal())) add('registration', m[1], m[0]);

  // 4. Whole-document legal-name fallback: any company name ending Ltd/Limited/LLP/PLC.
  for (const m of continuous.matchAll(legalNameGlobal())) {
    const start = Math.max(0, (m.index ?? 0) - 40);
    add('legal_name', m[1], continuous.slice(start, (m.index ?? 0) + m[0].length + 40));
  }

  return { selected: selectSupplier(tiers), tiers };
}

function selectSupplier(tiers: Record<SupplierTier, SupplierEvidence[]>): SupplierEvidence | null {
  for (const tier of ['labelled', 'payee', 'registration'] as const) if (tiers[tier].length) return tiers[tier][0];
  const legal = tiers.legal_name;
  if (!legal.length) return null;
  // Most frequently printed legal name wins; ties keep document order.
  const counts = new Map<string, number>();
  for (const e of legal) counts.set(supplierComparisonKey(e.value), (counts.get(supplierComparisonKey(e.value)) ?? 0) + 1);
  return legal.reduce((best, e) =>
    (counts.get(supplierComparisonKey(e.value))! > counts.get(supplierComparisonKey(best.value))! ? e : best), legal[0]);
}

export function distinctSupplierNames(evidence: SupplierEvidence[]): string[] {
  return [...new Set(evidence.map(e => supplierComparisonKey(e.value)))];
}

/** Readiness/review identity: one comparable supplier name printed on the PDF, or null.
 * Same evidence and order as assessSupplierEvidence, but conflicting labelled-issuer or
 * payee identities fail closed rather than picking one.
 */
export function printedSupplierName(text: string, options: { exclude?: RegExp } = {}): string | null {
  const assessment = assessSupplierEvidence(text, options);
  const labelled = distinctSupplierNames(assessment.tiers.labelled);
  const payees = distinctSupplierNames(assessment.tiers.payee);
  if (labelled.length > 1 || payees.length > 1) return null;
  if (labelled.length === 1 && payees.length === 1 && labelled[0] !== payees[0]) return null;
  return assessment.selected ? supplierComparisonKey(assessment.selected.value) : null;
}
