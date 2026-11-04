/** Supervised AP draft creation. Uncertainty is recorded for review, not an approval gate.
 * All external writes require XERO_DRAFT_WRITES_ENABLED=true and the fixed pilot tenant.
 * An indeterminate Xero POST is never automatically retried: manual reconciliation first.
 */
import type { Pool } from 'pg';
import { getPilotXeroWriteSession } from './xero-pilot-test.js';
import { syncPilotReviewExceptions } from './google-sheets-review.js';
import { originalFrontDocument, attachAndVerifyOriginal } from './xero-draft-bills.js';
import { lookupXeroPurchaseNumber } from './xero-duplicate-lookup.js';

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
  const response = await fetch(API + path, { method, headers: {
    Authorization: `Bearer ${api.accessToken}`, 'xero-tenant-id': api.tenantId,
    Accept: 'application/json', ...(body ? {'Content-Type':'application/json'} : {})
  }, ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`Xero ${method} ${path.split('?')[0]} HTTP ${response.status}; reconcile Xero before retry`);
  return response.json();
}

function supplierKey(name:string):string {
  return name.toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim()
    .replace(/\b(limited|ltd)\b$/,'').trim();
}
async function findSupplierContact(api:Api,supplier:string):Promise<{id:string;name:string;alias:boolean}|null> {
  const where=encodeURIComponent(`Name=="${supplier.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`);
  const exactResponse=await xero(api,`Contacts?where=${where}`);
  const exact=(exactResponse.Contacts??[]).filter((c:any)=>c.ContactID && String(c.Name??'').trim().toLowerCase()===supplier.trim().toLowerCase());
  if(exact.length>1) throw new Error('Multiple exact Xero contacts; do not create another');
  if(exact.length===1) return {id:exact[0].ContactID,name:exact[0].Name,alias:false};
  // Bounded read-only candidate search; do not automatically merge different legal names.
  const key=supplierKey(supplier);
  const candidates:any[]=[];
  let exhausted=false;
  for(let page=1;page<=5;page++) {
    const response=await xero(api,`Contacts?page=${page}`);
    const list=response.Contacts??[];
    if(!Array.isArray(list)) throw new Error('Xero contacts response invalid');
    candidates.push(...list.filter((c:any)=>c.ContactID && supplierKey(String(c.Name??''))===key));
    if(list.length<100){exhausted=true;break;}
  }
  if(!exhausted) throw new Error('Xero contact search incomplete; do not create a duplicate contact');
  if(candidates.length>1) throw new Error('Ambiguous supplier alias; manual identity reconciliation required');
  if(candidates.length===1) return {id:candidates[0].ContactID,name:candidates[0].Name,alias:true};
  return null;
}
async function supplierContact(api: Api, supplier: string): Promise<{id:string; created:boolean; issue?:string}> {
  const match=await findSupplierContact(api,supplier);
  if(match) return {id:match.id,created:false,...(match.alias?{issue:`Xero contact name differs: ${match.name}; verify supplier identity`}:{})};
  // New contact name is explicitly marked for review; never fabricate tax or bank details.
  const created = await xero(api,'Contacts','POST',{Contacts:[{Name:supplier}]});
  const contact = created.Contacts?.[0];
  if (!contact?.ContactID || contact.HasErrors || (contact.ValidationErrors?.length ?? 0)>0)
    throw new Error('Xero contact creation uncertain; reconcile Xero before retry');
  return {id:contact.ContactID,created:true,issue:'New Xero supplier contact created; verify identity and possible aliases'};
}

/** Approved/paid Xero purchase bills are the supplier's authorised coding precedent.
 * Read-only, bounded and contact-ID scoped. Ambiguous history is reported, not guessed.
 */
