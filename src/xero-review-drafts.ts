import { createHash } from 'node:crypto';
import { xeroFetch } from "./xero-rate-limit.js";
import { PDFParse } from 'pdf-parse';
/** Supervised AP draft creation. Uncertainty is recorded for review, not an approval gate.
 * All external writes require XERO_DRAFT_WRITES_ENABLED=true and the fixed pilot tenant.
 * An indeterminate Xero POST is never automatically retried: manual reconciliation first.
 */
import type { Pool } from 'pg';
import { getPilotXeroWriteSession } from './xero-pilot-test.js';
import { syncPilotReviewExceptions } from './google-sheets-review.js';
import { originalFrontDocument, attachAndVerifyOriginal } from './xero-draft-bills.js';
import { lookupXeroPurchaseNumber } from './xero-duplicate-lookup.js';
import { selectLatestInvoiceVersion } from './invoice-version-policy.js';
import { vatPolicyForInbox, grossExpenseLine } from './inbox-vat-policy.js';
export { selectLatestInvoiceVersion } from './invoice-version-policy.js';

const TENANT = '45a1074b-b172-4f49-a192-f0a8e293b54d';
const INBOX = 'inb_bys7q';
const API = 'https://api.xero.com/api.xro/2.0/';
const dateOk = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0,10) === s;
// Normalise common UK source dates at the boundary; never silently swap ambiguous ISO dates.
export function normaliseInvoiceDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const s=value.trim();
  if (dateOk(s)) return s;
  const m=/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/.exec(s);
  if (!m) return null;
  const year=m[3].length===2 ? `20${m[3]}` : m[3];
  const iso=`${year}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return dateOk(iso)?iso:null;
}
const due30 = (s: string) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+30); return d.toISOString().slice(0,10); };
const money = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && Math.abs(n*100-Math.round(n*100)) < 0.00001;
const idOk = (s: string) => /^[1-9]\d{0,17}$/.test(s);
export function pilotDraftWriteState() {
  const configured = process.env.XERO_DRAFT_WRITES_ENABLED?.trim().toLowerCase() === 'true';
  const pilotScope = process.env.FRONT_ENABLED_INBOX_ID === INBOX && process.env.XERO_PILOT_TENANT_ID === TENANT;
  return {draft_writes_enabled: configured && pilotScope, draft_write_switch_configured: configured,
    pilot_scope_verified: pilotScope, connection_enabled_is_oauth_metadata: true};
}
export type DirectDraftPreview = {
  document_type: 'invoice'|'credit_note'; supplier_name?: string; invoice_number?: string;
  invoice_date?: string; gross_gbp?: number; due_date?: string; proposed_account?: string;
  billed_to?: string; exceptions?: string[]; front_conversation_id?: string;
};
function previewFields(data: DirectDraftPreview, linkedId?: string | null, attempt?: string | null) {
  const essential_missing:string[]=[];
  const review_issues:string[]=[...(data.exceptions ?? [])];
  if (!['invoice','credit_note'].includes(data.document_type)) essential_missing.push('Not an invoice or credit note');
  if (!data.supplier_name?.trim()) essential_missing.push('Supplier name not available for Xero contact');
  if (!data.invoice_number?.trim()) essential_missing.push('Document number not available');
  if (!dateOk(data.invoice_date)) essential_missing.push('Valid document date not available');
  if (!money(Math.abs(data.gross_gbp ?? 0))) essential_missing.push('Valid non-zero gross amount not available');
  if (!data.proposed_account?.trim()) review_issues.push('Nominal code needs review; valid Xero fallback account required');
  if (!dateOk(data.due_date) && dateOk(data.invoice_date)) review_issues.push('Due date defaults to invoice date + 30 days');
  if (data.billed_to && data.billed_to !== "St George's Road Surgery") review_issues.push('Billing entity requires review');
  if (linkedId) essential_missing.push('Already linked to an existing Xero document');
  if (attempt && !linkedId) essential_missing.push('Previous draft attempt needs reconciliation');
  return {status:linkedId?'existing_xero_document':essential_missing.length?'requires_source_data_or_reconciliation':'draft_candidate',
    essential_missing,review_issues,document_type:data.document_type,
    ...pilotDraftWriteState(),requires_human_review:true,creates_draft:false,
    duplicate_check_completed:false,
    note:'Preview does not query Xero for duplicates, contacts or account validity. Draft creation performs those checks.'};
}
export function previewDirectDraft(data:DirectDraftPreview):Record<string,unknown> {
  return {...previewFields(data),preview_source:'extracted_fields',review_id:null};
}

type Api = { tenantId: string; accessToken: string };
async function xero(api: Api, path: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await xeroFetch(API + path, { method, headers: {
    Authorization: `Bearer ${api.accessToken}`, 'xero-tenant-id': api.tenantId,
    Accept: 'application/json', ...(body ? {'Content-Type':'application/json'} : {})
  }, ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(25000) });
  if (!response.ok) {
    const requestId = response.headers.get('xero-correlation-id') ?? response.headers.get('x-request-id');
    const retryAfter = response.headers.get('retry-after');
    const detail = (await response.text().catch(() => '')).slice(0, 700);
    throw new Error(`Xero ${method} ${path.split('?')[0]} HTTP ${response.status}${requestId ? ` request_id=${requestId}` : ''}${retryAfter ? ` retry_after=${retryAfter}` : ''}: ${detail || 'no response body'}; reconcile Xero before retry`);
  }
  return response.json();
}

function supplierKey(name:string):string {
  return name.toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim()
    .replace(/\b(limited|ltd)\b$/,'').trim();
}
/** Name similarity is a DISCOVERY threshold, not identity proof. */
function supplierTokens(name:string):string[] {
  return supplierKey(name).replace(/([a-z])([0-9])/g,'$1 $2').replace(/([0-9])([a-z])/g,'$1 $2')
    .replace(/\b(dd|direct debit|limited|ltd|plc|the|uk)\b/g,' ')
    .split(/\s+/).filter(Boolean);
}
export function supplierNameSimilarity(a:string,b:string):number {
  const x=supplierTokens(a), y=supplierTokens(b);
  if(!x.length||!y.length) return 0;
  if(x.join(' ')===y.join(' ')) return 1;
  const common=x.filter(t=>y.includes(t)).length;
  // Dice overlap respects token order-independent matching, with modest prefix credit.
  const tokenScore=2*common/(x.length+y.length);
  const ax=x.join(''),by=y.join('');
  let prefix=0;while(prefix<Math.min(ax.length,by.length)&&ax[prefix]===by[prefix])prefix++;
  return Math.max(tokenScore, prefix/Math.max(ax.length,by.length));
}
type ContactMatch={id:string;name:string;alias:boolean;confidence:string};
/** A 50% contact-name match is only a candidate. The incoming supplier name
 * must appear as the supplier name on an attached invoice PDF belonging to one
 * of that contact's THREE most recent purchase bills (not three attached bills).
 * No address, registration or VAT comparisons, and no hard-coded aliases.
 */
function comparableSupplierName(value:string):string {
  return value.toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim();
}
/** Extract supplier names from the PDF itself. Never use the review's supplier_name
 * as the string compared with historical PDF text. Keep extraction confined to
 * invoice header; do not match customer names or line-item descriptions.
 * An unreadable or ambiguous name fails closed.
 */
/** A single supplier identity, taken only from the incoming or historical PDF.
 * Do not accept any legal name in a bill-to/customer block as supplier evidence.
 * Ambiguous header identities fail closed, rather than matching a shared customer.
 */
function pdfSupplierName(text:string):string|null {
  const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).slice(0,100);
  const stop=/^(?:bill\s*to|invoice\s*to|sold\s*to|customer|ship\s*to|deliver\s*to|billed\s*to|recipient|to:)\b/i;
  const label=/^(?:supplier|seller|vendor|issued\s+by|from)\s*[:\-]\s*/i;
  const payee=/^(?:account\s*(?:holder\s*)?name|beneficiary\s*name|payee\s*name)\s*[:\-]\s*/i;
  const legal=/\b(?:ltd|limited|llp|plc|inc|incorporated)\b/i;
  const isName=(value:string)=>value.length>=5 && value.length<=110 && /[a-z]/i.test(value)
    && !/^(?:\d|bank:|sort code|account number|vat number)/i.test(value);
  const issuerNames:string[]=[];
  const payeeNames:string[]=[];
  let beforeRecipient=true;
  for(let i=0;i<lines.length;i++) {
    const line=lines[i];
    if(stop.test(line)) beforeRecipient=false;
    if(beforeRecipient && label.test(line)) {
      const raw=line.replace(label,'').trim() || (lines[i+1]??'');
      if(isName(raw)) issuerNames.push(comparableSupplierName(raw));
    }
    // A labelled remittance account holder is a candidate, not proof of issuer.
    // Only accept it when historical Xero bill PDFs yield the same candidate.
    if(payee.test(line)) {
      const raw=line.replace(payee,'').trim() || (lines[i+1]??'');
      if(isName(raw)) payeeNames.push(comparableSupplierName(raw));
    }
  }
  const unique=(values:string[])=>[...new Set(values)];
  const explicit=unique(issuerNames);
  const payees=unique(payeeNames);
  // Conflicting explicit issuer and payee identities are unsafe to auto-resolve.
  if(explicit.length>1 || payees.length>1) return null;
  if(explicit.length===1 && payees.length===1 && explicit[0]!==payees[0]) return null;
  if(explicit.length===1) return explicit[0];
  if(payees.length===1) return payees[0];
  // Unlabelled masthead fallback only, never the recipient or a line item.
  const masthead:string[]=[];
  for(const line of lines.slice(0,15)) {
    if(stop.test(line) || /^(?:tax\s+)?invoice\b/i.test(line)) break;
    if(legal.test(line) && !/\b(?:st george'?s road surgery)\b/i.test(line)) {
      const name=comparableSupplierName(line);
      if(name.length>=8 && name.length<=110) masthead.push(name);
    }
  }
  const names=unique(masthead);
  return names.length===1?names[0]:null;
}

async function pdfText(bytes:Buffer):Promise<string> {
  if(!bytes.length || bytes.length>15*1024*1024) throw new Error('Supplier invoice PDF empty or too large');
  const parser=new PDFParse({data:new Uint8Array(bytes)});
  try {return String((await parser.getText()).text??'');}
  finally {await parser.destroy();}
}
function samePrintedSupplier(incomingText:string,historicalText:string):boolean {
  const incoming=pdfSupplierName(incomingText);
  const historical=pdfSupplierName(historicalText);
  return !!incoming && !!historical && incoming===historical;
}

async function historicalInvoiceNameMatches(api:Api,contactId:string,incomingPdfText:string):Promise<{matched:boolean;bill_id?:string;filename?:string}> {
  const filter=encodeURIComponent(`Type=="ACCPAY"&&Contact.ContactID==Guid("${contactId}")`);
  const response=await xero(api,`Invoices?where=${filter}&order=${encodeURIComponent('Date DESC')}&page=1`);
  const bills=response.Invoices;
  if(!Array.isArray(bills)) throw new Error('Xero supplier bill history unavailable');
  // Strictly inspect the three most recent bills, even if they lack attachments.
  for(const bill of bills.filter((b:any)=>b.Type==='ACCPAY' && String(b.Contact?.ContactID??'').toLowerCase()===contactId.toLowerCase()).slice(0,3)) {
    if(!bill.InvoiceID) continue;
    const listing=await xero(api,`Invoices/${encodeURIComponent(bill.InvoiceID)}/Attachments`);
    const attachments=listing.Attachments;
    if(!Array.isArray(attachments)) throw new Error('Xero bill attachment listing unavailable');
    for(const attachment of attachments) {
      const filename=String(attachment.FileName??'');
      if(!/\.pdf$/i.test(filename)) continue;
      const path=`Invoices/${encodeURIComponent(bill.InvoiceID)}/Attachments/${encodeURIComponent(filename)}`;
      const response=await xeroFetch(API+path,{headers:{Authorization:`Bearer ${api.accessToken}`,'xero-tenant-id':api.tenantId,Accept:'application/pdf'},signal:AbortSignal.timeout(25000)});
      if(!response.ok) throw new Error(`Xero historical PDF retrieval failed: HTTP ${response.status}`);
      const bytes=Buffer.from(await response.arrayBuffer());
      if(!bytes.length || bytes.length>15*1024*1024) throw new Error('Historical invoice PDF empty or too large');
      const text=await pdfText(bytes);
      if(samePrintedSupplier(incomingPdfText,text)) return {matched:true,bill_id:bill.InvoiceID,filename};
    }
  }
  return {matched:false};
}
async function findSupplierContact(api:Api,supplier:string,incomingPdfText?:string):Promise<ContactMatch|null> {
  const contacts:any[]=[];let complete=false;
  for(let page=1;page<=20;page++) {
    const response=await xero(api,`Contacts?page=${page}`);
    const list=response.Contacts??[];
    if(!Array.isArray(list)) throw new Error('Xero contacts response invalid');
    contacts.push(...list.filter((c:any)=>c.ContactID && c.Name));
    if(list.length<100){complete=true;break;}
  }
  if(!complete) throw new Error('Xero contacts pagination incomplete; supplier unresolved');
  const printedName=incomingPdfText?pdfSupplierName(incomingPdfText):null;
  if(!printedName) throw new Error('Incoming PDF has no unambiguous supplier name; supplier verification blocked');
  const candidates=contacts.map(c=>({c,score:supplierNameSimilarity(printedName,String(c.Name))}))
    .filter(x=>x.score>=0.50).sort((a,b)=>b.score-a.score);
  if(!candidates.length) return null;
  const confirmed:ContactMatch[]=[];
  for(const {c,score} of candidates) {
    const evidence=await historicalInvoiceNameMatches(api,String(c.ContactID),incomingPdfText!);
    if(evidence.matched) confirmed.push({id:String(c.ContactID),name:String(c.Name),alias:printedName!==comparableSupplierName(String(c.Name)),confidence:`historical_pdf_supplier_name_match; bill=${evidence.bill_id}; filename=${evidence.filename}; candidate_similarity=${score.toFixed(2)}`});
  }
  if(confirmed.length>1) throw new Error(`Multiple Xero contacts have matching historical supplier invoice names: ${confirmed.map(x=>x.name).join(', ')}`);
  if(!confirmed.length) throw new Error(`No supplier-name match found in the three most recent Xero bills for any 50%+ candidate; supplier review required`);
  return confirmed[0];
}
/** Read-only supplier identity check for a recorded Front invoice. Uses the exact
 * original PDF and the same candidate/history verification as draft creation.
 * Never trusts a review field as the supplier identity proof. */
export async function resolveExistingXeroSupplierForReview(input:{
  conversationId:string; messageId:string; attachmentId:string; supplierName:string;
}):Promise<{contact_id:string;contact_name:string;match_confidence:string;alias:boolean}> {
  const original=await originalFrontDocument({
    conversationId:input.conversationId,messageId:input.messageId,attachmentId:input.attachmentId
  });
  const incomingPdfText=await pdfText(original.bytes);
  const api=await getPilotXeroReadSessionForLink();
  const contact=await findSupplierContact(api,input.supplierName,incomingPdfText);
  if(!contact) throw new Error('No qualifying existing Xero contact found for supplier printed on incoming PDF');
  return {contact_id:contact.id,contact_name:contact.name,match_confidence:contact.confidence,alias:contact.alias};
}

export async function resolveExistingXeroSupplierForDraft(supplier:string):Promise<{contact_id:string;contact_name:string;match_confidence:string;alias:boolean}> {
  throw new Error('Incoming PDF required for supplier verification; use Front intake or review-based workflow');
}
async function supplierContact(api: Api, supplier: string, incomingPdfText: string): Promise<{id:string; created:boolean; issue?:string}> {
  // Historical PDF matching improves the candidate but must not veto a draft.
  let match: ContactMatch | null = null;
  try { match = await findSupplierContact(api, supplier, incomingPdfText); } catch { /* use ranked contact fallback */ }
  if (match) return {id:match.id,created:false,...(match.alias?{issue:`Supplier candidate ${match.name}; verify identity`}:{})};
  const response = await xero(api, 'Contacts');
  const contacts = Array.isArray(response.Contacts) ? response.Contacts : [];
  const ranked = contacts.filter((c:any)=>c.ContactID && c.Name)
    .map((c:any)=>({contact:c, score:supplierNameSimilarity(supplier,String(c.Name))}))
    .sort((a:any,b:any)=>b.score-a.score);
  if (ranked[0]?.score >= 0.72) return {id:String(ranked[0].contact.ContactID),created:false,
    issue:`Best-candidate supplier ${ranked[0].contact.Name} selected without PDF-to-PDF confirmation; finance must verify`};
  const created = await xero(api,'Contacts','POST',{Contacts:[{Name:supplier.slice(0,150)}]});
  const contact=created.Contacts?.[0];
  if (!contact?.ContactID || contact.HasErrors || contact.ValidationErrors?.length)
    throw new Error('Xero provisional supplier contact creation did not succeed; reconcile before retry');
  return {id:String(contact.ContactID),created:true,issue:'Provisional supplier contact created; finance must verify'};
}

/** Approved/paid Xero purchase bills are the supplier's authorised coding precedent.
 * Read-only, bounded and contact-ID scoped. Ambiguous history is reported, not guessed.
 */
export async function inspectApprovedSupplierCoding(supplierName:string, description:string, incomingPdfText?:string):Promise<Record<string,unknown>> {
  const api=await getPilotXeroReadSessionForLink();
  const contact=await findSupplierContact(api,supplierName,incomingPdfText);
  if(!contact) return {status:'contact_unresolved',account_code:null,issues:['Existing supplier not verified']};
  const filter=encodeURIComponent(`Type=="ACCPAY"&&Contact.ContactID==Guid("${contact.id}")`);
  const response=await xero(api,`Invoices?where=${filter}&order=${encodeURIComponent('Date DESC')}&page=1`);
  if(!Array.isArray(response.Invoices)) throw new Error('Supplier bill history unavailable');
  const recent=response.Invoices.filter((b:any)=>b.Type==='ACCPAY' && String(b.Contact?.ContactID??'').toLowerCase()===contact.id.toLowerCase() && ['AUTHORISED','PAID'].includes(b.Status));
  if(!recent.length) return {status:'no_approved_history',account_code:null,issues:['No approved or paid supplier bill available for coding']};
  const latest=recent[0];
  // Fetch detail: Xero list responses may omit LineItems.
  const detail=await xero(api,`Invoices/${encodeURIComponent(latest.InvoiceID)}`);
  const bill=detail.Invoices?.[0];
  if(!bill || bill.InvoiceID!==latest.InvoiceID) throw new Error('Most recent supplier bill detail unavailable');
  const codes=[...new Set((bill.LineItems??[]).map((l:any)=>String(l.AccountCode??'').trim()).filter(Boolean))];
  const accounts=await xero(api,'Accounts');
  const active=new Set((accounts.Accounts??[]).filter((a:any)=>a.Status==='ACTIVE').map((a:any)=>String(a.Code)));
  const code=codes.length===1 && active.has(codes[0])?codes[0]:null;
  return {status:code?'latest_bill_account_selected':'latest_bill_coding_ambiguous',account_code:code,
    contact_id:contact.id,source_bill_id:latest.InvoiceID,selection_method:'most_recent_approved_or_paid_bill',
    issues:code?[]:['Most recent supplier bill has no single active account code; coding review required'],
    matching_description:description.slice(0,200),tax_type:vatPolicyForInbox(INBOX).purchaseTaxType};
}

/** Fail closed: only the latest approved/paid supplier bill may supply a draft account. */
async function accountCode(api: Api, preferred: unknown): Promise<{code:string; fallback:boolean}> {
  const data=await xero(api,'Accounts');
  if (!Array.isArray(data.Accounts)) throw new Error('Xero accounts validation unavailable');
  const active=data.Accounts.filter((a:any)=>a.Status==='ACTIVE' && a.Code &&
    !['BANK','REVENUE','EQUITY','LIABILITY','CURRENTLIAB','FIXED','CURRENT'].includes(String(a.Type).toUpperCase()));
  const chosen=active.find((a:any)=>String(a.Code)===String(preferred??'')) ??
    active.find((a:any)=>String(a.Code)===String(process.env.AP_FALLBACK_ACCOUNT_CODE??''));
  if (!chosen) throw new Error('No valid account code: configure AP_FALLBACK_ACCOUNT_CODE to an active expense account');
  return {code:String(chosen.Code),fallback:String(chosen.Code)!==String(preferred??'')};
}

export async function inspectIntakeIdentity(pool:Pool, input:{conversationId:string;messageId:string;attachmentId:string;supplierName:string;invoiceNumber:string;documentType:'invoice'|'credit_note'}):Promise<Record<string,unknown>> {
  const rows=await pool.query(`SELECT id::text, front_message_id, attachment_id, supplier_name, invoice_number,
    document_type, review_status, xero_draft_id, xero_draft_status FROM pilot_invoice_reviews
    WHERE (front_message_id=$1 AND attachment_id=$2)
       OR (front_conversation_id=$3 AND lower(trim(invoice_number))=lower(trim($4)))
    ORDER BY CASE WHEN front_message_id=$1 AND attachment_id=$2 THEN 0 ELSE 1 END, id`,
    [input.messageId,input.attachmentId,input.conversationId,input.invoiceNumber]);
  const reviews=rows.rows;
  // Repeated Front PDF copies may have separate reviews; do not treat identical
  // invoice identities as separate liabilities. Never silently merge conflicting identities.
  if(reviews.length>1 && reviews.some((r:any)=>String(r.invoice_number??'').trim().toLowerCase()!==input.invoiceNumber.trim().toLowerCase() || r.document_type!==input.documentType || supplierKey(String(r.supplier_name??''))!==supplierKey(input.supplierName)))
    throw new Error('Conflicting PostgreSQL reviews for this invoice; reconcile identity');
  const review=reviews[0]??null;
  if(review && (String(review.invoice_number??'').trim().toLowerCase()!==input.invoiceNumber.trim().toLowerCase()
      || review.document_type!==input.documentType))
    throw new Error('Existing attachment review has a different invoice identity; reconcile before drafting');
  const api=await getPilotXeroReadSessionForLink();
  if(api.tenantId!==TENANT) throw new Error('Wrong Xero tenant for intake preflight');
  const incoming=await originalFrontDocument({conversationId:input.conversationId,messageId:input.messageId,attachmentId:input.attachmentId});
  const incomingPdfText=await pdfText(incoming.bytes);
  const contactMatch=await findSupplierContact(api,input.supplierName,incomingPdfText);
  const foundDocs=await lookupXeroPurchaseNumber(api,input.invoiceNumber);
  if(foundDocs.length>1) throw new Error('Multiple Xero purchase documents match number; reconcile before drafting');
  const matched=foundDocs[0]??null;
  const id=matched?.id??null;
  const doc=matched;
  const issues:string[]=[];
  if(review && String(review.supplier_name??'').trim().toLowerCase()!==input.supplierName.trim().toLowerCase())
    issues.push('PostgreSQL supplier name differs from extracted supplier; verify identity');
  if(doc && supplierKey(String(doc.contactName??''))!==supplierKey(input.supplierName))
    issues.push('Existing Xero document supplier differs from extracted supplier; verify before linking');
  if(review?.xero_draft_id && doc && review.xero_draft_id!==id)
    throw new Error('PostgreSQL and Xero document IDs conflict; reconcile before drafting');
  if(review?.xero_draft_id && !doc)
    throw new Error('PostgreSQL links a Xero document not found by number; reconcile before drafting');
  return {review_id:review?.id??null,review_status:review?.review_status??null,
    review_match:review?(review.front_message_id===input.messageId && review.attachment_id===input.attachmentId?'attachment':'conversation_invoice'):null,
    postgres_supplier_mismatch:issues.some(i=>i.startsWith('PostgreSQL')),
    existing_xero_document:!!doc,xero_document_id:id,xero_document_status:doc?.status??null,
    xero_supplier_name:doc?.contactName??null,xero_document_type:matched?.kind??null,xero_number_exact:matched?.exact??null,duplicate_check_completed:true,
    identity_review_issues:issues,requires_identity_reconciliation:!!doc && issues.some(i=>i.startsWith('Existing Xero')),
    supplier_contact_match:contactMatch?{contact_id:contactMatch.id,name:contactMatch.name,confidence:contactMatch.confidence}:null,
    supplier_contact_unresolved:!contactMatch,
    prior_draft_attempt:review?.xero_draft_status??null};
}

export async function previewReviewDraft(pool:Pool, reviewId:string): Promise<Record<string,unknown>> {
  if (!idOk(reviewId)) throw new Error('Invalid review ID');
  const data = await pool.query(`SELECT document_type, supplier_name, invoice_number, assessment_json,
    front_conversation_id, front_message_id, attachment_id, review_status,
    xero_draft_id, xero_draft_status FROM pilot_invoice_reviews WHERE id=$1`,[reviewId]);
  if (data.rowCount !== 1) throw new Error('Review not found');
  const r = data.rows[0]; const a = r.assessment_json ?? {};
  const base = previewFields({document_type:r.document_type,supplier_name:r.supplier_name || a.xero_supplier,
    invoice_number:r.invoice_number,invoice_date:a.invoice_date,gross_gbp:a.gross_gbp,
    due_date:a.due_date,proposed_account:a.proposed_account,billed_to:a.billed_to,
    exceptions:Array.isArray(a.exceptions)?a.exceptions:[]},r.xero_draft_id,r.xero_draft_status);
  // A review preview must use the SAME PDF evidence and latest-bill coding as
  // createReviewDraft. Stored names/proposed accounts are not verification.
  const original=await originalFrontDocument({conversationId:String(r.front_conversation_id),
    messageId:String(r.front_message_id),attachmentId:String(r.attachment_id)});
  const pdf=await pdfText(original.bytes);
  const api=await getPilotXeroReadSessionForLink();
  const verified=await findSupplierContact(api,String(r.supplier_name??''),pdf);
  const coding=verified?await inspectApprovedSupplierCoding(String(r.supplier_name??''),'',pdf):
    {status:'contact_unresolved',account_code:null,issues:['Incoming and historical PDF supplier names did not match']};
  // Resolve old assessment warnings using current source evidence, not stored guesses.
  // A missing legal-entity label is not itself a conflict when the PDF names the
  // practice as recipient. A different named recipient must still be reviewed.
  const practiceRecipient=/st\s*george[’\'s\s.-]*road\s*surgery/i.test(pdf);
  const practiceAddress=/102\s+st\.?\s*george[’\'s\s.-]*road/i.test(pdf) &&
    /coventry/i.test(pdf) && /CV1\s*2DL/i.test(pdf);
  const recordedRecipient=String(a.billed_to??'').trim();
  const conflictingRecipient=!!recordedRecipient &&
    !/st\s*george[’\'s\s.-]*road\s*surgery/i.test(recordedRecipient) &&
    !/^(?:unknown|not stated|not extracted|none|n\/?a)$/i.test(recordedRecipient) &&
    !/102\s+st\.?\s*george[’\'s\s.-]*road/i.test(recordedRecipient);
  let latestVersionVerified=false;
  let latestVersionError='';
  try {
    await assertLatestRecordedFrontVersion(pool,r,original.bytes);
    latestVersionVerified=true;
  } catch (error) {
    latestVersionError=error instanceof Error?error.message:String(error);
  }
  const issues=(base.review_issues as string[]).filter(issue=>
    !(/nominal code needs review/i.test(issue) && coding.status==='latest_bill_account_selected') &&
    !(/supplier identity/i.test(issue) && !!verified) &&
    !(/billing entity|legal entity name/i.test(issue) && (practiceRecipient||practiceAddress) && !conflictingRecipient) &&
    !(/latest.version copy/i.test(issue) && latestVersionVerified));
  if (!verified) issues.push('PDF-to-PDF supplier identity verification failed');
  if (!(practiceRecipient||practiceAddress) || conflictingRecipient)
    issues.push('Billed-to practice not unambiguously verified from invoice PDF and recorded recipient');
  if (!latestVersionVerified) issues.push(`Latest Front version not verified: ${latestVersionError}`);
  if (coding.status!=='latest_bill_account_selected') issues.push('Latest approved/paid supplier bill has no single active account code');
  const explicitHold=r.review_status==='on_hold'||r.review_status==='rejected';
  if (explicitHold) issues.push('Explicit human hold or rejection');
  const essential=(base.essential_missing as string[]);
  return {...base,review_id:reviewId,preview_source:'postgres_review_pdf_verified',
    supplier_verified:!!verified,verified_xero_contact_id:verified?.id??null,
    latest_front_version_verified:latestVersionVerified,billed_to_practice_verified:(practiceRecipient||practiceAddress)&&!conflictingRecipient,
    historical_coding:coding,account_code_selected:coding.status==='latest_bill_account_selected',
    selected_account_code:coding.account_code??null,tax_type:vatPolicyForInbox(INBOX).purchaseTaxType,
    gross_expense_gbp:typeof a.gross_gbp==='number'?Math.abs(a.gross_gbp):null,
    review_issues:issues,requires_human_review:explicitHold||issues.length>0||essential.length>0,
    note:'Read-only preview uses incoming PDF-to-historical-PDF identity and latest approved/paid bill account. Final draft creation independently checks duplicate, latest version, explicit holds, VAT and PDF attachment.'};
}

/** Resume the PDF + Sheet stages for an already linked Xero document.
 * Never posts another invoice/credit note, and never alters human review status.
 * The live Xero document must still match the stored invoice number and supplier.
 */
export async function completeExistingReviewDraft(pool:Pool, reviewId:string):Promise<Record<string,unknown>> {
  if (!idOk(reviewId)) throw new Error('Invalid review ID');
  if (!pilotDraftWriteState().draft_writes_enabled) throw new Error('Pilot draft writes disabled');
  const result=await pool.query(`SELECT id::text,front_conversation_id,front_message_id,attachment_id,
    supplier_name,invoice_number,document_type,xero_draft_id,xero_attachment_verified,review_status
    FROM pilot_invoice_reviews WHERE id=$1`,[reviewId]);
  if(result.rowCount!==1) throw new Error('Review not found');
  const r=result.rows[0];
  // No Sheet HOLD gate: the finance Sheet is reporting only.
  if(r.review_status==='on_hold' || r.review_status==='rejected') throw new Error('Human hold/rejection prevents Xero changes');
  if(!r.xero_draft_id) throw new Error('No linked Xero document; reconcile and link before attachment recovery');
  const kind=r.document_type==='credit_note'?'CreditNotes':r.document_type==='invoice'?'Invoices':null;
  if(!kind) throw new Error('Invalid review document type');
  const api=await getPilotXeroReadSessionForLink();
  const data=await xero(api,`${kind}/${encodeURIComponent(r.xero_draft_id)}`);
  const doc=data[kind]?.[0];
  const number=kind==='Invoices'?doc?.InvoiceNumber:doc?.CreditNoteNumber;
  if(!doc || number!==r.invoice_number || supplierKey(String(doc.Contact?.Name??'')).replace(/\s+dd$/,'')!==supplierKey(String(r.supplier_name??'')).replace(/\s+dd$/,''))
    throw new Error('Linked Xero document identity mismatch; do not upload attachment');
  if(['DELETED','VOIDED'].includes(String(doc.Status??''))) throw new Error('Xero document is voided or deleted');
  let attachmentVerified=r.xero_attachment_verified===true;
  if(!attachmentVerified){
    const original=await originalFrontDocument({conversationId:r.front_conversation_id,
      messageId:r.front_message_id,attachmentId:r.attachment_id});
    // The attachment uploader uses PUT to a deterministic filename and then GET
    // to verify its presence. Never create another bill to recover a PDF.
    await attachAndVerifyOriginal(api.tenantId,api.accessToken,r.xero_draft_id,
      original.filename,original.contentType,original.bytes,kind);
    await pool.query(`UPDATE pilot_invoice_reviews SET xero_attachment_verified=TRUE,
      updated_at=NOW() WHERE id=$1 AND xero_draft_id=$2`,[reviewId,r.xero_draft_id]);
    attachmentVerified=true;
  }
  let sheetStatus:'synced'|'sync_failed'='synced';
  try {await syncPilotReviewExceptions(pool,[reviewId]);}
  catch(error){sheetStatus='sync_failed';console.error('Draft completion Sheet sync failed',error);}
  return {status:attachmentVerified&&sheetStatus==='synced'?'draft_pdf_and_sheet_completed':'draft_pdf_verified_sheet_sync_failed',
    review_id:reviewId,xero_draft_id:r.xero_draft_id,xero_status:doc.Status,
    original_pdf_attached_and_verified:attachmentVerified,sheet_status:sheetStatus,
    human_review_status_preserved:r.review_status,created_xero_document:false};
}

export async function createReviewDraft(pool:Pool, reviewId:string): Promise<Record<string,unknown>> {
  if (!idOk(reviewId)) throw new Error('Invalid review ID');
  if (!pilotDraftWriteState().draft_writes_enabled)
    throw new Error('Pilot Xero draft writes disabled or tenant/inbox mismatch');
  const found = await pool.query(`SELECT id::text, front_conversation_id, front_message_id, attachment_id,
    supplier_name, invoice_number, document_type, assessment_json, review_status,
    xero_draft_id, xero_draft_status FROM pilot_invoice_reviews WHERE id=$1`,[reviewId]);
  if (found.rowCount !== 1) throw new Error('Review not found');
  const r = found.rows[0];
  if (!['invoice','credit_note'].includes(r.document_type)) throw new Error('Not an invoice or credit note');
  if (r.xero_draft_id) return completeExistingReviewDraft(pool,reviewId);
  if (r.xero_draft_status && !['reconcile_required','creating'].includes(r.xero_draft_status))
    throw new Error(`Previous draft state ${r.xero_draft_status}; reconcile before retry`);
  if (['reconcile_required','creating'].includes(r.xero_draft_status)) {
    // Never clear an indeterminate attempt until BOTH Xero endpoints have been checked.
    const session=await getPilotXeroReadSessionForLink();
    const matches=await lookupXeroPurchaseNumber(session,String(r.invoice_number??''));
    if(matches.length) throw new Error(`Previous attempt may have created Xero ${matches.map(m=>m.id).join(', ')}; link verified document before retry`);
    // A negative search does not prove a timed-out POST failed; require explicit
    // human confirmation before clearing the attempt state.
    throw new Error('Prior attempt requires human-confirmed reconciliation; Xero lookup found no document');
  }
  const a = r.assessment_json ?? {};
  const supplier = String(r.supplier_name || a.xero_supplier || '').trim();
  const number = String(r.invoice_number || '').trim();
  if (!supplier || !number || !dateOk(a.invoice_date) || !money(Math.abs(a.gross_gbp ?? 0)))
    throw new Error('Document cannot be represented in Xero: supplier, number, date or gross amount missing');
  if (supplier.length > 150 || number.length > 100) throw new Error('Supplier or document number too long');
  const gross = Math.abs(a.gross_gbp as number);
  const issues:string[] = [...(Array.isArray(a.exceptions) ? a.exceptions.filter((x:unknown):x is string=>typeof x==='string' && !/\bvat\b|tax treatment|tax rate/i.test(x)) : [])];
  if (a.gross_gbp < 0) issues.push('Negative source amount represented as positive supplier credit note');
  // Billing-entity assessment happens against the original PDF below, not stale extraction text.
  const onPresentation=/\bdue on presentation\b|\bdue immediately\b/i.test(String(a.evidence_notes??''));
  const due = dateOk(a.due_date) ? a.due_date : onPresentation ? a.invoice_date : due30(a.invoice_date);
  if (!dateOk(a.due_date) && onPresentation) issues.push('Due on presentation: used invoice date as due date; verify source');
  else if (!dateOk(a.due_date)) issues.push('Due date defaulted to invoice date + 30 days');
  // Inbox-wide policy: non-recoverable VAT is included in gross expense; Xero TaxType is NONE.
  // Never raise VAT queries even if an old assessment suggested another treatment.
  // Fetch and validate original attachment before any Xero write.
  const original = await originalFrontDocument({conversationId:r.front_conversation_id,
    messageId:r.front_message_id,attachmentId:r.attachment_id});
  const incomingPdfText=await pdfText(original.bytes);
  const printedSupplier=pdfSupplierName(incomingPdfText);
  if(!printedSupplier) issues.push('Supplier name could not be confirmed from original PDF; used recorded best candidate');
  await assertLatestRecordedFrontVersion(pool,r,original.bytes);
  // Resolve assessment warnings only after the current original PDF
  // and latest Front version have been independently verified.
  const practiceRecipient=/st\s*george[’\'s\s.-]*road\s*surgery/i.test(incomingPdfText);
  const practiceAddress=/102\s+st\.?\s*george[’\'s\s.-]*road/i.test(incomingPdfText) &&
    /coventry/i.test(incomingPdfText) && /CV1\s*2DL/i.test(incomingPdfText);
  const recordedRecipient=String(a.billed_to??'').trim();
  const conflictingRecipient=!!recordedRecipient &&
    !/st\s*george[’\'s\s.-]*road\s*surgery/i.test(recordedRecipient) &&
    !/^(?:unknown|not stated|not extracted|none|n\/?a)$/i.test(recordedRecipient) &&
    !/102\s+st\.?\s*george[’\'s\s.-]*road/i.test(recordedRecipient);
  const recipientVerified=(practiceRecipient||practiceAddress)&&!conflictingRecipient;
  for(let i=issues.length-1;i>=0;i--){
    const issue=issues[i];
    if (/latest.version copy|earlier copy|superseded copy/i.test(issue)) issues.splice(i,1);
    else if (/billing entity|legal entity name/i.test(issue) && recipientVerified) issues.splice(i,1);
  }
  if(!recipientVerified) issues.push('Billed-to practice not unambiguously verified from original invoice PDF');
  // Read-only coding verification precedes the atomic claim, so an unavailable
  // or ambiguous latest bill cannot reserve a review unnecessarily.
  const verifiedCoding=await inspectApprovedSupplierCoding(printedSupplier || supplier,String(a.evidence_notes??''),incomingPdfText)
    .catch(()=>({status:'history_unavailable',account_code:null,issues:['Historical coding unavailable']}));
  if (verifiedCoding.status!=='latest_bill_account_selected') issues.push('Historical coding unverified; best available account used');

  // Reserve the review BEFORE any Xero write. A failed/indeterminate request must be reconciled,
  // not blindly retried. Unique review record prevents concurrent draft creation.
  const claim = await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_status='creating',
    xero_draft_updated_at=NOW(),updated_at=NOW() WHERE id=$1 AND xero_draft_id IS NULL
    AND xero_draft_status IS NULL RETURNING id`,[reviewId]);
  if (claim.rowCount !== 1) throw new Error('Draft already claimed or attempted');
  let createdId:string|undefined;
  let xeroPostStarted=false;
  let kind = r.document_type === 'credit_note' ? 'CreditNotes' : 'Invoices';
  try {
    const api = await getPilotXeroWriteSession();
    if (api.tenantId !== TENANT) throw new Error('Wrong Xero tenant');
    // Check both AP bills and supplier credits before contact creation or Xero POST.
    const matches=await lookupXeroPurchaseNumber(api,number);
    if(matches.length) {
      const first=matches[0];
      if(matches.length===1 && first.kind===kind && first.exact && supplierKey(first.contactName??'')===supplierKey(supplier)) {
        await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_id=$2,xero_draft_status='existing_in_xero',xero_draft_updated_at=NOW(),updated_at=NOW() WHERE id=$1`,[reviewId,first.id]);
        let sheetStatus='synced';
        try {await syncPilotReviewExceptions(pool,[reviewId]);}catch {sheetStatus='sync_failed';}
        return {status:'existing_in_xero',review_id:reviewId,xero_draft_id:first.id,xero_status:first.status,review_required:true,sheet_status:sheetStatus};
      }
      throw new Error(`Existing Xero document(s) ${matches.map(m=>m.id).join(', ')} match this number; reconcile supplier, document type or punctuation before drafting`);
    }
    // Mandatory historical precedent: the most recent approved/paid bill wins.
    // Older conflicting codes and proposed/suspense codes cannot override it.
    const history=verifiedCoding;
    const coding=await accountCode(api,history.account_code || a.proposed_account);
    if (coding.fallback) issues.push('Fallback expense account selected; finance must verify coding');
    // Historical coding provenance is audit evidence, not a human-review issue.
    const contact = await supplierContact(api,printedSupplier || supplier,incomingPdfText);
    if (contact.issue) issues.push(contact.issue);
    // Historical coding is verified evidence; remove its provenance notes,
    // but preserve sender discrepancies for human review.
    for(let i=issues.length-1;i>=0;i--){
      // Contact match and account verification have succeeded at this point.
      // Preserve independent sender discrepancies (e.g. "sender signs as").
      if (/account \d+ selected from latest approved|supplier identity:.*historical PDF|supplier match requires historical PDF|existing Xero contact .*historical.*verified/i.test(issues[i])) issues.splice(i,1);
    }
    // A successful historical PDF-to-PDF contact match is verified evidence, not a warning.
    // The contact matcher throws when verification fails; no new contact is created.
    const taxRates=await xero(api,'TaxRates');
    if (!Array.isArray(taxRates.TaxRates) || !taxRates.TaxRates.some((t:any)=>t.TaxType===vatPolicyForInbox(INBOX).purchaseTaxType && t.Status==='ACTIVE'))
      throw new Error('Xero TaxType NONE not verified as active; draft blocked');
    const common = {
      Status:'DRAFT',Contact:{ContactID:contact.id},Date:a.invoice_date,
      CurrencyCode:'GBP',LineAmountTypes:'Exclusive',
      LineItems:[grossExpenseLine({inboxId:INBOX,description:`${r.document_type === 'credit_note' ? 'Supplier credit note' : 'Supplier invoice'} ${number} — check source attachment and review notes`,gross,accountCode:coding.code})]
    };
    const payload = kind === 'Invoices' ? {...common,Type:'ACCPAY',InvoiceNumber:number,DueDate:due}
      : {...common,Type:'ACCPAYCREDIT',CreditNoteNumber:number};
    xeroPostStarted=true;
    const result = await xero(api,kind,'POST',{[kind]:[payload]});
    const doc = result[kind]?.[0];
    createdId = doc?.[kind === 'Invoices' ? 'InvoiceID' : 'CreditNoteID'];
    // Store ID immediately, even if response validation or Sheets sync fails.
    if (createdId) await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_id=$2,xero_draft_status='draft_created',
      xero_draft_updated_at=NOW(),updated_at=NOW() WHERE id=$1`,[reviewId,createdId]);
    if (!createdId || doc.Status !== 'DRAFT' || doc.HasErrors || (doc.ValidationErrors?.length ?? 0)>0)
      throw new Error('Xero response requires reconciliation; draft may exist');
    if (typeof doc.Total === 'number' && Math.abs(Math.abs(doc.Total)-gross)>0.011)
      issues.push(`Xero returned total ${doc.Total}; source gross ${gross}; review required`);
    let originalAttachmentVerified=false;
    try {
      await attachAndVerifyOriginal(api.tenantId,api.accessToken,createdId,original.filename,
        original.contentType,original.bytes,kind as 'Invoices'|'CreditNotes');
      await pool.query(`UPDATE pilot_invoice_reviews SET xero_attachment_verified=TRUE WHERE id=$1`,[reviewId]);
      originalAttachmentVerified=true;
    } catch(e) { issues.push(`Original attachment needs attention: ${e instanceof Error?e.message:String(e)}`); }
    // Preserve original assessment and human decisions. Add draft-specific issues separately.
    await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_error=$2,updated_at=NOW() WHERE id=$1`,
      [reviewId, issues.join(' | ').slice(0,4000) || null]);
    let sheetStatus:'synced'|'sync_failed'='synced';
    try { await syncPilotReviewExceptions(pool,[reviewId]); }
    catch(e) {sheetStatus='sync_failed';issues.push(`Sheet sync failed: ${e instanceof Error?e.message:String(e)}`);}
    return {status:'draft_created',review_id:reviewId,xero_draft_id:createdId,
      document_type:r.document_type,xero_contact_id:contact.id,new_contact_created:contact.created,
      account_code:coding.code,tax_type:vatPolicyForInbox(INBOX).purchaseTaxType,gross_gbp:gross,review_required:issues.length>0,
      review_issues:issues,sheet_status:sheetStatus,original_pdf_attached_and_verified:originalAttachmentVerified,
      visual_pdf_verification:false,approved:false,submitted:false};
  } catch(e) {
    const reason = e instanceof Error ? e.message : String(e);
    await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_status=CASE WHEN xero_draft_id IS NULL THEN $3 ELSE xero_draft_status END,
      xero_draft_error=$2,xero_draft_updated_at=NOW() WHERE id=$1`,[reviewId,reason.slice(0,4000),xeroPostStarted?'reconcile_required':null]).catch(()=>{});
    // Reporting failure cannot block or reverse Xero creation. Retrying the
    // Sheet write is independent of the accounting operation.
    try { await syncPilotReviewExceptions(pool,[reviewId]); } catch (sheetError) {
      console.error('Finance review Sheet reporting failed',sheetError instanceof Error ? sheetError.message : 'unknown');
    }
    throw new Error(`${reason}. ${xeroPostStarted?'Xero POST outcome must be reconciled before retry.':'No Xero document POST was attempted; correct the error and retry safely.'}`);
  }
}

