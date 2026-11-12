/** Best-candidate selection for draft-only AP. No score is a posting veto. */
export type ContactCandidate = { id: string; name: string; defaultPurchaseCode?: string };
export type AccountCandidate = { code: string; name: string; type: string; status: string };
export type Selection<T> = { value: T; uncertainFields: string[]; explanation: string; score?: number };
const norm = (s: string): string => s.toLowerCase().replace(/\b(ltd|limited|plc|llp|the)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
export function supplierScore(source: string, candidate: string): number {
  const a = norm(source), b = norm(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = new Set(a.split(' ')), y = new Set(b.split(' '));
  const intersection = [...x].filter(t => y.has(t)).length;
  return intersection / Math.max(x.size, y.size);
}
export function chooseSupplier(source: string, contacts: ContactCandidate[]): Selection<ContactCandidate> | null {
  const valid = contacts.filter(c => c.id && c.name);
  if (!valid.length) return null;
  const ranked = valid.map(value => ({value, score: supplierScore(source, value.name)}))
    .sort((a,b) => b.score - a.score || a.value.name.localeCompare(b.value.name) || a.value.id.localeCompare(b.value.id));
  const first = ranked[0];
  // Only existing Xero contacts with strictly greater than 40% similarity qualify.
  if (first.score <= 0.40) return null;
  const ambiguous = first.score < 1 || (ranked[1] && ranked[1].score === first.score);
  return {value:first.value, score:first.score, uncertainFields: ambiguous ? ['supplier'] : [],
    explanation: ambiguous ? 'Best available supplier contact; finance to verify' : 'Normalised supplier name match'};
}
const EXCLUDED = new Set(['BANK','REVENUE','EQUITY','LIABILITY','CURRENTLIAB','FIXED','CURRENT']);
/** Coding follows the selected supplier, never a generic fallback: the supplier's
 * latest approved/paid bill code, else that contact's own Xero default purchase
 * account (uncertain). Otherwise null: the invoice is not drafted (Human Review). */
export function chooseAccount(accounts: AccountCandidate[], historical?: string, contactDefault?: string): Selection<AccountCandidate> | null {
  const active = accounts.filter(a => a.code && a.status.toUpperCase() === 'ACTIVE' && !EXCLUDED.has(a.type.toUpperCase()));
  const byCode = (code?: string) => code ? active.find(a => a.code === code) : undefined;
  const fromHistory = byCode(historical);
  if (fromHistory) return {value:fromHistory,uncertainFields:[],explanation:'Historical supplier account selected'};
  const fromContact = byCode(contactDefault);
  if (fromContact) return {value:fromContact,uncertainFields:['accountCode'],
    explanation:'No supplier bill history; Xero contact default purchase account used - finance to verify'};
  return null;
}
