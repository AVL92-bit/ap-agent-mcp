/** Review issues come from CURRENT evidence only: the original PDF as extracted now,
 * compared with the recorded draft fields. Stored assessment notes are history and
 * are never re-used as issues, so stale notes cannot block or reach the Sheet.
 * Supplier identity and coding issues are added by the supplier/coding resolution.
 * Due-date defaults and VAT treatment are policy, not issues. */
import { extractInvoiceCandidates, type InvoiceCandidates } from './invoice-candidates.js';
import { BALANCE_AMOUNT_NOTE } from './ap-invoice-review-rules.js';

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const money = (s: string) => Number(s.replace(/[^\d.-]/g, ''));

export function liveExtractionIssues(text: string, recorded: { invoice_number?: string | null; gross_gbp?: number | null },
  merged?: { candidates: InvoiceCandidates; notes: string[] }): string[] {
  // Same extraction as the full run when supplied (model cross-checked by text rules).
  const c = merged?.candidates ?? extractInvoiceCandidates(text);
  const issues: string[] = [...(merged?.notes ?? [])];
  if (c.documentType.value === 'receipt') issues.push('Document reads as a receipt, not an invoice; verify before approval');
  if (c.accountBalance) issues.push(BALANCE_AMOUNT_NOTE);

  const number = String(recorded.invoice_number ?? '').trim();
  if (!c.reference) issues.push(`Invoice number not found on PDF; recorded ${number || '(none)'} used - verify`);
  else if (number && key(c.reference.value) !== key(number))
    issues.push(`Invoice number on PDF (${c.reference.value}) differs from recorded (${number}); verify`);
  else if (c.reference.uncertain && /separator reconstructed/.test(c.reference.evidence))
    issues.push(`Invoice number ${c.reference.value} read with a damaged separator on the PDF; verify`);

  const gross = typeof recorded.gross_gbp === 'number' ? Math.abs(recorded.gross_gbp) : null;
  if (!c.grossAmount) issues.push('Gross total not confidently read from PDF; recorded amount used - verify');
  else if (gross !== null && Math.abs(Math.abs(money(c.grossAmount.value)) - gross) > 0.011)
    issues.push(`PDF total ${c.grossAmount.value} differs from recorded £${gross.toFixed(2)}; verify`);

  if (!c.invoiceDate) issues.push('Invoice date not found on PDF; recorded date used - verify');
  return issues;
}