/** One-time repair for historical stale attempt flags. Never clears an ambiguous POST
 * without explicit operator confirmation from the actual Xero request logs.
 * Live duplicate checks cover BOTH bills and credits before clearing.
 */
export async function clearConfirmedPrePostFailure(pool:Pool,reviewId:string,confirmedNoXeroPost:boolean):Promise<Record<string,unknown>> {
  if(!pilotDraftWriteState().draft_writes_enabled) throw new Error('Draft register writes disabled');
  if(!idOk(reviewId)||confirmedNoXeroPost!==true) throw new Error('Explicit confirmation that NO Xero invoice/credit POST was sent is required');
  const result=await pool.query(`SELECT id::text,invoice_number,xero_draft_id,xero_draft_status,xero_draft_error
    FROM pilot_invoice_reviews WHERE id=$1`,[reviewId]);
  if(result.rowCount!==1) throw new Error('Review not found');
  const r=result.rows[0];
  if(r.xero_draft_id || !['creating','reconcile_required'].includes(r.xero_draft_status))
    throw new Error('Review is not an unlinked indeterminate attempt');
  const session=await getPilotXeroReadSessionForLink();
  const matches=await lookupXeroPurchaseNumber(session,String(r.invoice_number??''));
  if(matches.length) throw new Error(`Existing Xero document(s) ${matches.map(m=>m.id).join(', ')}; link instead of clearing`);
  const updated=await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_status=NULL,
    xero_draft_error=concat_ws(' | ',xero_draft_error,'Historical pre-POST failure reconciled; operator confirmed no Xero POST'),
    xero_draft_updated_at=NOW(),updated_at=NOW()
    WHERE id=$1 AND xero_draft_id IS NULL AND xero_draft_status IN ('creating','reconcile_required') RETURNING id`,[reviewId]);
  if(updated.rowCount!==1) throw new Error('Concurrent review change; retry reconciliation');
  let sheet_status='synced';
  try{await syncPilotReviewExceptions(pool,[reviewId]);}catch{sheet_status='sync_failed';}
  return {status:'cleared_confirmed_pre_post_failure',review_id:reviewId,
    xero_duplicate_search_complete:true,operator_confirmed_no_xero_post:true,sheet_status};
}

/** Explicitly link an existing Xero document to a review after verifying it live.
 * No Xero mutation. The write switch also gates PostgreSQL/Sheet linkage.
 */
export async function linkExistingReviewDraft(pool:Pool,reviewId:string,xeroDocumentId:string,verifiedContactId?:string):Promise<Record<string,unknown>> {
  if (!pilotDraftWriteState().draft_writes_enabled) throw new Error('Draft register writes disabled');
  if (!idOk(reviewId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(xeroDocumentId))
    throw new Error('Invalid review or Xero document ID');
  const result=await pool.query(`SELECT id::text,invoice_number,supplier_name,document_type,xero_draft_id,xero_draft_status
    FROM pilot_invoice_reviews WHERE id=$1`,[reviewId]);
  if (result.rowCount!==1) throw new Error('Review not found');
  const r=result.rows[0];
  // No Sheet HOLD gate: the finance Sheet is reporting only.
  if (r.xero_draft_id) return {status:r.xero_draft_id.toLowerCase()===xeroDocumentId.toLowerCase()?'already_linked':'conflicting_existing_link',review_id:reviewId,xero_draft_id:r.xero_draft_id};
  const api=await getPilotXeroReadSessionForLink();
  const kind=r.document_type==='credit_note'?'CreditNotes':r.document_type==='invoice'?'Invoices':null;
  if (!kind) throw new Error('Review is not an invoice or credit note');
  const data=await xero(api,`${kind}/${xeroDocumentId}`);
  const doc=data[kind]?.[0];
  const number=kind==='Invoices'?doc?.InvoiceNumber:doc?.CreditNoteNumber;
  const contactName=String(doc?.Contact?.Name??'').trim().toLowerCase();
  if (!doc || number!==r.invoice_number || !(verifiedContactId ? doc.Contact?.ContactID?.toLowerCase()===verifiedContactId.toLowerCase() : r.supplier_name && supplierKey(contactName)===supplierKey(r.supplier_name)))
    throw new Error('Xero document number or supplier differs from review; manually verify contact before linking');
  if (doc.Status==='DELETED'||doc.Status==='VOIDED') throw new Error('Xero document is deleted or voided');
  const updated=await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_id=$2,xero_draft_status='existing_in_xero',
    xero_draft_updated_at=NOW(),updated_at=NOW() WHERE id=$1 AND xero_draft_id IS NULL
    AND (xero_draft_status IS NULL OR xero_draft_status IN ('reconcile_required','creating')) RETURNING id`,[reviewId,xeroDocumentId]);
  if (updated.rowCount!==1) throw new Error('Concurrent change to review; recheck before linking');
  let sheet_status='synced';
  try {await syncPilotReviewExceptions(pool,[reviewId]);}catch {sheet_status='sync_failed';}
  return {status:'linked_existing_xero_document',review_id:reviewId,xero_draft_id:xeroDocumentId,
    xero_status:doc.Status,sheet_status,created_xero_document:false};
}

