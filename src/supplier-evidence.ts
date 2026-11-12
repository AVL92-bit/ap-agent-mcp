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
 *  4. masthead      - a name line in the header directly above an address ending in a
 *                     UK postcode (e.g. 'Healthtech 1 / 91 Belmont Hill / London / SE13 5AX'),
 *                     before any bill-to block; never the practice or a person
 *  5. legal_name    - any capitalised company name ending Limited/Ltd/LLP/PLC,
 *                     searched across the WHOLE document
 * Payee, registration and legal-name searches run on the whole document with
 * whitespace (including PDF line breaks) collapsed, so split names still match.
 * Nothing here authorises a draft; tiers 2-4 are always uncertain evidence.
 */
export type SupplierTier = 'labelled' | 'payee' | 'registration' | 'masthead' | 'legal_name';
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
// A recipient LABEL ("Bill to", "Invoice to:", "Customer:"), not any line that starts
// with "customer" (e.g. "Customer Services", "Customer Information", customer.services@...).
const RECIPIENT = /^(?:(?:bill(?:ed)?|invoice|sold|ship|deliver(?:y)?)\s*to|recipient|customer(?:\s+(?:name|address|details))?)\s*(?::|$)|^to:/i;
const RECIPIENT_BLOCK_LINES = 5;
// A recipient block ends at the first invoice field (amounts, dates, totals, references).
const BLOCK_END = /[£$€]|\b(?:invoice|total|date|due|amount|vat|reference|account\s+number|supplier|from)\b/i;

const MASTHEAD_LINES = 25;
const ADDRESS_LINES = 5;
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/;
// A short name: starts with a letter, 2-60 chars, up to 6 words.
const MASTHEAD_NAME = /^[A-Za-z][A-Za-z0-9&'’().,-]*(?:\s+[A-Za-z0-9&'’().,-]+){0,5}$/;
// Field labels, document words and address-like lines are never a supplier name.
const NOT_A_NAME = /^(?:page|invoice|receipt|statement|credit\s+note|date|due|total|amount|subtotal|vat|tax|description|qty|bill(?:ed)?\s+to|ship\s+to|practice\s+name|account|customer|reference|order|po\b|tel|phone|email|e-mail|web|www|w:|t:|united\s+kingdom|england|london)\b/i;
const NOT_ADDRESS = /[£$€]|\b(?:invoice|total|amount|vat|due|date|visit|terms|conditions)\b|www\.|https?:|\.co\.uk\b|\.com\b/i;
// Currency codes and other short all-caps tokens (GBP, VAT, EUR) are never a supplier.
const CODE_TOKEN = /^[A-Z]{2,4}$/;
const PERSON = /^(?:dr|mr|mrs|ms|miss|prof)\.?\s/i;
// Pilot practice: never a supplier, whichever path asks.
export const PRACTICE_NAME = /\bst\.?\s*george['’]?s?\s*road\s*surgery\b/i;

export function rejectSupplierName(x: string): boolean {
  return /^(?:page\s+\d+\s+of\s+\d+|invoice|receipt|issue\s+date|registered\s+office|cheques?\s+payable|vat\s+(?:registration|number)|company\s+(?:number|registration)|account\s+number|total|amount|summary|date|and|or)\b/i.test(x)
    || /\b(?:road|street|postcode|telephone|email|www\.|@)\b/i.test(x);
}
const isName = (v: string) => v.length >= 2 && v.length <= 110 && /[a-z]/i.test(v)
  && !/^(?:\d|bank:|sort code|account number|vat number)/i.test(v);

export function assessSupplierEvidence(text: string, options: { exclude?: RegExp } = {}): SupplierAssessment {
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  const continuous = clean(text);
  const tiers: Record<SupplierTier, SupplierEvidence[]> = { labelled: [], payee: [], registration: [], masthead: [], legal_name: [] };

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
    && !recipientKeys.has(supplierComparisonKey(name)) && !PRACTICE_NAME.test(name)
    && !(options.exclude && options.exclude.test(name));
  const add = (tier: SupplierTier, value: string, evidence: string) => {
    // "A Division of Henry Schein UK Holdings Ltd" -> "Henry Schein UK Holdings Ltd"
    const v = clean(value).replace(/^(?:and|or)\s+/i, '')
      .replace(/^(?:an?\s+|the\s+)?(?:division|trading\s+name|subsidiary|part|member)\s+of\s+/i, '')
      .replace(/^(?:an?)\s+(?=[A-Z])/, '');
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

  // 4. Masthead: a name line in the header directly above an address ending in a UK postcode.
  for (let i = 0; i < Math.min(lines.length, MASTHEAD_LINES); i++) {
    if (RECIPIENT.test(lines[i])) break;
    const name = lines[i];
    if (!MASTHEAD_NAME.test(name) || NOT_A_NAME.test(name) || PERSON.test(name) || CODE_TOKEN.test(name) || NOT_ADDRESS.test(name)) continue;
    const following = lines.slice(i + 1, i + 1 + ADDRESS_LINES);
    const postcodeAt = following.findIndex(l => UK_POSTCODE.test(l));
    // The name sits above at least one street/town line, so a town line directly above
    // the postcode (e.g. "COVENTRY") is never taken as the supplier.
    if (postcodeAt < 1 || following.slice(0, postcodeAt).some(l => RECIPIENT.test(l) || NOT_ADDRESS.test(l))) continue;
    add('masthead', name, [name, ...following.slice(0, postcodeAt + 1)].join(' | '));
    i += postcodeAt + 1; // skip the rest of this address block
  }

  // 4. Whole-document legal-name fallback: any company name ending Ltd/Limited/LLP/PLC.
  for (const m of continuous.matchAll(legalNameGlobal())) {
    const start = Math.max(0, (m.index ?? 0) - 40);
    add('legal_name', m[1], continuous.slice(start, (m.index ?? 0) + m[0].length + 40));
  }

  return { selected: selectSupplier(tiers), tiers };
}

function selectSupplier(tiers: Record<SupplierTier, SupplierEvidence[]>): SupplierEvidence | null {
  for (const tier of ['labelled', 'payee', 'registration', 'masthead'] as const) if (tiers[tier].length) return tiers[tier][0];
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

/** Supplier names that differ only by a legal-form suffix (Ltd, Limited, PLC, LLP)
 * or a leading "The" are the same supplier, not an alias needing identity review.
 * A different trading name is still a different name. */
export function legalNameKey(s: string): string {
  return supplierComparisonKey(s)
    .replace(/^the\s+/, '')
    .replace(/(?:\s+(?:limited|ltd|plc|llp))+$/, '')
    .trim();
}
export function sameSupplierIgnoringLegalSuffix(a: string, b: string): boolean {
  const x = legalNameKey(a), y = legalNameKey(b);
  return !!x && x === y;
}