export async function inspectApprovedSupplierCoding(supplierName:string, description:string):Promise<Record<string,unknown>> {
  const api=await getPilotXeroReadSessionForLink();
  const name=supplierName.trim();
  const contact=await findSupplierContact(api,name);
  if(!contact) return {status:'contact_unresolved',account_code:null,issues:['Supplier contact is not uniquely matched; historical coding not applied']};
  const contactId=contact.id;
  const lines:Array<{code:string;description:string;invoice:string;date:string}> = [];
  let complete=false;
  // Filter by contact ID at Xero; verify contact, type and approved status again locally.
  for(let page=1;page<=5;page++) {
    const filter=encodeURIComponent(`Contact.ContactID==Guid("${contactId}")`);
    const result=await xero(api,`Invoices?where=${filter}&page=${page}`);
    const bills=result.Invoices??[];
    if(!Array.isArray(bills)) throw new Error('Historical Xero invoice response invalid');
    for(const bill of bills) {
      if(bill.Contact?.ContactID?.toLowerCase()!==contactId.toLowerCase() || bill.Type!=='ACCPAY' || !['AUTHORISED','PAID'].includes(bill.Status)) continue;
      for(const line of bill.LineItems??[]) {
        if(typeof line.AccountCode==='string' && line.AccountCode.trim()) lines.push({code:line.AccountCode.trim(),description:String(line.Description??''),invoice:String(bill.InvoiceNumber??''),date:String(bill.DateString??'')});
      }
    }
    if(bills.length<100){complete=true;break;}
  }
  const accounts=await xero(api,'Accounts');
  const active=new Set((accounts.Accounts??[]).filter((a:any)=>a.Status==='ACTIVE' && typeof a.Code==='string').map((a:any)=>a.Code));
  const valid=lines.filter(x=>active.has(x.code));
  const groups=new Map<string,typeof valid>();
  for(const line of valid) groups.set(line.code,[...(groups.get(line.code)??[]),line]);
  const ranked=[...groups].map(([code,examples])=>({code,count:examples.length,distinct_bills:new Set(examples.map(x=>x.invoice)).size,examples:examples.slice(0,4).map(x=>({invoice:x.invoice,description:x.description}))})).sort((a,b)=>b.distinct_bills-a.distinct_bills||b.count-a.count);
  const dominant=[...ranked].sort((a,b)=>b.count-a.count||b.distinct_bills-a.distinct_bills)[0];
  // Approved supplier history is authorised coding precedent. Select the account
  // used on strictly more than half of ACTIVE-coded historical lines. One
  // anomalous line must not veto a clear majority; ties/no majority remain
  // unresolved rather than being decided by incidental sort order.
  // A truncated search is not sufficient evidence for automatic selection.
  const majorityCount = Math.floor(valid.length / 2) + 1;
  const hasMajority = !!dominant && dominant.count >= majorityCount;
  const selected = complete && hasMajority ? dominant.code : null;
  const minorityLines = selected ? valid.length - dominant.count : 0;
  return {status:selected?'approved_history_selected':ranked.length?'ambiguous_history':'no_approved_history',
    contact_id:contactId,account_code:selected,history_complete:complete,
    selection_method:selected?'approved_line_majority':null,
    selected_line_count:selected?dominant.count:0,
    total_valid_line_count:valid.length,
    approved_lines:lines.length,valid_lines:valid.length,account_codes:ranked,
    issues:[...(contact.alias?[`Historical coding uses Xero contact ${contact.name}; verify supplier alias`]:[]),...(!complete?['Supplier historical search exceeded five pages; no automatic coding']:[]),
      ...(ranked.length>1 && selected?[`Historical minority coding differs on ${minorityLines} of ${valid.length} active-coded lines; majority ${selected} selected for draft review`]:[]),
      ...(ranked.length>1 && !selected?['No majority account code in approved supplier history; coding needs review']:[]),
      ...(lines.length>valid.length?['Some historical account codes are inactive or unavailable']:[])],
    matching_description:description.slice(0,200),tax_type:'NONE'};
}

async function accountCode(api: Api, proposed: unknown): Promise<{code:string;issue?:string}> {
  const preferred = typeof proposed === 'string' ? proposed.match(/^\s*([A-Za-z0-9_-]{1,20})(?:\s|$)/)?.[1] : undefined;
  const fallback = process.env.XERO_REVIEW_FALLBACK_ACCOUNT_CODE?.trim();
  const data = await xero(api,'Accounts');
  const accounts = (data.Accounts ?? []).filter((a:any)=>a.Status === 'ACTIVE' && typeof a.Code === 'string');
  if (preferred && accounts.some((a:any)=>a.Code === preferred)) return {code:preferred};
  if (fallback && accounts.some((a:any)=>a.Code === fallback)) return {code:fallback,issue:`Coding uncertain; used configured review fallback account ${fallback}`};
  const suspense = accounts.filter((a:any)=>/^(suspense|unallocated|uncategorised|uncategorized)( costs| expenses)?$/i.test(a.Name ?? ''));
  if (suspense.length === 1) return {code:suspense[0].Code,issue:`Coding uncertain; used Xero suspense account ${suspense[0].Code}`};
  throw new Error('No valid proposed or review fallback Xero account; configure XERO_REVIEW_FALLBACK_ACCOUNT_CODE');
}

/** Shared read-only preflight for intake preview and create. Fail closed on ambiguous matches. */
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
    prior_draft_attempt:review?.xero_draft_status??null};
}

