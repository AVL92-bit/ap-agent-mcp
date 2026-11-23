/** VAT-recovery posting for inboxes whose company reclaims input VAT (policy: recoverable / FROM_INVOICE).
 * Pure functions: no Xero or network access. The rate comes from the invoice. The supplier's previous
 * approved bill in Xero is only used to (a) choose between tax types of the same rate, (b) allow reverse
 * charge, and (c) decide whether the treatment is "uncertain due to no invoice history".
 */
export type VatLabel = 'standard' | 'reduced' | 'zero' | 'exempt' | 'reverse_charge' | 'outside_scope' | 'unknown';
export type VatRow = { label: VatLabel; rate: number | null; net: number; vat: number };
export type TaxRateInfo = { taxType: string; name: string; rate: number; active: boolean; canApplyToExpenses: boolean };
export type PostedLine = { net: number; vat: number; taxType: string; reverseCharge: boolean };
export type VatPlan = { lines: PostedLine[]; xeroTotal: number; notes: string[] };

export const NO_HISTORY_NOTE = 'VAT uncertain due to no invoice history';
export class VatReviewError extends Error {}

const cents = (n: number) => Math.round(n * 100);
const fix2 = (c: number) => c / 100;
const isReverse = (t: TaxRateInfo) => /reverse/i.test(t.name);
const EXCLUDED_FOR_RATE = /reverse|import|\bEC\b|capital|acquisition|postponed|sales|output/i;

/** Rows from the extraction. A printed breakdown wins; otherwise one row from the printed net and VAT totals. */
export function vatRowsFromExtraction(x: { breakdown?: VatRow[] | null; netTotal?: number | null; vatTotal?: number | null }): VatRow[] {
  const good = (x.breakdown ?? []).filter(r => Number.isFinite(r.net) && Number.isFinite(r.vat));
  if (good.length) return good;
  if (typeof x.netTotal === 'number' && typeof x.vatTotal === 'number')
    return [{ label: 'unknown', rate: null, net: x.netTotal, vat: x.vatTotal }];
  throw new VatReviewError('The invoice does not show a readable net and VAT split, so the VAT treatment cannot be posted');
}

/** Whole-number-ish rate from a row: the printed rate, else vat/net. */
function rowRate(r: VatRow): number {
  if (typeof r.rate === 'number' && Number.isFinite(r.rate)) return r.rate;
  if (cents(r.vat) === 0) return 0;
  if (!(r.net > 0)) return NaN;
  const computed = Math.round((r.vat / r.net) * 1000) / 10;
  // Printed pence rounding moves small invoices off the true rate: snap to the UK rate the label (or closeness) points to.
  const hint = r.label === 'standard' ? 20 : r.label === 'reduced' ? 5 : null;
  if (hint !== null && Math.abs(computed - hint) < 1.5) return hint;
  for (const known of [20, 5]) if (Math.abs(computed - known) < 0.3) return known;
  return computed;
}

/** Tax types used on the supplier's most recent approved or paid purchase bill in Xero (empty if none). */
export function latestHistoryTaxTypes(bills: Array<{ Type?: string; Status?: string; DateString?: string; Date?: string; InvoiceID?: string;
  Contact?: { ContactID?: string }; LineItems?: Array<{ TaxType?: string }> }>, contactId: string): string[] {
  const eligible = bills.filter(b => b.Type === 'ACCPAY' && b.Contact?.ContactID === contactId &&
    ['AUTHORISED', 'PAID'].includes(String(b.Status ?? '').toUpperCase()) && (b.DateString || b.Date) && b.LineItems?.some(l => l.TaxType));
  eligible.sort((a, b) => String(b.DateString ?? b.Date).localeCompare(String(a.DateString ?? a.Date)) || String(b.InvoiceID ?? '').localeCompare(String(a.InvoiceID ?? '')));
  const latest = eligible[0];
  return latest ? [...new Set((latest.LineItems ?? []).map(l => l.TaxType).filter((t): t is string => !!t))] : [];
}

export function taxRatesFromXero(raw: Array<{ Name?: string; TaxType?: string; Status?: string; CanApplyToExpenses?: boolean; EffectiveRate?: number; DisplayTaxRate?: number }>): TaxRateInfo[] {
  return raw.filter(t => t.TaxType).map(t => ({ taxType: t.TaxType!, name: t.Name ?? t.TaxType!, rate: Number(t.EffectiveRate ?? t.DisplayTaxRate ?? 0),
    active: String(t.Status ?? '').toUpperCase() === 'ACTIVE', canApplyToExpenses: t.CanApplyToExpenses !== false }));
}

function pickUnique(c: TaxRateInfo[], what: string): TaxRateInfo {
  if (c.length > 1) { // several candidates: prefer the one named as an expense rate, if that is unique
    const exp = c.filter(t => /expense/i.test(t.name));
    if (exp.length === 1) return exp[0]!;
  }
  if (c.length === 1) return c[0]!;
  throw new VatReviewError(`${what}: ${c.length === 0 ? 'no matching' : `more than one matching (${c.map(t => `${t.name} [${t.taxType}]`).join('; ')})`} active tax rate in Xero, so the agent will not choose`);
}

