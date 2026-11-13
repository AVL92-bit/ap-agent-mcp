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
  /** Informational notes written on the Xero draft line; never a reason for Human Review. */
  infoNotes?: string[];
};
export type XeroDraftPort = {
  lookup(number: string): Promise<XeroPurchaseMatch[]>;
  createDraft(command: DraftCommand): Promise<string>;
  /** Persist a one-way write intent before POST. False means a prior attempt may have committed. */
  beforeCreate?(): Promise<boolean>;
  /** Undo the write intent after Xero definitively rejected the POST (HTTP 400: nothing created). */
  releaseCreate?(): Promise<void>;
  attachOriginal(kind: PurchaseKind, id: string, pdf: OriginalPdf): Promise<void>;
  /** Must verify the source PDF, not merely an arbitrary attachment. */
  verifyOriginal?(kind: PurchaseKind, id: string, pdf: OriginalPdf): Promise<boolean>;
  /** Read-only summary of an existing Xero document: total, date and whether any PDF is attached. */
  existingSummary?(kind: PurchaseKind, id: string): Promise<{ total: number | null; date: string | null; hasPdf: boolean }>;
  /** The agent itself POSTed a draft for this source attachment on an earlier, interrupted run. */
  ownPendingDraft?: boolean;
};
export type DraftOutcome =
  | { status: 'already_in_xero'; kind: PurchaseKind; xeroId: string; xeroStatus?: string; uncertainFields: string[] }
  | { status: 'draft_created'; kind: PurchaseKind; xeroId: string; uncertainFields: string[] }
  | { status: 'attachment_failed'; kind: PurchaseKind; xeroId: string; uncertainFields: string[]; error: string }
  | { status: 'reconciliation_required'; kind: PurchaseKind; uncertainFields: string[]; error: string }
  | { status: 'possible_amendment'; kind: PurchaseKind; xeroId: string; uncertainFields: string[]; error: string };

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
const isRemoved = (m: XeroPurchaseMatch) => ['VOIDED', 'DELETED'].includes(String(m.status ?? '').toUpperCase());
function matchForKind(matches: XeroPurchaseMatch[], kind: PurchaseKind): XeroPurchaseMatch[] {
  return matches.filter(m => m.kind === kind && m.exact && !isRemoved(m));
}
/** Never create when the Xero read fails or yields multiple exact-number matches.
 * If creation may have succeeded but the response failed, reconcile instead of retrying.
 */
export async function reconcileCreateAndAttach(command: DraftCommand, port: XeroDraftPort): Promise<DraftOutcome> {
  validate(command);
  const found = await port.lookup(command.number);
  const initial = matchForKind(found, command.kind);
  // Finance voided or deleted this supplier's bill with the same number: never re-post it.
  // Any contact: finance may have moved a closed account to its own (archived) contact.
  const removed = initial.length ? [] : found.filter(m => m.kind === command.kind && m.exact && isRemoved(m));
  if (removed.length) {
    const r = removed[0];
    return { status: 'possible_amendment', kind: command.kind, xeroId: r.id, uncertainFields: command.uncertainFields,
      error: `Xero has a ${String(r.status).toLowerCase()} bill ${command.number}${r.contactName ? ` under contact "${r.contactName}"` : command.supplierName ? ` for ${command.supplierName}` : ''}; not re-posted - check whether it should be re-entered` };
  }
  if (initial.length > 1) return { status: 'reconciliation_required', kind: command.kind, uncertainFields: command.uncertainFields, error: 'Multiple matching Xero documents' };
  if (initial.length === 1) {
    const id = initial[0].id;
    // Documents already in Xero are never changed by the agent. Same total = the same invoice
    // (accounted for, whatever its PDF is called); different total = a possible amended version.
    if (port.existingSummary) {
      try {
        const existing = await port.existingSummary(command.kind, id);
        if (existing.total !== null && Math.abs(Math.abs(existing.total) - command.gross) > 0.011) {
          return { status: 'possible_amendment', kind: command.kind, xeroId: id, uncertainFields: command.uncertainFields,
            error: `Possible amended version of invoice ${command.number}: Xero £${Math.abs(existing.total).toFixed(2)}${existing.date ? ` dated ${existing.date}` : ''}, this document £${command.gross.toFixed(2)} dated ${command.invoiceDate}; compare and update manually` };
        }
        // The agent's own interrupted draft (same number and total, still DRAFT, no PDF): finish it
        // by attaching this original PDF. Documents created by anyone else are never changed.
        if (!existing.hasPdf && port.ownPendingDraft && String(initial[0].status ?? '').toUpperCase() === 'DRAFT') {
          try {
            await port.attachOriginal(command.kind, id, command.pdf);
            if (!port.verifyOriginal || !(await port.verifyOriginal(command.kind, id, command.pdf))) throw new Error('Original PDF not verified after upload');
            return { status: 'draft_created', kind: command.kind, xeroId: id, uncertainFields: command.uncertainFields };
          } catch (error) {
            return { status: 'attachment_failed', kind: command.kind, xeroId: id, uncertainFields: command.uncertainFields, error: String(error) };
          }
        }
        if (!existing.hasPdf) return { status: 'reconciliation_required', kind: command.kind, uncertainFields: command.uncertainFields,
          error: `Existing Xero document ${id} has no PDF attached; finance to attach it (the agent does not change documents already in Xero)` };
        return { status: 'already_in_xero', kind: command.kind, xeroId: id, xeroStatus: initial[0].status, uncertainFields: command.uncertainFields };
      } catch (error) {
        return { status: 'reconciliation_required', kind: command.kind, uncertainFields: command.uncertainFields, error: `Existing Xero document ${id}: ${String(error)}` };
      }
    }
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
    if (String(error).includes('Xero rejected the draft; nothing was created')) {
      await port.releaseCreate?.().catch(() => {});
      return { status: 'reconciliation_required', kind: command.kind, uncertainFields: command.uncertainFields, error: String(error).replace(/^Error: /, '') };
    }
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
