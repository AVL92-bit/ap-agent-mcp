/** Follow each supplier's existing invoice-number format in Xero. If the document's number
 * carries a letter prefix that the supplier's previous Xero bills never have (e.g. "RI 65930654"
 * where earlier bills are "65930802", "65930654"-style), the prefix is dropped so the number
 * matches how finance already records that supplier. Nothing else is changed. */
const shape = (s: string) => s.trim().replace(/[0-9]/g, '9').replace(/[A-Za-z]/g, 'A').replace(/\s+/g, ' ');

export function alignToSupplierNumberFormat(number: string, historical: string[]): string | null {
  const history = historical.map(h => h.trim()).filter(Boolean);
  if (!number.trim() || history.length < 2) return null; // need a consistent history to follow
  const shapes = new Set(history.map(shape));
  if (shapes.has(shape(number))) return null; // already in the supplier's format
  const m = /^([A-Za-z]{1,6})[\s:#./-]*(\d[\d/-]*)$/.exec(number.trim());
  if (!m) return null;
  const stripped = m[2];
  // Only drop the prefix when every historical number has the stripped shape and none uses the prefix.
  if (history.every(h => shape(h) === shape(stripped)) && !history.some(h => h.toUpperCase().startsWith(m[1].toUpperCase()))) return stripped;
  return null;
}

/** The number already has the shape most of the supplier's Xero bills use (at least two). */
export function matchesSupplierNumberFormat(number: string, historical: string[]): boolean {
  const target = shape(number);
  return historical.filter(h => h.trim() && shape(h) === target).length >= 2;
}
