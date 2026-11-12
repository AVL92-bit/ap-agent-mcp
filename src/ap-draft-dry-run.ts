import { extractInvoiceCandidates } from './invoice-candidates.js';
import { buildDraftFromAvailableCandidates } from './ap-draft-candidate-command.js';
import type { ContactCandidate, AccountCandidate } from './ap-best-candidate-selection.js';

/**
 * Pure, caller-supplied snapshot preview. Never obtains credentials, reads
 * databases, contacts Front/Xero, or invokes a write-capable port.
 * This is NOT proof of current Xero state or duplicate-free draft readiness.
 */
export async function previewApDraftSelection(input: {
  invoiceText: string;
  filename: string;
  attachmentId: string;
  contacts: ContactCandidate[];
  accounts: AccountCandidate[];
  historicalAccountCode?: string;
  fallbackAccountCode?: string;
}) {
  const candidates = extractInvoiceCandidates(input.invoiceText);
  const command = await buildDraftFromAvailableCandidates({
    candidates,
    contacts: input.contacts,
    accounts: input.accounts,
    pdf: { filename: input.filename, bytes: new Uint8Array(), contentType: 'application/pdf' },
    recentAccountCodeForContact: async () => input.historicalAccountCode,
    fallbackAccountCode: input.fallbackAccountCode,
  });
  return {
    status: 'simulated_draft_selection',
    read_only: true,
    creates_draft: false,
    data_source: 'caller_supplied_snapshot',
    xero_contacts_live_verified: false,
    xero_history_live_verified: false,
    duplicate_check_completed: false,
    front_or_sheet_routing_verified: false,
    attachment_id: input.attachmentId,
    supplier_extracted: candidates.supplier,
    supplier_selected: { name: command.supplierName, contact_id: command.supplierContactId,
      similarity_score: command.supplierMatchScore,
      strictly_above_50_percent: (command.supplierMatchScore ?? 0) > 0.5 },
    invoice_reference: command.number,
    invoice_date: command.invoiceDate,
    due_date: command.dueDate,
    gross_gbp: command.gross,
    account_code: command.accountCode,
    uncertainty_fields: command.uncertainFields,
    review_issues: command.uncertainFields.map(field => field === 'grossAmount'
      ? 'Amount uncertain: verify current-period charges and carried-forward credit'
      : field === 'supplier' ? 'Supplier identity uncertain: verify selected existing Xero contact'
      : field === 'dueDate' ? 'Due date missing: human review required'
      : field + ' requires human review'),
    requires_human_review: true,
    note: 'This pure preview does not validate the current Xero contact list, historical coding, duplicates, account status, Front tagging or Sheets delivery.',
  };
}
