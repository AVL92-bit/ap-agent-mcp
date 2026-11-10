/** Runtime counterpart of the typed selection module for Node type-stripping tests. */
const norm = s => s.toLowerCase().replace(/\b(ltd|limited|plc|llp|the)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
export function supplierScore(source, candidate) {
  const a = norm(source), b = norm(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = new Set(a.split(' ')), y = new Set(b.split(' '));
  return [...x].filter(t => y.has(t)).length / Math.max(x.size, y.size);
}
export function chooseSupplier(source, contacts) {
  const valid = contacts.filter(c => c.id && c.name);
  if (!valid.length) return null;
  const ranked = valid.map(value => ({value, score: supplierScore(source, value.name)}))
    .sort((a,b) => b.score - a.score || a.value.name.localeCompare(b.value.name) || a.value.id.localeCompare(b.value.id));
  const first = ranked[0];
  if (first.score < 0.72) return null;
  const ambiguous = first.score < 1 || (ranked[1] && ranked[1].score === first.score);
  return {value:first.value, uncertainFields: ambiguous ? ['supplier'] : [],
    explanation: ambiguous ? 'Best available supplier contact; finance to verify' : 'Normalised supplier name match'};
}
const EXCLUDED = new Set(['BANK','REVENUE','EQUITY','LIABILITY','CURRENTLIAB','FIXED','CURRENT']);
export function chooseAccount(accounts, preferred, fallback) {
  const active = accounts.filter(a => a.code && a.status.toUpperCase() === 'ACTIVE' && !EXCLUDED.has(a.type.toUpperCase()));
  if (!active.length) throw new Error('No active expense account exists in Xero');
  const byCode = code => active.find(a => a.code === code);
  const selected = byCode(preferred) ?? byCode(fallback) ?? [...active].sort((a,b)=>a.code.localeCompare(b.code))[0];
  const certain = !!preferred && selected.code === preferred;
  return {value:selected,uncertainFields:certain?[]:['accountCode'],
    explanation:certain?'Historical supplier account selected':'Best available active expense account; finance to verify'};
}
