import { PDFParse } from 'pdf-parse';
import { verifyInvoiceDocumentText, DocumentNeedsHumanReview } from './ap-document-verification.js';
import type { PoolClient } from 'pg';
import { xeroFetch } from './xero-rate-limit.js';
import { getPilotXeroWriteSession } from './xero-pilot-test.js';
import { extractInvoiceCandidates } from './invoice-candidates.js';
import { buildDraftFromAvailableCandidates } from './ap-draft-candidate-command.js';
import { extractInvoiceFields } from './model-extraction.js';
import { extractPdfsFromEml } from './eml-attachments.js';
import { alignToSupplierNumberFormat, matchesSupplierNumberFormat } from './supplier-number-format.js';
import { confirmContactByHistoricalPdf, accountNumberOnPreviousBills } from './xero-review-drafts.js';
import type { InboxAttachment, InboxConversation } from './ap-inbox-runner.js';
import type { DraftCommand, OriginalPdf } from './ap-xero-document-coordinator.js';
import type { ContactCandidate, AccountCandidate } from './ap-best-candidate-selection.js';

const TENANT = '45a1074b-b172-4f49-a192-f0a8e293b54d';
const INBOX = 'inb_bys7q';
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PAGES = 100;
const API = 'https://api.xero.com/api.xro/2.0';

/** PDFs found inside attached emails during this run, keyed by virtual attachment id. */
const embeddedPdfs = new Map<string, OriginalPdf>();

/** Open an attached email (.eml) from Front and return the PDFs inside it as attachments
 * (id "<fil_id>~<n>"). Returns [] when the email contains no PDF. */
