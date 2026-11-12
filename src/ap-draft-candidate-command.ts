import { DocumentNeedsHumanReview } from './ap-document-verification.js';
import { chooseAccount, chooseSupplier, type ContactCandidate, type AccountCandidate } from './ap-best-candidate-selection.js';
import type { InvoiceCandidates } from './invoice-candidates.js';
import type { DraftCommand, OriginalPdf } from './ap-xero-document-coordinator.js';
function normaliseInvoiceDate(value?: string | null): string | null {
  if (!value) return null;
  const s = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : (() => {
    const m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/.exec(s);
    if (!m) return '';
    return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  })();
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === iso ? iso : null;
}

/** Deterministic conversion of document evidence and selected Xero candidates.
 * Uncertain fields are carried into reporting, never treated as approval gates.
 * Missing legally required Xero fields remain explicit processing failures.
 */
export function buildDraftCommand(input: {
  candidates: InvoiceCandidates;
  supplierContactId: string;
  supplierName?: string;
  extractedSupplierName?: string;
  supplierMatchScore?: number;
  accountCode: string;
  pdf: OriginalPdf;
  fallbackDate?: string;
  fallbackReference?: string;
  fallbackGross?: number;
  extraUncertainty?: string[];
}): DraftCommand {
  const { candidates: c } = input;
  const uncertain = new Set([...c.uncertainFields, ...(input.extraUncertainty ?? [])]);
  const number = c.reference?.value.trim() || input.fallbackReference?.trim() || '';
  if (!c.reference && number) uncertain.add('reference');
  const invoiceDate = normaliseInvoiceDate(c.invoiceDate?.value) || normaliseInvoiceDate(input.fallbackDate) || '';
  if (!c.invoiceDate || !normaliseInvoiceDate(c.invoiceDate.value)) uncertain.add('invoiceDate');
  const dueDate = normaliseInvoiceDate(c.dueDate?.value) || invoiceDate;
  if (!c.dueDate || !normaliseInvoiceDate(c.dueDate.value)) uncertain.add('dueDate');
  const parsed = c.grossAmount ? Number(c.grossAmount.value.replace(/[^\d.]/g, '')) : NaN;
  const gross = Number.isFinite(parsed) && parsed > 0 ? parsed : input.fallbackGross ?? NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) uncertain.add('grossAmount');
  if (c.currency.value !== 'GBP') throw new Error('Non-GBP invoice needs currency-specific Xero handling');
  return {
    kind: c.documentType.value === 'credit_note' ? 'CreditNotes' : 'Invoices',
    number, supplierContactId: input.supplierContactId, supplierName:input.supplierName, extractedSupplierName:input.extractedSupplierName, supplierMatchScore:input.supplierMatchScore, accountCode: input.accountCode,
    invoiceDate, dueDate, gross, pdf: input.pdf, uncertainFields: [...uncertain],
  };
}

/** Resolve available Xero candidates in application code, then construct the draft.
 * Only existing Xero contacts are eligible; supplier uncertainty is advisory.
 */
export async function buildDraftFromAvailableCandidates(input: {
  candidates: InvoiceCandidates;
  contacts: ContactCandidate[];
  accounts: AccountCandidate[];
  pdf: OriginalPdf;
  preferredAccountCode?: string;
  fallbackDate?: string;
  fallbackReference?: string;
  fallbackGross?: number;
  recentAccountCodeForContact?: (contactId:string)=>Promise<string|undefined>;
}): Promise<DraftCommand> {
  const name = input.candidates.supplier?.value?.trim() || input.pdf.filename.replace(/\.pdf$/i, '').slice(0, 100);
  const matched = chooseSupplier(name, input.contacts);
  // Supplier uncertainty is recorded, not a draft veto. No new contacts are created.
  if (!matched) throw new DocumentNeedsHumanReview('unclear','No existing Xero supplier contact exceeded 40% similarity; no Xero contact created');
  const supplier = matched;
  const historicalCode = input.recentAccountCodeForContact ? await input.recentAccountCodeForContact(supplier.value.id) : undefined;
  const account = chooseAccount(input.accounts, historicalCode, supplier.value.defaultPurchaseCode);
  // No generic fallback: without the supplier's own coding the invoice is not drafted.
  if (!account) throw new DocumentNeedsHumanReview('unclear',`No approved bill history and no default purchase account for ${supplier.value.name} in Xero; invoice not drafted`);
  // All drafts receive normal finance review; account-code selection alone does not
  // trigger an additional uncertainty exception. Historical codes must still be active and expense-eligible.
  return buildDraftCommand({candidates:input.candidates,supplierContactId:supplier.value.id,supplierName:supplier.value.name,extractedSupplierName:input.candidates.supplier?.value,supplierMatchScore:supplier.score,
    accountCode:account.value.code,pdf:input.pdf,fallbackDate:input.fallbackDate,
    fallbackReference:input.fallbackReference,fallbackGross:input.fallbackGross,
    extraUncertainty:[...supplier.uncertainFields,...account.uncertainFields]});
}
