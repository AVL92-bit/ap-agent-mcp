/** Best-candidate selection for draft-only AP. No score is a posting veto. */
export type ContactCandidate = { id: string; name: string; defaultPurchaseCode?: string };
export type AccountCandidate = { code: string; name: string; type: string; status: string };
export type Selection<T> = { value: T; uncertainFields: string[]; explanation: string; score?: number };
// Legal forms and bookkeeping tags such as "(DD)" / "Direct Debit" are not part of a supplier's name.
const norm = (s: string): string => s.toLowerCase().replace(/\(\s*dd\s*\)|\bdirect\s+debit\b/g, ' ')
  .replace(/\b(ltd|limited|plc|llp|the)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/(?:\s+dd)+$/, '').trim();
export function supplierScore(source: string, candidate: string): number {
  const a = norm(source), b = norm(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = new Set(a.split(' ')), y = new Set(b.split(' '));
  const intersection = [...x].filter(t => y.has(t)).length;
  return intersection / Math.max(x.size, y.size);
}
/** Character similarity of two normalised names (Sorensen-Dice on character pairs): 1 = identical, 0 = nothing
 * in common. Catches names that share characters but few whole words, e.g. "Focus 4 U" and "Focus House". */
export function characterScore(source: string, candidate: string): number {
  const a = norm(source), b = norm(candidate);
  if (a.length < 3 || b.length < 3) return a === b && a.length > 0 ? 1 : 0;
  if (a === b) return 1;
  const pairs = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const x = pairs(a), y = pairs(b);
  let shared = 0, total = 0;
  for (const [g, n] of x) { shared += Math.min(n, y.get(g) ?? 0); total += n; }
  for (const n of y.values()) total += n;
  return total ? (2 * shared) / total : 0;
}
/** Owner decision 2026-11-20: when no contact shares enough WORDS (over 40%), fall back to similarity on
 * CHARACTERS, strictly over 50%. A character-only match is always uncertain (supplier flagged for finance). */
export const CHARACTER_MATCH_THRESHOLD = 0.5;
function chooseSupplierByCharacters(source: string, valid: ContactCandidate[]): Selection<ContactCandidate> | null {
  const ranked = valid.map(value => ({value, score: characterScore(source, value.name)}))
    .sort((a,b) => b.score - a.score || a.value.name.localeCompare(b.value.name) || a.value.id.localeCompare(b.value.id));
  const first = ranked[0];
  if (!first || first.score <= CHARACTER_MATCH_THRESHOLD) return null;
  return {value:first.value, score:first.score, uncertainFields:['supplier'],
    explanation:'Character-similarity match (over 50%); finance to verify'};
}
export function chooseSupplier(source_: string, contacts: ContactCandidate[]): Selection<ContactCandidate> | null {
  const source = source_;
  const valid = contacts.filter(c => c.id && c.name);
  if (!valid.length) return null;
  const ranked = valid.map(value => ({value, score: supplierScore(source, value.name)}))
    .sort((a,b) => b.score - a.score || a.value.name.localeCompare(b.value.name) || a.value.id.localeCompare(b.value.id));
  const first = ranked[0];
  // Only existing Xero contacts with strictly greater than 40% word similarity qualify first; otherwise
  // the character-similarity fallback (over 50%) is tried.
  if (first.score <= 0.40) return chooseSupplierByCharacters(source, valid);
  // Every word of the contact's name appears in the document's supplier name (e.g. "Henry Schein"
  // in "Henry Schein Medical", "Modulr" in "Modulr Finance") and no other contact qualifies that way:
  // the same supplier, not an uncertain match.
  const tokens = (s: string) => new Set(norm(s).split(' ').filter(Boolean));
  const sourceTokens = tokens(source_);
  const contained = (name: string) => { const t = tokens(name); return t.size > 0 && [...t].every(x => sourceTokens.has(x)); };
  // Extra words that name a different legal entity (e.g. "Water Plus Group" vs "Water Plus") never count.
  const ENTITY_WORDS = new Set(['group', 'holdings', 'holding', 'select', 'trust', 'partnership', 'international', 'parent']);
  const extraWords = [...sourceTokens].filter(x => !tokens(first.value.name).has(x));
  const uniqueContainment = contained(first.value.name) && valid.filter(c => contained(c.name)).length === 1
    && !extraWords.some(w => ENTITY_WORDS.has(w));
  const ambiguous = (first.score < 1 && !uniqueContainment) || (ranked[1] && ranked[1].score === first.score);
  return {value:first.value, score:first.score, uncertainFields: ambiguous ? ['supplier'] : [],
    explanation: ambiguous ? 'Best available supplier contact; finance to verify' : 'Normalised supplier name match'};
}
/** Accounts the agent may post to (owner decision 2026-11-19): expense accounts, plus prepayment accounts
 * when the supplier's previous invoice used one. This is an ALLOWLIST using Xero's real account types:
 * everything else (bank, liabilities, non-current assets, depreciation, payroll, inventory, revenue,
 * equity and so on) needs a human. */
export const POSTABLE_EXPENSE_TYPES = new Set(['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS']);
/** A prepayment account: Xero's PREPAYMENT type, or a current-asset account whose name says prepayment.
 * Only followed when the supplier's previous invoice used the same account. */
export function isPrepaymentAccount(a: AccountCandidate): boolean {
  const type = a.type.toUpperCase();
  return type === 'PREPAYMENT' || (type === 'CURRENT' && /prepayment/i.test(a.name));
}
/** Coding follows the selected supplier, never a generic fallback: the supplier's
 * latest approved/paid bill code, else that contact's own Xero default purchase
 * account (uncertain). Otherwise null: the invoice is not drafted (Human Review). */
export function chooseAccount(accounts: AccountCandidate[], historical?: string, contactDefault?: string): Selection<AccountCandidate> | null {
  const active = accounts.filter(a => a.code && a.status.toUpperCase() === 'ACTIVE' && POSTABLE_EXPENSE_TYPES.has(a.type.toUpperCase()));
  const byCode = (code?: string) => code ? active.find(a => a.code === code) : undefined;
  const fromHistory = byCode(historical);
  if (fromHistory) return {value:fromHistory,uncertainFields:[],explanation:'Historical supplier account selected'};
  // Previous invoice from this supplier was posted to a prepayment account: follow it.
  const prepaymentFromHistory = historical
    ? accounts.find(a => a.code === historical && a.status.toUpperCase() === 'ACTIVE' && isPrepaymentAccount(a)) : undefined;
  if (prepaymentFromHistory) return {value:prepaymentFromHistory,uncertainFields:[],explanation:'Historical supplier account selected (prepayment account)'};
  const fromContact = byCode(contactDefault);
  if (fromContact) return {value:fromContact,uncertainFields:['accountCode'],
    explanation:'No supplier bill history; Xero contact default purchase account used - finance to verify'};
  return null;
}