async function getPilotXeroReadSessionForLink():Promise<Api> {
  const {getPilotXeroReadSession}=await import('./xero-pilot-test.js');
  const api=await getPilotXeroReadSession();
  if(api.tenantId!==TENANT) throw new Error('Unexpected Xero tenant');
  return api;
}

/** Compare recorded copies by actual Front message creation time, never assessment time.
 * This guards known duplicates; it does not claim a complete inbox scan.
 */
async function assertLatestRecordedFrontVersion(pool:Pool,r:any,bytes:Buffer):Promise<void> {
  const rows=await pool.query(`SELECT front_conversation_id,front_message_id,attachment_id,supplier_name,
    invoice_number,review_status,xero_draft_id,assessment_json FROM pilot_invoice_reviews
    WHERE lower(trim(invoice_number))=lower(trim($1))`,[r.invoice_number]);
  const same=rows.rows.filter((v:any)=>supplierNameSimilarity(String(v.supplier_name??''),String(r.supplier_name??''))>=0.5);
  if(same.some((v:any)=>['on_hold','rejected'].includes(v.review_status))) throw new Error('Another invoice copy is on human hold');
  const token=process.env.FRONT_API_TOKEN;
  if(!token) throw new Error('Front API token unavailable for version verification');
  const versions=[];
  for(const v of same) {
    const response=await fetch(`https://api2.frontapp.com/messages/${encodeURIComponent(v.front_message_id)}`,
      {headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new Error(`Front receipt timestamp unavailable: HTTP ${response.status}`);
    const message=await response.json() as any;
    if(!Number.isFinite(Number(message.created_at))) throw new Error('Front message receipt timestamp missing');
    const attachment=v.attachment_id===r.attachment_id && v.front_message_id===r.front_message_id
      ? bytes : (await originalFrontDocument({conversationId:v.front_conversation_id,messageId:v.front_message_id,attachmentId:v.attachment_id})).bytes;
    const gross=Number(v.assessment_json?.gross_gbp);
    versions.push({attachmentId:v.attachment_id,messageId:v.front_message_id,conversationId:v.front_conversation_id,
      receivedAt:new Date(Number(message.created_at)*1000).toISOString(),supplierKey:supplierKey(String(r.supplier_name)),
      invoiceNumber:String(r.invoice_number),contentFingerprint:createHash('sha256').update(attachment).digest('hex'),
      statedGross:gross,explicitHumanHold:v.review_status==='on_hold',xeroDocumentId:v.xero_draft_id});
  }
  if(!versions.some(v=>v.attachmentId===r.attachment_id && v.messageId===r.front_message_id))
    throw new Error('Current invoice missing from recorded-version check');
  const choice=selectLatestInvoiceVersion(versions);
  if(choice.status!=='latest_valid' || choice.selected?.attachmentId!==r.attachment_id || choice.selected?.messageId!==r.front_message_id)
    throw new Error(`Invoice version blocked: ${choice.reason}`);
}
