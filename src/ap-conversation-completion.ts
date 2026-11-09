/** A Front conversation is a unit of completion, not an individual attachment.
 * A PostgreSQL review is deliberately not a completed Xero document.
 */
export type AttachmentDisposition =
  | 'xero_draft_attached'
  | 'xero_existing_verified'
  | 'draft_uncertain_attached'
  | 'processing_failure'
  | 'unprocessed';
export type DocumentDisposition = { attachmentId: string; disposition: AttachmentDisposition };
export type ConversationDecision = {
  archive: boolean;
  tag: 'AP Agent reviewed' | 'Human review';
  reason: string;
};
export function decideDocumentConversation(documents: DocumentDisposition[]): ConversationDecision {
  if (!documents.length) return {archive:false,tag:'Human review',reason:'No verified documents'};
  const ids = new Set<string>();
  for (const doc of documents) {
    if (!doc.attachmentId || ids.has(doc.attachmentId)) {
      return {archive:false,tag:'Human review',reason:'Missing or repeated attachment identity'};
    }
    ids.add(doc.attachmentId);
  }
  if (documents.some(d => d.disposition === 'processing_failure' || d.disposition === 'unprocessed')) {
    return {archive:false,tag:'Human review',reason:'At least one attachment is not accounted for in Xero'};
  }
  if (documents.some(d => d.disposition === 'draft_uncertain_attached')) {
    return {archive:false,tag:'Human review',reason:'At least one newly drafted document needs review'};
  }
  return {archive:true,tag:'AP Agent reviewed',reason:'Every attachment verified in Xero'};
}
