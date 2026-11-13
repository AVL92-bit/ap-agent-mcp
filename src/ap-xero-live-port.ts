import { createHash } from 'node:crypto';
import { xeroFetch } from './xero-rate-limit.js';
import { lookupXeroPurchaseNumber } from './xero-duplicate-lookup.js';
import { getPilotXeroWriteSession } from './xero-pilot-test.js';
import { attachAndVerifyOriginal } from './xero-draft-bills.js';
import { grossExpenseLine, vatPolicyForInbox } from './inbox-vat-policy.js';
import type { DraftCommand, XeroDraftPort } from './ap-xero-document-coordinator.js';

const INBOX = 'inb_bys7q';
const TENANT = '45a1074b-b172-4f49-a192-f0a8e293b54d';
const API = 'https://api.xero.com/api.xro/2.0/';
type Session = { tenantId: string; accessToken: string };

/** Live Xero adapter. Only creates DRAFT purchase documents and attaches source PDFs.
 * Contact selection and coding are upstream; this adapter cannot approve or pay.
 */
export const XERO_REJECTED = 'Xero rejected the draft; nothing was created';
export function makeLiveXeroDraftPort(
  getSession: () => Promise<Session> = getPilotXeroWriteSession,
): XeroDraftPort {
  async function session(): Promise<Session> {
    if (process.env.FRONT_ENABLED_INBOX_ID !== INBOX || process.env.XERO_PILOT_TENANT_ID !== TENANT ||
      process.env.XERO_DRAFT_WRITES_ENABLED?.toLowerCase() !== 'true') {
      throw new Error('Xero draft writes are not enabled for the configured surgery inbox and tenant');
    }
    const s = await getSession();
    if (s.tenantId !== TENANT) throw new Error('Unexpected Xero tenant');
    return s;
  }
  return {
    async lookup(number) {
      const s = await session();
      return lookupXeroPurchaseNumber(s, number, { includeRemoved: true });
    },
    async createDraft(command: DraftCommand) {
      const s = await session();
      const kind = command.kind;
      const base = {
        Status: 'DRAFT',
        Type: kind === 'Invoices' ? 'ACCPAY' : 'ACCPAYCREDIT',
        Contact: { ContactID: command.supplierContactId },
        Date: command.invoiceDate,
        CurrencyCode: 'GBP',
        LineAmountTypes: 'Exclusive',
        LineItems: [grossExpenseLine({
          inboxId: INBOX, description: [`${kind === 'Invoices' ? 'Supplier invoice' : 'Supplier credit note'} ${command.number}`, ...(command.infoNotes ?? [])].join(' - '),
          gross: command.gross, accountCode: command.accountCode,
        })],
      };
      const document = kind === 'Invoices'
        ? { ...base, InvoiceNumber: command.number, DueDate: command.dueDate }
        : { ...base, CreditNoteNumber: command.number };
      if (vatPolicyForInbox(INBOX).purchaseTaxType !== 'NONE') throw new Error('Unexpected VAT policy');
      const response = await xeroFetch(`${API}${kind}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.accessToken}`, 'xero-tenant-id': s.tenantId,
          'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ [kind]: [document] }),
        signal: AbortSignal.timeout(25000),
      });
      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        let messages: string[] = [];
        try {
          const b = JSON.parse(raw) as any;
          messages = [b?.Message, ...(b?.Elements ?? []).flatMap((e: any) => (e?.ValidationErrors ?? []).map((v: any) => v?.Message))]
            .filter((m: unknown): m is string => typeof m === 'string' && m.length > 0 && m !== 'A validation exception occurred');
        } catch { /* not JSON */ }
        const detail = messages.length ? `: ${[...new Set(messages)].join('; ').slice(0, 400)}` : '';
        // HTTP 400 is a validation rejection: Xero created nothing, so the attempt may be retried.
        if (response.status === 400) throw new Error(`${XERO_REJECTED} (HTTP 400)${detail}`);
        throw new Error(`Xero DRAFT ${kind} POST HTTP ${response.status}${detail}; reconcile before retry`);
      }
      const body = await response.json() as Record<string, any>;
      const created = body[kind]?.[0];
      const id = created?.[kind === 'Invoices' ? 'InvoiceID' : 'CreditNoteID'];
      if (!id || created.Status !== 'DRAFT' || created.HasErrors || created.ValidationErrors?.length) {
        throw new Error('Xero DRAFT response indeterminate; reconcile before retry');
      }
      return String(id);
    },
    async existingSummary(kind, id) {
      const s = await session();
      const headers = { Authorization: `Bearer ${s.accessToken}`, 'xero-tenant-id': s.tenantId, Accept: 'application/json' };
      const doc = await xeroFetch(`${API}${kind}/${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(25000) });
      if (!doc.ok) throw new Error(`Xero ${kind} read HTTP ${doc.status}`);
      const d = ((await doc.json()) as Record<string, any>)[kind]?.[0] ?? {};
      const att = await xeroFetch(`${API}${kind}/${encodeURIComponent(id)}/Attachments`, { headers, signal: AbortSignal.timeout(25000) });
      if (!att.ok) throw new Error(`Xero attachment listing HTTP ${att.status}`);
      const list = ((await att.json()) as { Attachments?: Array<{ FileName?: string; MimeType?: string }> }).Attachments ?? [];
      return { total: typeof d.Total === 'number' ? d.Total : null, date: typeof d.DateString === 'string' ? d.DateString.slice(0, 10) : null,
        hasPdf: list.some(a => /\.pdf$/i.test(a.FileName ?? '') || /pdf/i.test(a.MimeType ?? '')) };
    },
    async verifyOriginal(kind, id, pdf) {
      const s = await session();
      const base = `${API}${kind}/${encodeURIComponent(id)}/Attachments`;
      const headers = { Authorization: `Bearer ${s.accessToken}`, 'xero-tenant-id': s.tenantId, Accept: 'application/json' };
      const response = await xeroFetch(base, { headers, signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`Xero attachment listing HTTP ${response.status}`);
      const body = await response.json() as { Attachments?: Array<{ FileName?: string }> };
      if (!Array.isArray(body.Attachments)) throw new Error('Malformed Xero attachment listing');
      const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
      const expected = digest(pdf.bytes);
      for (const a of body.Attachments) {
        if (a.FileName !== pdf.filename) continue;
        const file = await xeroFetch(`${base}/${encodeURIComponent(a.FileName)}`, {
          headers: { ...headers, Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(25000),
        });
        if (!file.ok) throw new Error(`Xero attachment download HTTP ${file.status}`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (digest(bytes) === expected) return true;
      }
      return false;
    },
    async attachOriginal(kind, id, pdf) {
      const s = await session();
      await attachAndVerifyOriginal(s.tenantId, s.accessToken, id, pdf.filename,
        pdf.contentType, Buffer.from(pdf.bytes), kind);
    },
  };
}