export async function previewReviewDraft(pool:Pool, reviewId:string): Promise<Record<string,unknown>> {
  if (!idOk(reviewId)) throw new Error('Invalid review ID');
  const data = await pool.query(`SELECT document_type, supplier_name, invoice_number, assessment_json,
    xero_draft_id, xero_draft_status FROM pilot_invoice_reviews WHERE id=$1`,[reviewId]);
  if (data.rowCount !== 1) throw new Error('Review not found');
  const r = data.rows[0]; const a = r.assessment_json ?? {};
  return {review_id:reviewId,preview_source:'postgres_review',
    ...previewFields({document_type:r.document_type,supplier_name:r.supplier_name || a.xero_supplier,
      invoice_number:r.invoice_number,invoice_date:a.invoice_date,gross_gbp:a.gross_gbp,
      due_date:a.due_date,proposed_account:a.proposed_account,billed_to:a.billed_to,
      exceptions:Array.isArray(a.exceptions)?a.exceptions:[]},r.xero_draft_id,r.xero_draft_status)};
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
  if (r.xero_draft_id) return {status:'already_drafted',review_id:reviewId,xero_draft_id:r.xero_draft_id};
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
  const issues:string[] = [...(Array.isArray(a.exceptions) ? a.exceptions.filter((x:unknown):x is string=>typeof x==='string') : [])];
  if (a.gross_gbp < 0) issues.push('Negative source amount represented as positive supplier credit note');
  if (a.billed_to !== "St George's Road Surgery") issues.push(`Billing entity requires review: ${String(a.billed_to ?? 'not extracted')}`);
  const onPresentation=/\bdue on presentation\b|\bdue immediately\b/i.test(String(a.evidence_notes??''));
  const due = dateOk(a.due_date) ? a.due_date : onPresentation ? a.invoice_date : due30(a.invoice_date);
  if (!dateOk(a.due_date) && onPresentation) issues.push('Due on presentation: used invoice date as due date; verify source');
  else if (!dateOk(a.due_date)) issues.push('Due date defaulted to invoice date + 30 days');
  if (a.proposed_vat_treatment && !/NONE/i.test(a.proposed_vat_treatment)) issues.push('Practice uses gross expense and tax NONE; review source VAT');
  // Fetch and validate original attachment before any Xero write.
  const original = await originalFrontDocument({conversationId:r.front_conversation_id,
    messageId:r.front_message_id,attachmentId:r.attachment_id});
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
    // Historical-coding lookup is advisory: a transient Xero history failure must
    // not block drafting when an ACTIVE fallback nominal can be verified.
    const history=await inspectApprovedSupplierCoding(supplier,String(a.evidence_notes??'')).catch((error:unknown)=>({
      status:'history_unavailable',account_code:null,
      issues:[`Historical coding lookup unavailable: ${error instanceof Error?error.message:String(error)}; fallback nominal requires review`]
    }));
    issues.push(...((history.issues as string[])??[]));
    const historicalCode=typeof history.account_code==='string'?history.account_code:null;
    const coding = await accountCode(api,historicalCode??a.proposed_account);
    if (historicalCode) issues.push(`Nominal code ${historicalCode} selected from approved/paid Xero supplier bills; verify source descriptions`);
    if (coding.issue) issues.push(coding.issue);
    const contact = await supplierContact(api,supplier);
    if (contact.issue) issues.push(contact.issue);
    if (!a.proposed_account && !historicalCode) issues.push('No historically supported nominal code supplied');
    const common = {
      Status:'DRAFT',Contact:{ContactID:contact.id},Date:a.invoice_date,
      CurrencyCode:'GBP',LineAmountTypes:'Exclusive',
      LineItems:[{Description:`${r.document_type === 'credit_note' ? 'Supplier credit note' : 'Supplier invoice'} ${number} — check source attachment and review notes`,
        Quantity:1,UnitAmount:gross,AccountCode:coding.code,TaxType:'NONE'}]
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
    try {
      await attachAndVerifyOriginal(api.tenantId,api.accessToken,createdId,original.filename,
        original.contentType,original.bytes,kind as 'Invoices'|'CreditNotes');
      await pool.query(`UPDATE pilot_invoice_reviews SET xero_attachment_verified=TRUE WHERE id=$1`,[reviewId]);
    } catch(e) { issues.push(`Original attachment needs attention: ${e instanceof Error?e.message:String(e)}`); }
    // Preserve original assessment and human decisions. Add draft-specific issues separately.
    await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_error=$2,updated_at=NOW() WHERE id=$1`,
      [reviewId, issues.join(' | ').slice(0,4000) || null]);
    let sheetStatus:'synced'|'sync_failed'='synced';
    try { await syncPilotReviewExceptions(pool,[reviewId]); }
    catch(e) {sheetStatus='sync_failed';issues.push(`Sheet sync failed: ${e instanceof Error?e.message:String(e)}`);}
    return {status:'draft_created',review_id:reviewId,xero_draft_id:createdId,
      document_type:r.document_type,xero_contact_id:contact.id,new_contact_created:contact.created,
      account_code:coding.code,tax_type:'NONE',gross_gbp:gross,review_required:true,
      review_issues:issues,sheet_status:sheetStatus,approved:false,submitted:false};
  } catch(e) {
    const reason = e instanceof Error ? e.message : String(e);
    await pool.query(`UPDATE pilot_invoice_reviews SET xero_draft_status=CASE WHEN xero_draft_id IS NULL THEN $3 ELSE xero_draft_status END,
      xero_draft_error=$2,xero_draft_updated_at=NOW() WHERE id=$1`,[reviewId,reason.slice(0,4000),xeroPostStarted?'reconcile_required':null]).catch(()=>{});
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
