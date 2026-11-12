import { createHash } from 'node:crypto';
import { printedSupplierName, sameSupplierIgnoringLegalSuffix } from './supplier-evidence.js';
import { liveExtractionIssues } from './live-review-issues.js';
import { extractInvoiceFields } from './model-extraction.js';
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
import { reconcileInvoiceReviewIssues, billingRecipientCheck, applyPaymentIssuePolicy } from './ap-invoice-review-rules.js';
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
  const review_issues:string[]=applyPaymentIssuePolicy(data.exceptions ?? []);
  if (!['invoice','credit_note'].includes(data.document_type)) essential_missing.push('Not an invoice or credit note');
  if (!data.supplier_name?.trim()) essential_missing.push('Supplier name not available for Xero contact');
  if (!data.invoice_number?.trim()) essential_missing.push('Document number not available');
  if (!dateOk(data.invoice_date)) essential_missing.push('Valid document date not available');
  if (!money(Math.abs(data.gross_gbp ?? 0))) essential_missing.push('Valid non-zero gross amount not available');
  if (!data.proposed_account?.trim()) review_issues.push('Nominal code needs review; valid Xero fallback account required');
  // A standard due-date default is informational, not an approval exception.
  if (data.billed_to && !/st\\s*george[’'s\\s.-]*road\\s*surgery/i.test(data.billed_to)) review_issues.push('Billing entity requires review');
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
/** A 40% contact-name match is only a candidate. The incoming supplier name
 * must appear as the supplier name on an attached invoice PDF belonging to one
 * of that contact's THREE most recent purchase bills (not three attached bills).
 * No address, registration or VAT comparisons, and no hard-coded aliases.
 */
function comparableSupplierName(value:string):string {
  return value.toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim();
}
/** A single supplier identity, taken only from the incoming or historical PDF.
 * Uses the same evidence as get_invoice_attachment's extracted_candidates.supplier
 * (supplier-evidence.ts), searching the whole document, so both paths agree.
 * Never use the review's supplier_name as the string compared with historical PDF text.
 * Names in a bill-to/customer block and the practice's own name are never supplier evidence.
 * Conflicting labelled-issuer or payee identities fail closed rather than guess.
 */
const PRACTICE_NAME=/\bst\.?\s*george[’'s\s.-]*road\s*surgery\b/i;
function pdfSupplierName(text:string):string|null {
  return printedSupplierName(text,{exclude:PRACTICE_NAME});
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
/** Compare the latest approved/paid supplier bill's original PDF, not the contact name. */
async function latestHistoricalBillingPdf(api:Api,contactId:string):Promise<string|null> {
  const filter=encodeURIComponent(`Type=="ACCPAY"&&Contact.ContactID==Guid("${contactId}")`);
  const response=await xero(api,`Invoices?where=${filter}&order=${encodeURIComponent('Date DESC')}&page=1`);
  const bills=(Array.isArray(response.Invoices)?response.Invoices:[])
    .filter((b:any)=>['AUTHORISED','PAID'].includes(String(b.Status)) && b.InvoiceID);
  const latest=bills[0];
  if(!latest) return null;
  const listing=await xero(api,`Invoices/${encodeURIComponent(latest.InvoiceID)}/Attachments`);
  const attachment=(Array.isArray(listing.Attachments)?listing.Attachments:[])
    .find((a:any)=>/\\.pdf$/i.test(String(a.FileName??'')));
  if(!attachment) return null;
  const path=`Invoices/${encodeURIComponent(latest.InvoiceID)}/Attachments/${encodeURIComponent(attachment.FileName)}`;
  const responsePdf=await xeroFetch(API+path,{headers:{Authorization:`Bearer ${api.accessToken}`,'xero-tenant-id':api.tenantId,Accept:'application/pdf'},signal:AbortSignal.timeout(25000)});
  if(!responsePdf.ok) return null;
  const bytes=Buffer.from(await responsePdf.arrayBuffer());
  if(!bytes.length||bytes.length>15*1024*1024) return null;
  return pdfText(bytes);
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
    .filter(x=>x.score>=0.40).sort((a,b)=>b.score-a.score);
  if(!candidates.length) return null;
  const confirmed:ContactMatch[]=[];
  for(const {c,score} of candidates) {
    const evidence=await historicalInvoiceNameMatches(api,String(c.ContactID),incomingPdfText!);
    if(evidence.matched) confirmed.push({id:String(c.ContactID),name:String(c.Name),alias:!sameSupplierIgnoringLegalSuffix(printedName,String(c.Name)),confidence:`historical_pdf_supplier_name_match; bill=${evidence.bill_id}; filename=${evidence.filename}; candidate_similarity=${score.toFixed(2)}`});
  }
  if(confirmed.length>1) throw new Error(`Multiple Xero contacts have matching historical supplier invoice names: ${confirmed.map(x=>x.name).join(', ')}`);
  if(!confirmed.length) throw new Error(`No supplier-name match found in the three most recent Xero bills for any 40%+ candidate; supplier review required`);
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
/** Best-candidate existing contact used when PDF-to-PDF verification fails.
 * Shared by draft creation and the read-only preview so both report the same contact. */
async function bestCandidateContact(api: Api, supplier: string): Promise<{id:string; name:string; score:number}|null> {
  const response = await xero(api, 'Contacts');
  const contacts = Array.isArray(response.Contacts) ? response.Contacts : [];
  const ranked = contacts.filter((c:any)=>c.ContactID && c.Name)
    .map((c:any)=>({contact:c, score:supplierNameSimilarity(supplier,String(c.Name))}))
    .sort((a:any,b:any)=>b.score-a.score);
  if (!(ranked[0]?.score > 0.40)) return null;
  return {id:String(ranked[0].contact.ContactID),name:String(ranked[0].contact.Name),score:ranked[0].score};
}

/** Approved/paid Xero purchase bills are the supplier's authorised coding precedent.
 * Read-only, bounded and contact-ID scoped. Ambiguous history is reported, not guessed.
 */
type SupplierCoding = {status:'latest_bill_account_selected'|'earlier_bill_account_selected'|'contact_default_account'|'no_supplier_coding';
  account_code:string|null; contact_id:string; source_bill_id?:string; selection_method:string; issues:string[]; tax_type:string};
const EXCLUDED_ACCOUNT_TYPES=['BANK','REVENUE','EQUITY','LIABILITY','CURRENTLIAB','FIXED','CURRENT'];
async function activeExpenseCodes(api:Api):Promise<Set<string>> {
  const data=await xero(api,'Accounts');
  if (!Array.isArray(data.Accounts)) throw new Error('Xero accounts validation unavailable');
  return new Set(data.Accounts.filter((a:any)=>a.Status==='ACTIVE' && a.Code &&
    !EXCLUDED_ACCOUNT_TYPES.includes(String(a.Type).toUpperCase())).map((a:any)=>String(a.Code)));
}
/** Coding follows the selected supplier contact, never a generic fallback:
 *  1. latest approved/paid bill for that contact with one active expense code
 *     (an earlier approved bill if the latest has mixed codes; flagged)
 *  2. else that contact's own default purchase account in Xero (flagged)
 *  3. else no coding: the invoice is not drafted and goes to Human Review. */
async function codingForContact(api:Api, contactId:string):Promise<SupplierCoding> {
  const taxType=vatPolicyForInbox(INBOX).purchaseTaxType;
  const active=await activeExpenseCodes(api);
  const filter=encodeURIComponent(`Type=="ACCPAY"&&Contact.ContactID==Guid("${contactId}")`);
  const response=await xero(api,`Invoices?where=${filter}&order=${encodeURIComponent('Date DESC')}&page=1`);
  if(!Array.isArray(response.Invoices)) throw new Error('Supplier bill history unavailable');
  const approved=response.Invoices.filter((b:any)=>b.Type==='ACCPAY' && b.InvoiceID &&
    String(b.Contact?.ContactID??'').toLowerCase()===contactId.toLowerCase() && ['AUTHORISED','PAID'].includes(b.Status)).slice(0,5);
  for (let i=0;i<approved.length;i++) {
    // Fetch detail: Xero list responses may omit LineItems.
    const detail=await xero(api,`Invoices/${encodeURIComponent(approved[i].InvoiceID)}`);
    const bill=detail.Invoices?.[0];
    if(!bill || bill.InvoiceID!==approved[i].InvoiceID) continue;
    const codes=[...new Set((bill.LineItems??[]).map((l:any)=>String(l.AccountCode??'').trim()).filter(Boolean))] as string[];
    if (codes.length===1 && active.has(codes[0])) return {
      status:i===0?'latest_bill_account_selected':'earlier_bill_account_selected',account_code:codes[0],contact_id:contactId,
      source_bill_id:bill.InvoiceID,selection_method:i===0?'most_recent_approved_or_paid_bill':'earlier_approved_or_paid_bill',
      issues:i===0?[]:[`Latest approved supplier bill has mixed account codes; account ${codes[0]} taken from an earlier approved bill - finance to verify`],
      tax_type:taxType};
  }
  const contact=(await xero(api,`Contacts/${encodeURIComponent(contactId)}`)).Contacts?.[0];
  const contactDefault=String(contact?.PurchasesDefaultAccountCode??'').trim();
  if (contactDefault && active.has(contactDefault)) return {status:'contact_default_account',account_code:contactDefault,
    contact_id:contactId,selection_method:'xero_contact_default_purchase_account',
    issues:[`No usable approved bill history for this supplier; Xero contact default purchase account ${contactDefault} used - finance to verify`],tax_type:taxType};
  return {status:'no_supplier_coding',account_code:null,contact_id:contactId,selection_method:'none',
    issues:['No approved bill history and no default purchase account for this supplier in Xero; invoice not drafted'],tax_type:taxType};
}
/** The supplier contact a draft would use: historically verified, else the best existing
 * contact above 40% similarity (flagged). Never creates a contact. Read-only. */
async function resolveDraftSupplier(api:Api, supplier:string, pdfText:string):Promise<{
  id:string;name:string;verified:boolean;issue?:string;similarity?:number;confidence?:string;verificationError?:string}|null> {
  let verified:ContactMatch|null=null; let verificationError='';
  try { verified=await findSupplierContact(api,supplier,pdfText); }
  catch(error){ verificationError=error instanceof Error?error.message:String(error); }
  if (verified) return {id:verified.id,name:verified.name,verified:true,confidence:verified.confidence,
    ...(verified.alias?{issue:`Supplier candidate ${verified.name}; verify identity`}:{})};
  const best=await bestCandidateContact(api,supplier);
  if (!best) return null;
  return {id:best.id,name:best.name,verified:false,similarity:best.score,verificationError,
    issue:`Supplier uncertain: existing Xero contact ${best.name} selected at similarity ${best.score.toFixed(2)}; finance must verify`};
}
/** Read-only coding for a supplier name (intake tools): resolve the contact, then code
 * from that contact's own history. */
export async function inspectApprovedSupplierCoding(supplierName:string, description:string, incomingPdfText?:string):Promise<Record<string,unknown>> {
  const api=await getPilotXeroReadSessionForLink();
  const contact=incomingPdfText
    ? await resolveDraftSupplier(api,supplierName,incomingPdfText)
    : await bestCandidateContact(api,supplierName).then(b=>b?{id:b.id,name:b.name,verified:false,similarity:b.score}:null);
  if(!contact) return {status:'contact_unresolved',account_code:null,issues:['No existing Xero contact exceeds 40% supplier-name similarity']};
  const coding=await codingForContact(api,contact.id);
  return {...coding,contact_name:contact.name,contact_verified:contact.verified,matching_description:description.slice(0,200)};
}
/** Validation only: the supplier's own code must be an active expense account. No fallback. */
async function accountCode(api: Api, code: unknown): Promise<{code:string}> {
  const active=await activeExpenseCodes(api);
  if (!code || !active.has(String(code))) throw new Error(`Supplier account code ${String(code??'(none)')} is not an active expense account in Xero`);
  return {code:String(code)};
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
  // Stored assessment notes and proposed account are history only: issues are rebuilt
  // below from the original PDF and the selected supplier's own Xero coding.
  const base = previewFields({document_type:r.document_type,supplier_name:r.supplier_name || a.xero_supplier,
    invoice_number:r.invoice_number,invoice_date:a.invoice_date,gross_gbp:a.gross_gbp,
    due_date:a.due_date,proposed_account:'supplier history',exceptions:[]},r.xero_draft_id,r.xero_draft_status);
  // A review preview must use the SAME PDF evidence and latest-bill coding as
  // createReviewDraft. Stored names/proposed accounts are not verification.
  const original=await originalFrontDocument({conversationId:String(r.front_conversation_id),
    messageId:String(r.front_message_id),attachmentId:String(r.attachment_id)});
  const pdf=await pdfText(original.bytes);
  const api=await getPilotXeroReadSessionForLink();
  // Supplier verification failure is a review issue, never a preview failure. Mirror
  // createReviewDraft: verified contact, else best-candidate existing contact (>40%);
  // coding always comes from that contact's own Xero history.
  const printedSupplier=pdfSupplierName(pdf);
  const supplierForMatch=printedSupplier || String(r.supplier_name??'');
  const draftSupplier=await resolveDraftSupplier(api,supplierForMatch,pdf);
  const verified=draftSupplier?.verified?draftSupplier:null;
  const supplierVerificationError=draftSupplier?.verificationError??'';
  const coding:Record<string,unknown>&{account_code:string|null;issues:string[]}=draftSupplier
    ? await codingForContact(api,draftSupplier.id)
    : {status:'contact_unresolved',account_code:null,issues:[]};
  const merged=await extractInvoiceFields({text:pdf,pdf:new Uint8Array(original.bytes),filename:original.filename});
  const liveIssues=liveExtractionIssues(pdf,{invoice_number:r.invoice_number,gross_gbp:a.gross_gbp},merged);
  // Resolve old assessment warnings using current source evidence, not stored guesses.
  // A missing legal-entity label is not itself a conflict when the PDF names the
  // practice as recipient. A different named recipient must still be reviewed.
  const practiceRecipient=billingRecipientCheck(pdf)==='practice';
  const practiceAddress=/102\s+st\.?\s*george[’\'s\s.-]*road/i.test(pdf) &&
    /coventry/i.test(pdf) && /CV1\s*2DL/i.test(pdf);
  const historicalBilling=verified && !practiceRecipient && !practiceAddress
    ? await latestHistoricalBillingPdf(api,verified.id).catch(()=>null) : null;
  const historicalRecipientMatch=billingRecipientCheck(pdf,historicalBilling??undefined)==='historical_match';
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
  const issues=reconcileInvoiceReviewIssues([...(base.review_issues as string[]),...liveIssues], {supplierVerified:!!verified, vatPolicyVerified:true, dueDateDefaulted:!dateOk(a.due_date)}).filter(issue=>
    !(/nominal code needs review/i.test(issue) && coding.status==='latest_bill_account_selected') &&
    !(/supplier identity/i.test(issue) && !!verified) &&
    !(/billing entity|legal entity name/i.test(issue) && ((practiceRecipient||practiceAddress)&&!conflictingRecipient || historicalRecipientMatch)) &&
    !(/latest.version copy/i.test(issue) && latestVersionVerified));
  const draftBlockers:string[]=[];
  if (draftSupplier?.issue) issues.push(draftSupplier.issue+(supplierVerificationError&&!verified?` (${supplierVerificationError})`:''));
  if (!draftSupplier) draftBlockers.push('No existing Xero contact exceeds 40% supplier-name similarity; draft creation will not create a contact');
  if (draftSupplier && !coding.account_code) draftBlockers.push(coding.issues[0] ?? 'No supplier-specific account code');
  else issues.push(...coding.issues);
  if (!(practiceRecipient||practiceAddress||historicalRecipientMatch) || (conflictingRecipient && !historicalRecipientMatch))
    issues.push('Billed-to practice not unambiguously verified from invoice PDF and recorded recipient');
  if (!latestVersionVerified) issues.push(`Latest Front version not verified: ${latestVersionError}`);
  // Review statuses are Sheet reporting states, never pre-draft approval gates.
  const explicitHold=false;
  const essential=(base.essential_missing as string[]);
  return {...base,review_id:reviewId,preview_source:'postgres_review_pdf_verified',
    supplier_verified:!!verified,verified_xero_contact_id:verified?.id??null,
    printed_supplier_name:printedSupplier,supplier_verification_error:supplierVerificationError||null,
    extraction_source:merged.source,extraction_model:merged.model??null,
    recorded_invoice_number:r.invoice_number??null,recorded_invoice_date:a.invoice_date??null,recorded_gross_gbp:a.gross_gbp??null,
    draft_contact:!draftSupplier?null:draftSupplier.verified?{id:draftSupplier.id,name:draftSupplier.name,basis:'historical_pdf_verified',confidence:draftSupplier.confidence}
      :{id:draftSupplier.id,name:draftSupplier.name,basis:'best_candidate_similarity',similarity:Number((draftSupplier.similarity??0).toFixed(2)),exceeds_40_percent:(draftSupplier.similarity??0)>0.40},
    draft_account_code:coding.account_code??null,draft_account_source:coding.status,
    draft_blockers:draftBlockers,draft_would_be_created:draftBlockers.length===0,
    supplier_verification_blocks_draft:false,
    latest_front_version_verified:latestVersionVerified,billed_to_practice_verified:(practiceRecipient||practiceAddress)&&!conflictingRecipient,
    billed_to_historical_supplier_verified:historicalRecipientMatch,
    historical_coding:coding,account_code_selected:coding.status==='latest_bill_account_selected',
    selected_account_code:coding.account_code??null,tax_type:vatPolicyForInbox(INBOX).purchaseTaxType,
    gross_expense_gbp:typeof a.gross_gbp==='number'?Math.abs(a.gross_gbp):null,
    review_issues:issues,requires_human_review:issues.length>0||essential.length>0,
    note:'Read-only preview reports accounting uncertainties for junior finance review; these do not prevent Xero DRAFT creation. Draft creation independently enforces duplicate and indeterminate-write safeguards.'};
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
  // Human review status is reporting only; attachment recovery must not be blocked.
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
  // Review status is not a draft-creation approval gate.
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
  // Stored assessment notes are history only; issues come from current evidence below.
  const issues:string[] = [];
  if (a.gross_gbp < 0) issues.push('Negative source amount represented as positive supplier credit note');
  // Billing-entity assessment happens against the original PDF below, not stale extraction text.
  const onPresentation=/\bdue on presentation\b|\bdue immediately\b/i.test(String(a.evidence_notes??''));
  const due = dateOk(a.due_date) ? a.due_date : onPresentation ? a.invoice_date : due30(a.invoice_date);
  if (!dateOk(a.due_date) && onPresentation) issues.push('Due on presentation: used invoice date as due date; verify source');
  // Default due date is recorded in the draft but does not require human approval.
  // Inbox-wide policy: non-recoverable VAT is included in gross expense; Xero TaxType is NONE.
  // Never raise VAT queries even if an old assessment suggested another treatment.
  // Fetch and validate original attachment before any Xero write.
  const original = await originalFrontDocument({conversationId:r.front_conversation_id,
    messageId:r.front_message_id,attachmentId:r.attachment_id});
  const incomingPdfText=await pdfText(original.bytes);
  const printedSupplier=pdfSupplierName(incomingPdfText);
  const merged=await extractInvoiceFields({text:incomingPdfText,pdf:new Uint8Array(original.bytes),filename:original.filename});
  issues.push(...liveExtractionIssues(incomingPdfText,{invoice_number:number,gross_gbp:a.gross_gbp},merged));
  await assertLatestRecordedFrontVersion(pool,r,original.bytes);
  // Resolve assessment warnings only after the current original PDF
  // and latest Front version have been independently verified.
  const practiceRecipient=billingRecipientCheck(incomingPdfText)==='practice';
  const practiceAddress=/102\s+st\.?\s*george[’\'s\s.-]*road/i.test(incomingPdfText) &&
    /coventry/i.test(incomingPdfText) && /CV1\s*2DL/i.test(incomingPdfText);
  const recordedRecipient=String(a.billed_to??'').trim();
  const conflictingRecipient=!!recordedRecipient &&
    !/st\s*george[’\'s\s.-]*road\s*surgery/i.test(recordedRecipient) &&
    !/^(?:unknown|not stated|not extracted|none|n\/?a)$/i.test(recordedRecipient) &&
    !/102\s+st\.?\s*george[’\'s\s.-]*road/i.test(recordedRecipient);
  const preflightApi=await getPilotXeroReadSessionForLink();
  const historicalContact=!(practiceRecipient||practiceAddress)
    ? await findSupplierContact(preflightApi,printedSupplier||supplier,incomingPdfText).catch(()=>null) : null;
  const historicalBilling=historicalContact
    ? await latestHistoricalBillingPdf(preflightApi,historicalContact.id).catch(()=>null) : null;
  const historicalRecipientMatch=billingRecipientCheck(incomingPdfText,historicalBilling??undefined)==='historical_match';
  const recipientVerified=((practiceRecipient||practiceAddress)&&!conflictingRecipient)||historicalRecipientMatch;
  for(let i=issues.length-1;i>=0;i--){
    const issue=issues[i];
    if (/latest.version copy|earlier copy|superseded copy/i.test(issue)) issues.splice(i,1);
    else if (/billing entity|legal entity name/i.test(issue) && recipientVerified) issues.splice(i,1);
  }
  if(!recipientVerified) issues.push('Billed-to practice not unambiguously verified from original invoice PDF');
  // Supplier and coding are resolved read-only BEFORE the atomic claim, so a supplier
  // with no match or no supplier-specific coding never leaves a blocking attempt.
  const draftSupplier=await resolveDraftSupplier(preflightApi,printedSupplier||supplier,incomingPdfText);
  const supplierCoding=draftSupplier?await codingForContact(preflightApi,draftSupplier.id):null;
  if (!draftSupplier || !supplierCoding?.account_code) {
    const reason=!draftSupplier
      ? 'Not drafted: no existing Xero contact exceeds 40% supplier-name similarity; no contact created'
      : `Not drafted: ${supplierCoding!.issues[0] ?? 'no supplier-specific account code'}`;
    await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_error=$2,updated_at=NOW() WHERE id=$1`,[reviewId,[reason,...issues].join(' | ').slice(0,4000)]);
    let sheetStatus:'synced'|'sync_failed'='synced';
    try { await syncPilotReviewExceptions(pool,[reviewId]); } catch { sheetStatus='sync_failed'; }
    return {status:'not_drafted',review_id:reviewId,reason,review_issues:issues,front_outcome:'human_review',
      sheet_status:sheetStatus,draft_created:false,approved:false,submitted:false};
  }
  if (draftSupplier.issue) issues.push(draftSupplier.issue);
  issues.push(...supplierCoding.issues);

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
    const coding=await accountCode(api,supplierCoding.account_code);
    // Historical coding provenance is audit evidence, not a human-review issue.
    const contact={id:draftSupplier.id,created:false,issue:draftSupplier.issue};
    // A provisional or best-candidate contact is a finance review exception, not a draft veto.
    if (!contact.created) {
      const cleaned=reconcileInvoiceReviewIssues(issues,{supplierVerified:!contact.issue || !/without PDF-to-PDF confirmation|verify identity/i.test(contact.issue),vatPolicyVerified:true,dueDateDefaulted:!dateOk(a.due_date)});
      issues.splice(0,issues.length,...cleaned);
    }
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
  // Clearing a stale attempt is housekeeping, not a finance-review event: no Sheet row.
  return {status:'cleared_confirmed_pre_post_failure',review_id:reviewId,
    xero_duplicate_search_complete:true,operator_confirmed_no_xero_post:true,sheet_status:'not_written'};
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
  // Historical review statuses do not veto posting a readable invoice to DRAFT.
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
      statedGross:gross,explicitHumanHold:false,xeroDocumentId:v.xero_draft_id});
  }
  if(!versions.some(v=>v.attachmentId===r.attachment_id && v.messageId===r.front_message_id))
    throw new Error('Current invoice missing from recorded-version check');
  const choice=selectLatestInvoiceVersion(versions);
  if(choice.status!=='latest_valid' || choice.selected?.attachmentId!==r.attachment_id || choice.selected?.messageId!==r.front_message_id)
    throw new Error(`Invoice version blocked: ${choice.reason}`);
}
