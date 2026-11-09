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
    number, supplierContactId: input.supplierContactId, supplierName:input.supplierName, accountCode: input.accountCode,
    invoiceDate, dueDate, gross, pdf: input.pdf, uncertainFields: [...uncertain],
  };
}

/** Resolve available Xero candidates in application code, then construct the draft.
 * A missing supplier match requests a provisional contact from the caller, not a HOLD.
 */
export async function buildDraftFromAvailableCandidates(input: {
  candidates: InvoiceCandidates;
  contacts: ContactCandidate[];
  accounts: AccountCandidate[];
  createProvisionalContact: (name: string) => Promise<ContactCandidate>;
  pdf: OriginalPdf;
  preferredAccountCode?: string;
  fallbackAccountCode?: string;
  fallbackDate?: string;
  fallbackReference?: string;
  fallbackGross?: number;
}): Promise<DraftCommand> {
  const name = input.candidates.supplier?.value?.trim() || input.pdf.filename.replace(/\.pdf$/i, '').slice(0, 100);
  const matched = chooseSupplier(name, input.contacts);
  const supplier = matched ?? {value: await input.createProvisionalContact(name),
    uncertainFields:['supplier'], explanation:'Provisional Xero contact created'};
  const account = chooseAccount(input.accounts, input.preferredAccountCode, input.fallbackAccountCode);
  return buildDraftCommand({candidates:input.candidates,supplierContactId:supplier.value.id,supplierName:supplier.value.name,
    accountCode:account.value.code,pdf:input.pdf,fallbackDate:input.fallbackDate,
    fallbackReference:input.fallbackReference,fallbackGross:input.fallbackGross,
    extraUncertainty:[...supplier.uncertainFields,...account.uncertainFields]});
}
