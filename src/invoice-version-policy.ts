/** Select one supplier invoice version before draft creation.
 * Call with every Front copy of a supplier+invoice number across the eligible queue.
 * The timestamp MUST be the Front message receipt time, not the invoice date.
 * This module never authorises a Xero write or clears a reconciliation hold.
 */
export type InvoiceVersion = {
  attachmentId:string; messageId:string; conversationId:string;
  receivedAt:string; supplierKey:string; invoiceNumber:string;
  contentFingerprint:string; statedGross:number; lineTotal?:number|null;
  explicitHumanHold?:boolean; xeroDocumentId?:string|null;
};
export type VersionDecision = {
  status:'latest_valid'|'blocked'|'already_in_xero';
  selected?:InvoiceVersion; supersededAttachmentIds:string[];
  reason:string;
};
export function selectLatestInvoiceVersion(versions:InvoiceVersion[]):VersionDecision {
  if(!versions.length) return {status:'blocked',supersededAttachmentIds:[],reason:'No invoice versions supplied'};
  const first=versions[0];
  if(versions.some(v=>v.supplierKey!==first.supplierKey || v.invoiceNumber.trim().toLowerCase()!==first.invoiceNumber.trim().toLowerCase()))
    return {status:'blocked',supersededAttachmentIds:[],reason:'Different supplier or invoice number; do not merge'};
  if(versions.some(v=>v.explicitHumanHold))
    return {status:'blocked',supersededAttachmentIds:[],reason:'An existing human hold must be preserved'};
  if(versions.some(v=>v.xeroDocumentId))
    return {status:'already_in_xero',supersededAttachmentIds:[],reason:'Existing Xero document must be reconciled; do not create another'};
  if(versions.some(v=>!v.receivedAt || !Number.isFinite(Date.parse(v.receivedAt)) || !v.contentFingerprint))
    return {status:'blocked',supersededAttachmentIds:[],reason:'Missing Front receipt timestamp or PDF fingerprint'};
  const sorted=[...versions].sort((a,b)=>Date.parse(b.receivedAt)-Date.parse(a.receivedAt));
  if(sorted.length>1 && Date.parse(sorted[0].receivedAt)===Date.parse(sorted[1].receivedAt) && sorted[0].contentFingerprint!==sorted[1].contentFingerprint)
    return {status:'blocked',supersededAttachmentIds:[],reason:'Different PDFs share the same latest Front receipt time; cannot choose safely'};
  const selected=sorted[0];
  if(!Number.isFinite(selected.statedGross) || selected.statedGross<=0)
    return {status:'blocked',supersededAttachmentIds:[],reason:'Latest invoice has no valid positive gross amount'};
  if(selected.lineTotal != null && (!Number.isFinite(selected.lineTotal) || Math.abs(selected.lineTotal-selected.statedGross)>0.011))
    return {status:'blocked',supersededAttachmentIds:[],reason:`Latest invoice arithmetic mismatch: lines ${selected.lineTotal}, stated gross ${selected.statedGross}`};
  return {status:'latest_valid',selected,supersededAttachmentIds:sorted.slice(1).map(v=>v.attachmentId),
    reason:sorted.every(v=>v.contentFingerprint===selected.contentFingerprint)?'Identical re-sends; keep one copy':'Latest Front-received valid version supersedes earlier differing copies'};
}
