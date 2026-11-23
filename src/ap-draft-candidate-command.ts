import { DocumentNeedsHumanReview } from './ap-document-verification.js';
import { chooseAccount, chooseSuspenseAccount, chooseSupplier, type ContactCandidate, type AccountCandidate } from './ap-best-candidate-selection.js';
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
  reviewNotes?: string[];
}): DraftCommand {
  const { candidates: c } = input;
  const uncertain = new Set([...c.uncertainFields, ...(input.extraUncertainty ?? [])]);
  const number = c.reference?.value.trim() || input.fallbackReference?.trim() || '';
  if (!c.reference && number) uncertain.add('reference');
  const invoiceDate = normaliseInvoiceDate(c.invoiceDate?.value) || normaliseInvoiceDate(input.fallbackDate) || '';
  if (!c.invoiceDate || !normaliseInvoiceDate(c.invoiceDate.value)) uncertain.add('invoiceDate');
  // Policy: no printed due date -> invoice date + 30 days, written on the draft as a note.
  // A defaulted due date is informational, never a reason for Human Review.
  const printedDue = normaliseInvoiceDate(c.dueDate?.value);
  const infoNotes: string[] = [];
  let dueDate = printedDue || '';
  if (!printedDue && invoiceDate) {
    const d = new Date(`${invoiceDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 30);
    dueDate = d.toISOString().slice(0, 10);
    infoNotes.push('Due date not printed; set to invoice date + 30 days');
  }
  uncertain.delete('dueDate');
  const parsed = c.grossAmount ? Number(c.grossAmount.value.replace(/[^\d.]/g, '')) : NaN;
  const gross = Number.isFinite(parsed) && parsed > 0 ? parsed : input.fallbackGross ?? NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) uncertain.add('grossAmount');
  if (c.currency.value !== 'GBP') throw new Error('Non-GBP invoice needs currency-specific Xero handling');
  return {
    kind: c.documentType.value === 'credit_note' ? 'CreditNotes' : 'Invoices',
    number, supplierContactId: input.supplierContactId, supplierName:input.supplierName, extractedSupplierName:input.extractedSupplierName, supplierMatchScore:input.supplierMatchScore, accountCode: input.accountCode,
    invoiceDate, dueDate, gross, pdf: input.pdf, uncertainFields: [...uncertain],
    ...(input.reviewNotes?.length ? { reviewNotes: input.reviewNotes } : {}),
    ...(infoNotes.length ? { infoNotes } : {}),
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
  reviewNotes?: string[];
}): Promise<DraftCommand> {
  const name = input.candidates.supplier?.value?.trim() || input.pdf.filename.replace(/\.pdf$/i, '').slice(0, 100);
  const matched = chooseSupplier(name, input.contacts);
  // Supplier uncertainty is recorded, not a draft veto. No new contacts are created.
  if (!matched) {
    const ref = input.candidates.reference?.value, gross = input.candidates.grossAmount?.value;
    throw new DocumentNeedsHumanReview('supplier_missing',
      `Supplier "${name}" is not in Xero (no contact over 50% similar). Please create it as a supplier contact. Once the supplier exists in Xero, the invoice${ref ? ` ${ref}` : ''}${gross !== undefined ? ` for ${gross}` : ''} will be drafted automatically on the next run: no further action is needed after creating the contact. The agent creates no contacts.`);
  }
  const supplier = matched;
  const historicalCode = input.recentAccountCodeForContact ? await input.recentAccountCodeForContact(supplier.value.id) : undefined;
  let account = chooseAccount(input.accounts, historicalCode, supplier.value.defaultPurchaseCode);
  let suspenseNote: string | undefined;
  if (!account) {
    // No coding history and no default account: post to the suspense account and flag it (owner decision,
    // whole group). Without a single active suspense account the invoice goes to Human review.
    const suspense = chooseSuspenseAccount(input.accounts);
    if (!suspense) throw new DocumentNeedsHumanReview('unclear',`No approved bill history and no default purchase account for ${supplier.value.name} in Xero, and no single active suspense account to post to; invoice not drafted`);
    account = {value:suspense,uncertainFields:['accountCode'],explanation:'Suspense account used'};
    suspenseNote = `No coding history or default account for ${supplier.value.name}: posted to suspense account ${suspense.code} (${suspense.name}); finance to recode`;
  }
  // All drafts receive normal finance review; account-code selection alone does not
  // trigger an additional uncertainty exception. Historical codes must still be active and expense-eligible.
  return buildDraftCommand({candidates:input.candidates,supplierContactId:supplier.value.id,supplierName:supplier.value.name,extractedSupplierName:input.candidates.supplier?.value,supplierMatchScore:supplier.score,
    accountCode:account.value.code,pdf:input.pdf,fallbackDate:input.fallbackDate,
    fallbackReference:input.fallbackReference,fallbackGross:input.fallbackGross,
    extraUncertainty:[...supplier.uncertainFields,...account.uncertainFields],
    reviewNotes:suspenseNote?[...(input.reviewNotes??[]),suspenseNote]:input.reviewNotes});
}