export async function expandFrontEmail(_conversation: InboxConversation, attachment: InboxAttachment): Promise<InboxAttachment[]> {
  if (!/^fil_[\w-]+$/.test(attachment.id) || !/^[\w-]+$/.test(attachment.messageId)) throw new Error('Invalid Front source attachment identity');
  const token = process.env.FRONT_API_TOKEN;
  if (!token) throw new Error('Front token missing');
  const response = await xeroFetch(`https://api2.frontapp.com/messages/${encodeURIComponent(attachment.messageId)}/download/${encodeURIComponent(attachment.id)}`, {
    headers: {Authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`Front attached-email download HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error('Attached email exceeds size limit');
  const pdfs = extractPdfsFromEml(Buffer.from(bytes).toString('latin1'));
  return pdfs.map((p, i) => {
    const id = `${attachment.id}~${i + 1}`;
    embeddedPdfs.set(id, {filename: /\.pdf$/i.test(p.filename) ? p.filename : `${p.filename}.pdf`, bytes: p.bytes, contentType: 'application/pdf'});
    return {id, filename: embeddedPdfs.get(id)!.filename, messageId: attachment.messageId};
  });
}

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

/** Extraction for the full run: text rules always, model extraction (reads the PDF as
 * text + page images) when available, cross-checked. Only agreed blockers throw:
 * receipt (supporting document), not an invoice/credit note, no gross amount. */
export async function extractPdfCandidates(pdf: OriginalPdf) {
  // pdf.js transfers (detaches) the buffer it is given: parse a copy so the original
  // bytes remain intact for model extraction and the Xero attachment.
  const parser = new PDFParse({data:pdf.bytes.slice()});
  let text = '';
  try {
    const info = await parser.getInfo();
    if (!Number.isInteger(info.total) || info.total < 1 || info.total > MAX_PAGES) throw new Error('PDF page count outside extraction bounds');
    const result = await parser.getText();
    text = result.text?.trim() || '';
    if (text.length > 250000) throw new Error('PDF text exceeds extraction bounds');
  } finally { await parser.destroy(); }
  verifyInvoiceDocumentText(text, {textOnly:false}); // receipts only
  const merged = await extractInvoiceFields({text, pdf:pdf.bytes, filename:pdf.filename});
  if (merged.source==='text') {
    if (text.length < 10) throw new DocumentNeedsHumanReview('unclear','PDF has no readable text and model extraction is unavailable');
    verifyInvoiceDocumentText(text, {textOnly:true});
  }
  // Cross-check the reference against the attachment filename: a filename number that the
  // reference contains but does not equal (e.g. "RI 65930654" vs Invoice_65930654.pdf) is a note.
  const ref = merged.candidates.reference;
  if (ref) {
    const k = (s:string) => s.toLowerCase().replace(/[^a-z0-9]/g,'');
    const fileNums = pdf.filename.match(/\d{5,}/g) ?? [];
    if (fileNums.some(n => k(ref.value).includes(n)) && !k(pdf.filename).includes(k(ref.value))) {
      ref.uncertain = true;
      if (!merged.candidates.uncertainFields.includes('reference')) merged.candidates.uncertainFields.push('reference');
      merged.notes.push(`Invoice number "${ref.value}" differs from the number in the filename ${pdf.filename} - verify`);
    }
  }
  const type = merged.candidates.documentType.value;
  if (type==='receipt') throw new DocumentNeedsHumanReview('supporting_document','Receipt: supporting document only; never posted to Xero');
  if (type!=='invoice' && type!=='credit_note') throw new DocumentNeedsHumanReview('not_invoice',`Not an invoice or credit note (${type})`);
  if (!merged.candidates.grossAmount) throw new DocumentNeedsHumanReview('unclear',
    ['No gross amount found on the document; cannot draft', ...merged.notes].join(' | '));
  return {...merged, text};
}

const CACHE_MS = 10 * 60 * 1000;
let xeroCache: {at:number; contacts:Array<{ContactID?:string;Name?:string;PurchasesDefaultAccountCode?:string}>;
  accounts:Array<{Code?:string;Name?:string;Type?:string;Status?:string}>; bills:unknown[]|null} | null = null;

/** Live read-only Xero candidate listing. Never creates supplier contacts. */
export async function makeLiveDraftCommand(conversation: InboxConversation, attachment: InboxAttachment, _client?: PoolClient): Promise<DraftCommand> {
  if (process.env.FRONT_ENABLED_INBOX_ID !== INBOX || process.env.XERO_PILOT_TENANT_ID !== TENANT || process.env.XERO_DRAFT_WRITES_ENABLED?.toLowerCase() !== 'true') {
    throw new Error('AP draft-only live processing is disabled for this inbox/tenant');
  }
  const frontToken = process.env.FRONT_API_TOKEN;
  if (!frontToken) throw new Error('Front token missing');
  const pdf = embeddedPdfs.get(attachment.id) ?? await downloadFrontOriginalPdf(attachment, frontToken);
  const extraction = await extractPdfCandidates(pdf);
  const candidates = extraction.candidates;
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
  // Xero reference data is read once and reused for the run (10-minute cache).
  // Accounts is not paginated in Xero: one request returns the whole chart.
  if (!xeroCache || Date.now() - xeroCache.at > CACHE_MS) {
    const accountsResponse=await xeroFetch(`${API}/Accounts`,{headers,signal:AbortSignal.timeout(25000)});
    if(!accountsResponse.ok) throw new Error(`Xero Accounts read HTTP ${accountsResponse.status}`);
    const accountsBody=await accountsResponse.json() as {Accounts?:Array<{Code?:string;Name?:string;Type?:string;Status?:string}>};
    if(!Array.isArray(accountsBody.Accounts)) throw new Error('Malformed Xero Accounts response');
    xeroCache={at:Date.now(),
      contacts:await readPaged<{ContactID?:string;Name?:string;PurchasesDefaultAccountCode?:string}>('Contacts','Contacts'),
      accounts:accountsBody.Accounts,bills:null};
  }
  const cache=xeroCache;
  const rawContacts=cache.contacts;
  const rawAccounts=cache.accounts;
  const contacts:ContactCandidate[]=rawContacts.filter(c=>c.ContactID&&c.Name).map(c=>({id:c.ContactID!,name:c.Name!,
    ...(c.PurchasesDefaultAccountCode?{defaultPurchaseCode:c.PurchasesDefaultAccountCode}:{})}));
  const accounts:AccountCandidate[]=rawAccounts.map(a=>({code:a.Code||'',name:a.Name||'',type:a.Type||'',status:a.Status||''}));
  // Read-only history: use the newest approved/paid purchase bill for this exact existing Xero contact.
  async function recentAccountCodeForContact(contactId:string):Promise<string|undefined> {
    type HistoricalBill = {Type?:string;Status?:string;DateString?:string;Date?:string;InvoiceID?:string;
      Contact?:{ContactID?:string};LineItems?:Array<{AccountCode?:string}>};
    if (!cache.bills) cache.bills=await readPaged<HistoricalBill>('Invoices','Invoices');
    const bills=cache.bills as HistoricalBill[];
    // Only approved or paid bills are coding precedent; drafts (including the agent's own) are not.
    const eligible=bills.filter(b=>b.Type==='ACCPAY' && b.Contact?.ContactID===contactId &&
      ['AUTHORISED','PAID'].includes((b.Status??'').toUpperCase()) &&
      (b.DateString || b.Date) && b.LineItems?.some(line=>line.AccountCode));
    eligible.sort((a,b)=>String(b.DateString??b.Date).localeCompare(String(a.DateString??a.Date)) ||
      String(b.InvoiceID??'').localeCompare(String(a.InvoiceID??'')));
    return eligible[0]?.LineItems?.find(line=>line.AccountCode)?.AccountCode;
  }
  const command = await buildDraftFromAvailableCandidates({candidates,contacts,accounts,pdf,reviewNotes:extraction.notes,
    fallbackDate:new Date().toISOString().slice(0,10),
    fallbackReference:`FRONT-${attachment.id}`,
    recentAccountCodeForContact,
  });
  // Follow the supplier's existing invoice-number format in Xero (e.g. drop "RI " when the
  // supplier's earlier bills are plain numbers).
  if (!cache.bills) cache.bills=await readPaged<any>('Invoices','Invoices');
  const history=(cache.bills as Array<{Type?:string;Status?:string;InvoiceNumber?:string;Contact?:{ContactID?:string}}>)
    .filter(b=>b.Type==='ACCPAY' && b.Contact?.ContactID===command.supplierContactId && ['AUTHORISED','PAID'].includes(String(b.Status).toUpperCase()))
    .map(b=>b.InvoiceNumber??'').slice(0,20);
  const aligned=alignToSupplierNumberFormat(command.number,history);
  if (!aligned && matchesSupplierNumberFormat(command.number,history)) {
    // e.g. Henry Schein bills are recorded as "RI 659..." in Xero while the filename has the bare
    // number: the reference follows the supplier's existing format, so the filename check stands down.
    const before=command.reviewNotes??[];
    command.reviewNotes=before.filter(n=>!n.startsWith(`Invoice number "${command.number}" differs from the number in the filename`));
    if (command.reviewNotes.length!==before.length) command.uncertainFields=command.uncertainFields.filter(f=>f!=='reference');
  }
  if (aligned && aligned!==command.number) {
    const original=command.number;
    command.number=aligned;
    command.infoNotes=[...(command.infoNotes??[]),`Invoice number "${original}" recorded as "${aligned}" to match this supplier's existing Xero numbers`];
    if (pdf.filename.replace(/[^0-9]/g,' ').split(' ').includes(aligned)) {
      command.uncertainFields=command.uncertainFields.filter(f=>f!=='reference');
      command.reviewNotes=(command.reviewNotes??[]).filter(n=>!n.startsWith(`Invoice number "${original}" differs from the number in the filename`));
    }
  }
  // Same identity check as the supervised route, used only when the contact match is uncertain
  // (it downloads previous bill PDFs from Xero): the supplier printed on this PDF matches the one
  // printed on one of the contact's three most recent bills -> confirmed, not a review issue.
  if (command.uncertainFields.includes('supplier') && extraction.text) {
    const check = await confirmContactByHistoricalPdf(command.supplierContactId, extraction.text).catch(() => ({ matched: false }));
    if (check.matched) {
      command.uncertainFields = command.uncertainFields.filter(f => f !== 'supplier');
      command.reviewNotes = (command.reviewNotes ?? []).filter(n => !n.startsWith('Supplier:'));
      command.infoNotes = [...(command.infoNotes ?? []), 'Supplier confirmed against a previous invoice PDF in Xero'];
    }
  }
  // A customer account number not seen on this supplier's recent bills may be a different
  // account (e.g. another site or a closed line): drafted, but flagged for finance.
  if (extraction.customerAccountNumber) {
    const acct = await accountNumberOnPreviousBills(command.supplierContactId, extraction.customerAccountNumber).catch(() => null);
    if (acct?.checked && !acct.found) {
      command.reviewNotes = [...(command.reviewNotes ?? []), `Account number ${extraction.customerAccountNumber} is not on ${command.supplierName ?? 'this supplier'}'s recent invoices (${(acct.compared_with ?? []).join(', ')}); check it is the right account before approving`];
    }
  }
  return command;
}
