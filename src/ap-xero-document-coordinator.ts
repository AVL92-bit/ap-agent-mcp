import type { XeroPurchaseMatch } from './xero-duplicate-lookup.js';

/** A single-document Xero boundary. The caller supplies extracted candidates,
 * selected contact/coding, and the original PDF. This module never approves a bill.
 * Reconciliation must complete before any write, including after ambiguous failures.
 */
export type PurchaseKind = 'Invoices' | 'CreditNotes';
export type OriginalPdf = { filename: string; bytes: Uint8Array; contentType: 'application/pdf' };
export type DraftCommand = {
  kind: PurchaseKind;
  number: string;
  supplierContactId: string;
  supplierName?: string;
  extractedSupplierName?: string;
  supplierMatchScore?: number;
  accountCode: string;
  invoiceDate: string;
  dueDate: string;
  gross: number;
  pdf: OriginalPdf;
  uncertainFields: string[];
  /** Review notes for the Sheet (e.g. model and text rules disagree). Never blockers. */
  reviewNotes?: string[];
};
export type XeroDraftPort = {
  lookup(number: string): Promise<XeroPurchaseMatch[]>;
  createDraft(command: DraftCommand): Promise<string>;
  /** Persist a one-way write intent before POST. False means a prior attempt may have committed. */
  beforeCreate?(): Promise<boolean>;
  attachOriginal(kind: PurchaseKind, id: string, pdf: OriginalPdf): Promise<void>;
  /** Must verify the source PDF, not merely an arbitrary attachment. */
  verifyOriginal?(kind: PurchaseKind, id: string, pdf: OriginalPdf): Promise<boolean>;
};
export type DraftOutcome =
  | { status: 'already_in_xero'; kind: PurchaseKind; xeroId: string; xeroStatus?: string; uncertainFields: string[] }
  | { status: 'draft_created'; kind: PurchaseKind; xeroId: string; uncertainFields: string[] }
  | { status: 'attachment_failed'; kind: PurchaseKind; xeroId: string; uncertainFields: string[]; error: string }
  | { status: 'reconciliation_required'; kind: PurchaseKind; uncertainFields: string[]; error: string };

function validate(command: DraftCommand): void {
  if (!command.number.trim() || !command.supplierContactId || !command.accountCode ||
      !/^\d{4}-\d{2}-\d{2}$/.test(command.invoiceDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(command.dueDate) ||
      !Number.isFinite(command.gross) || command.gross <= 0 ||
      !command.pdf.filename.toLowerCase().endsWith('.pdf') ||
      command.pdf.contentType !== 'application/pdf' || command.pdf.bytes.length < 5 ||
      String.fromCharCode(...command.pdf.bytes.slice(0, 5)) !== '%PDF-') {
    throw new Error('Cannot construct a valid Xero draft from supplied fields and original PDF');
  }
}
function matchForKind(matches: XeroPurchaseMatch[], kind: PurchaseKind): XeroPurchaseMatch[] {
  return matches.filter(m => m.kind === kind && m.exact);
}
/** Never create when the Xero read fails or yields multiple exact-number matches.
 * If creation may have succeeded but the response failed, reconcile instead of retrying.
 */
export async function reconcileCreateAndAttach(command: DraftCommand, port: XeroDraftPort): Promise<DraftOutcome> {
  validate(command);
  const initial = matchForKind(await port.lookup(command.number), command.kind);
  if (initial.length > 1) return { status: 'reconciliation_required', kind: command.kind, uncertainFields: command.uncertainFields, error: 'Multiple matching Xero documents' };
  if (initial.length === 1) {
    const id = initial[0].id;
    // An invoice number match alone is NOT proof that the original PDF is accounted for.
    // Without an independent attachment verifier we must keep Front open.
    if (!port.verifyOriginal) return { status: 'reconciliation_required', kind: command.kind, uncertainFields: command.uncertainFields, error: `Existing Xero document ${id}: original PDF not verified` };
    try {
      if (!(await port.verifyOriginal(command.kind, id, command.pdf))) {
        await port.attachOriginal(command.kind, id, command.pdf);
        if (!(await port.verifyOriginal(command.kind, id, command.pdf))) throw new Error('Original PDF still not verified after upload');
      }
      return { status: 'already_in_xero', kind: command.kind, xeroId: id, xeroStatus: initial[0].status, uncertainFields: command.uncertainFields };
    } catch (error) {
      return { status: 'reconciliation_required', kind: command.kind, uncertainFields: command.uncertainFields, error: `Existing Xero document ${id}: ${String(error)}` };
    }
  }
  // This runs only after a successful, zero-match Xero reconciliation read.
  // The journal claim is durable: an ambiguous POST can never be repeated blindly.
  if (port.beforeCreate && !(await port.beforeCreate())) {
    return { status:'reconciliation_required',kind:command.kind,uncertainFields:command.uncertainFields,
      error:'Previous Xero creation attempt unresolved; no second POST permitted' };
  }
  let id: string;
  try {
    id = await port.createDraft(command);
    if (!id) throw new Error('Xero draft creation returned no ID');
  } catch (error) {
    // An HTTP timeout can occur after Xero commits. Never blindly POST again.
    try {
      const after = matchForKind(await port.lookup(command.number), command.kind);
      if (after.length === 1) {
        return { status: 'reconciliation_required', kind: command.kind, uncertainFields: command.uncertainFields, error: `Draft may exist as ${after[0].id}; verify original PDF attachment before completion` };
      }
    } catch { /* A failed reconciliation still must not permit a retrying write. */ }
    return { status: 'reconciliation_required', kind: command.kind, uncertainFields: command.uncertainFields, error: `Draft write outcome uncertain: ${String(error)}` };
  }
  try {
    await port.attachOriginal(command.kind, id, command.pdf);
    if (!port.verifyOriginal || !(await port.verifyOriginal(command.kind, id, command.pdf))) throw new Error('Original PDF not verified after draft creation');
  } catch (error) {
    return { status: 'attachment_failed', kind: command.kind, xeroId: id, uncertainFields: command.uncertainFields, error: String(error) };
  }
  return { status: 'draft_created', kind: command.kind, xeroId: id, uncertainFields: command.uncertainFields };
}