/** Choose the Xero tax type for one invoice row. */
function taxTypeFor(r: VatRow, rates: TaxRateInfo[], history: TaxRateInfo[]): { rate: TaxRateInfo; reverse: boolean } {
  const usable = rates.filter(t => t.active && t.canApplyToExpenses);
  const noVat = cents(r.vat) === 0;
  const histReverse = history.filter(isReverse);
  // Reverse charge: only where this supplier's previous bills were treated that way, and no VAT is charged.
  if (noVat && histReverse.length && ['reverse_charge', 'unknown', 'zero', 'outside_scope'].includes(r.label)) {
    const rc = usable.find(t => t.taxType === histReverse[0]!.taxType);
    if (!rc) throw new VatReviewError('This supplier was previously reverse charged but that tax rate is no longer active in Xero');
    return { rate: rc, reverse: true };
  }
  if (r.label === 'reverse_charge')
    throw new VatReviewError('The invoice is marked reverse charge but this supplier has no previous reverse charge invoice in Xero');
  const pct = rowRate(r);
  if (!Number.isFinite(pct)) throw new VatReviewError('The VAT rate on the invoice cannot be worked out');
  const sameRate = (t: TaxRateInfo) => Math.abs(t.rate - pct) < 0.05;
  if (pct > 0) {
    const fromHistory = history.filter(t => !isReverse(t) && sameRate(t));
    if (fromHistory.length) return { rate: fromHistory[0]!, reverse: false };
    let c = usable.filter(t => sameRate(t) && !EXCLUDED_FOR_RATE.test(t.name));
    if (c.length > 1) c = c.filter(t => /on expenses/i.test(t.name));
    return { rate: pickUnique(c, `${pct}% VAT`), reverse: false };
  }
  // 0%: the invoice's own label decides; if it does not say, the supplier's history does.
  const zeroHist = history.filter(t => !isReverse(t) && t.rate === 0);
  const named = (re: RegExp) => usable.filter(t => t.rate === 0 && re.test(t.name) && !EXCLUDED_FOR_RATE.test(t.name));
  if (r.label === 'exempt') return { rate: pickUnique(named(/exempt/i), 'Exempt'), reverse: false };
  if (r.label === 'zero') return { rate: pickUnique(named(/zero/i), 'Zero rated'), reverse: false };
  if (r.label === 'outside_scope') return { rate: pickUnique(usable.filter(t => t.rate === 0 && (t.taxType === 'NONE' || /no vat|out of scope|outside/i.test(t.name))), 'Outside the scope of VAT'), reverse: false };
  if (zeroHist.length) return { rate: zeroHist[0]!, reverse: false };
  throw new VatReviewError('No VAT is charged but the invoice does not say whether it is zero rated, exempt or outside the scope, and this supplier has no history to follow');
}

/** Plan the draft's VAT lines. Throws VatReviewError when the agent should not post it. */
export function planVatPosting(input: { gross: number; rows: VatRow[]; taxRates: TaxRateInfo[]; historyTaxTypes: string[] }): VatPlan {
  const { rows, taxRates } = input;
  const sumNet = rows.reduce((s, r) => s + cents(r.net), 0), sumVat = rows.reduce((s, r) => s + cents(r.vat), 0);
  if (Math.abs(sumNet + sumVat - cents(input.gross)) > 1)
    throw new VatReviewError(`Net £${fix2(sumNet).toFixed(2)} plus VAT £${fix2(sumVat).toFixed(2)} does not equal the invoice total £${input.gross.toFixed(2)}`);
  if (rows.some(r => cents(r.net) <= 0 || cents(r.vat) < 0)) throw new VatReviewError('The invoice has a negative or zero net amount on a VAT line');
  const history = input.historyTaxTypes.map(t => taxRates.find(x => x.taxType === t) ?? { taxType: t, name: t, rate: NaN, active: false, canApplyToExpenses: true });
  const lines: PostedLine[] = rows.map(r => { const c = taxTypeFor(r, taxRates, history); return { net: r.net, vat: r.vat, taxType: c.rate.taxType, reverseCharge: c.reverse }; });
  const notes: string[] = [];
  const used = [...new Set(lines.map(l => l.taxType))];
  if (!input.historyTaxTypes.length) notes.push(NO_HISTORY_NOTE);
  else if (!used.every(t => input.historyTaxTypes.includes(t)))
    notes.push(`VAT treatment differs from this supplier's previous invoice (previous: ${input.historyTaxTypes.join(', ')}; this invoice: ${used.join(', ')})`);
  // A rounded-pence difference to the printed total is carried in the VAT amount so Xero's total equals the invoice.
  const drift = cents(input.gross) - (sumNet + sumVat);
  if (drift !== 0) { const l = lines.find(x => !x.reverseCharge && x.vat > 0); if (l) l.vat = fix2(cents(l.vat) + drift); }
  return { lines, xeroTotal: input.gross, notes };
}

/** Xero line items for a plan (LineAmountTypes Exclusive: net amounts, with the invoice's VAT written on each line). */
export function vatLineItems(plan: VatPlan, input: { description: string; accountCode: string }) {
  return plan.lines.map(l => ({ Description: input.description, Quantity: 1, UnitAmount: l.net, AccountCode: input.accountCode, TaxType: l.taxType,
    ...(l.reverseCharge ? {} : { TaxAmount: l.vat }) }));
}
