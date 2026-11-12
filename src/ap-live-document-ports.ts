import { PDFParse } from 'pdf-parse';
import { verifyInvoiceDocumentText, DocumentNeedsHumanReview, requireVerifiedCriticalFields } from './ap-document-verification.js';
import type { PoolClient } from 'pg';
import { xeroFetch } from './xero-rate-limit.js';
import { getPilotXeroWriteSession } from './xero-pilot-test.js';
import { extractInvoiceCandidates } from './invoice-candidates.js';
import { buildDraftFromAvailableCandidates } from './ap-draft-candidate-command.js';
import type { InboxAttachment, InboxConversation } from './ap-inbox-runner.js';
import type { DraftCommand, OriginalPdf } from './ap-xero-document-coordinator.js';
import type { ContactCandidate, AccountCandidate } from './ap-best-candidate-selection.js';

const TENANT = '45a1074b-b172-4f49-a192-f0a8e293b54d';
const INBOX = 'inb_bys7q';
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PAGES = 100;
const API = 'https://api.xero.com/api.xro/2.0';

/** All document selection is derived from scanned Front message/attachment IDs. */
export async function downloadFrontOriginalPdf(attachment: InboxAttachment, token: string): Promise<OriginalPdf> {
  if (!/^fil_[\w-]+$/.test(attachment.id) || !/^[\w-]+$/.test(attachment.messageId)) throw new Error('Invalid Front source attachment identity');
  if (!/\.pdf$/i.test(attachment.filename)) throw new Error('Source attachment is not a PDF');
  const response = await xeroFetch(`https://api2.frontapp.com/messages/${encodeURIComponent(attachment.messageId)}/download/${encodeURIComponent(attachment.id)}`, {
    headers: {Authorization:`Bearer ${token}`,Accept:'application/pdf'}, signal:AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`Front PDF download HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || '0');
  if (declared > MAX_BYTES) throw new Error('Front PDF exceeds size limit');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES || bytes.length < 5 || String.fromCharCode(...bytes.slice(0,5)) !== '%PDF-') throw new Error('Front attachment is not a valid bounded PDF');
  return {filename:attachment.filename,bytes,contentType:'application/pdf'};
}

export async function extractPdfCandidates(pdf: OriginalPdf) {
  const parser = new PDFParse({data:pdf.bytes});
  try {
    const info = await parser.getInfo();
    if (!Number.isInteger(info.total) || info.total < 1 || info.total > MAX_PAGES) throw new Error('PDF page count outside extraction bounds');
    const result = await parser.getText();
    const text = result.text?.trim() || '';
    if (text.length < 10 || text.length > 250000) throw new Error('No usable embedded PDF text; image-only PDF extraction unavailable');
    verifyInvoiceDocumentText(text);
    return extractInvoiceCandidates(text);
  } finally { await parser.destroy(); }
}

/** Live read-only Xero candidate listing. Never creates supplier contacts. */
export async function makeLiveDraftCommand(conversation: InboxConversation, attachment: InboxAttachment, client: PoolClient): Promise<DraftCommand> {
  if (process.env.FRONT_ENABLED_INBOX_ID !== INBOX || process.env.XERO_PILOT_TENANT_ID !== TENANT || process.env.XERO_DRAFT_WRITES_ENABLED?.toLowerCase() !== 'true') {
    throw new Error('AP draft-only live processing is disabled for this inbox/tenant');
  }
  const frontToken = process.env.FRONT_API_TOKEN;
  if (!frontToken) throw new Error('Front token missing');
  const pdf = await downloadFrontOriginalPdf(attachment, frontToken);
  let candidates;
  try {
    candidates = await extractPdfCandidates(pdf);
  } catch (error) {
    if (error instanceof DocumentNeedsHumanReview) throw error;
    if (!/No usable embedded PDF text/.test(String(error))) throw error;
    // OCR or correspondence text is not sufficient to authorise automatic drafting.
    throw new DocumentNeedsHumanReview('unclear','PDF text is unreadable; human review required before any Xero or PostgreSQL writes');
  }
  requireVerifiedCriticalFields(candidates);
  const session = await getPilotXeroWriteSession();
  if (session.tenantId !== TENANT) throw new Error('Unexpected Xero tenant');
  const headers = {Authorization:`Bearer ${session.accessToken}`,'xero-tenant-id':session.tenantId,Accept:'application/json'};
  async function readPaged<T>(resource:string,key:string):Promise<T[]> {
    const all:T[]=[];
    for (let page=1;page<=100;page++) {
      const r=await xeroFetch(`${API}/${resource}?page=${page}`,{headers,signal:AbortSignal.timeout(25000)});
      if(!r.ok) throw new Error(`Xero ${resource} read HTTP ${r.status}`);
      const body=await r.json() as Record<string,unknown>;
      if(!Array.isArray(body[key])) throw new Error(`Malformed Xero ${resource} response`);
      const chunk=body[key] as T[];
      all.push(...chunk);
      if(chunk.length<100) return all;
    }
    throw new Error(`Xero ${resource} pagination incomplete`);
  }
  const rawContacts=await readPaged<{ContactID?:string;Name?:string}>('Contacts','Contacts');
  const rawAccounts=await readPaged<{Code?:string;Name?:string;Type?:string;Status?:string}>('Accounts','Accounts');
  const contacts:ContactCandidate[]=rawContacts.filter(c=>c.ContactID&&c.Name).map(c=>({id:c.ContactID!,name:c.Name!}));
  const accounts:AccountCandidate[]=rawAccounts.map(a=>({code:a.Code||'',name:a.Name||'',type:a.Type||'',status:a.Status||''}));
  // Read-only history: use the newest purchase bill for this exact existing Xero contact.
  // Ignore credit notes, voided/deleted bills and accounts not active/expense eligible.
  async function recentAccountCodeForContact(contactId:string):Promise<string|undefined> {
    type HistoricalBill = {Type?:string;Status?:string;DateString?:string;Date?:string;InvoiceID?:string;
      Contact?:{ContactID?:string};LineItems?:Array<{AccountCode?:string}>};
    const bills=await readPaged<HistoricalBill>('Invoices','Invoices');
    const eligible=bills.filter(b=>b.Type==='ACCPAY' && b.Contact?.ContactID===contactId &&
      !['VOIDED','DELETED'].includes((b.Status??'').toUpperCase()) &&
      (b.DateString || b.Date) && b.LineItems?.some(line=>line.AccountCode));
    eligible.sort((a,b)=>String(b.DateString??b.Date).localeCompare(String(a.DateString??a.Date)) ||
      String(b.InvoiceID??'').localeCompare(String(a.InvoiceID??'')));
    return eligible[0]?.LineItems?.find(line=>line.AccountCode)?.AccountCode;
  }
  return buildDraftFromAvailableCandidates({candidates,contacts,accounts,pdf,
    fallbackDate:new Date().toISOString().slice(0,10),
    fallbackReference:`FRONT-${attachment.id}`,
    recentAccountCodeForContact,
    fallbackAccountCode:process.env.AP_FALLBACK_ACCOUNT_CODE,
  });
}
