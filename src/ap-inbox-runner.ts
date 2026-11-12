import { createHash } from 'node:crypto';
import { DocumentNeedsHumanReview } from './ap-document-verification.js';
import { classifyNoAttachment, FRONT_OUTCOME_POLICY } from './ap-outcome-policy.js';
import { decideDocumentConversation, type DocumentDisposition } from './ap-conversation-completion.js';
import { reconcileCreateAndAttach, type DraftCommand, type XeroDraftPort } from './ap-xero-document-coordinator.js';
import { frontTagKey } from './front-tag-match.js';

/** Application-owned orchestration boundary. All conversation IDs and attachments
 * come from the inbox port, never from an LLM-supplied selection. */
export type InboxAttachment = { id: string; filename: string; messageId: string };
export type InboxConversation = { id: string; subject: string; body: string; attachments: InboxAttachment[]; tags?: string[] };
export type InboxPort = {
  listAllOpenConversations(): Promise<InboxConversation[]>; // MUST throw on truncated pagination
  makeDraftCommand(conversation: InboxConversation, attachment: InboxAttachment): Promise<DraftCommand>;
  applyTag(conversationId: string, tag: string): Promise<void>;
  archive(conversationId: string): Promise<void>;
  reportReview(row: { conversationId: string; attachmentId: string; xeroId?: string; reason: string; outcome: 'draft_uncertain'|'technical_failure'|'not_invoice'|'unclear'; filename?: string; supplier?: string; extractedSupplier?: string; supplierMatchScore?: number; reference?: string; gross?: number }): Promise<void>;
  /** Open an attached email (.eml) and return the PDFs inside it as attachments. */
  expandEmail?(conversation: InboxConversation, attachment: InboxAttachment): Promise<InboxAttachment[]>;
  journal?: { previous?(conversationId:string, attachmentId:string):Promise<{status:string; xeroId?:string|null}|null>; begin(conversationId:string, attachmentId:string, sha256:string):Promise<void>; claimCreate?(conversationId:string, attachmentId:string):Promise<boolean>; complete(conversationId:string, attachmentId:string, status:string, xeroId?:string):Promise<void> };
};
export type InboxRunItem = { conversationId: string; tag?: string; archived: boolean; documents: number; failures: string[] };
export type InboxRunReport = { conversations: number; documents: number; archived: number; items: InboxRunItem[] };

/** Documents the agent processes; every other attachment type is ignored. */
export const DOCUMENT_ATTACHMENT = /\.(?:pdf|docx?|xlsx?|eml)$/i;
const HUMAN_REVIEW = frontTagKey('Human review');

/** Never archive when a required operation fails; a Sheet outage is reported but
 * does not undo a successful draft or prevent its Front outcome. */
export async function runApInbox(port: InboxPort, xero: XeroDraftPort): Promise<InboxRunReport> {
  const conversations = await port.listAllOpenConversations();
  const ids = new Set<string>();
  const report: InboxRunReport = { conversations: conversations.length, documents: 0, archived: 0, items: [] };
  for (let conversation of conversations) {
    const item: InboxRunItem = { conversationId: conversation.id, archived: false, documents: 0, failures: [] };
    report.items.push(item);
    if (!conversation.id || ids.has(conversation.id)) { item.failures.push('Duplicate or missing conversation ID'); continue; }
    ids.add(conversation.id);
    // Only PDF, Word and Excel attachments are documents. Images, signatures, calendar
    // files etc. are ignored; a conversation with none of these is a no-attachment email.
    conversation = { ...conversation, attachments: conversation.attachments.filter(a => DOCUMENT_ATTACHMENT.test(a.filename)) };
    // Attached emails are opened and the PDFs inside processed like normal attachments.
    // An attached email with no PDF inside stays as an attachment and goes to Human Review.
    if (port.expandEmail) {
      const expanded: InboxAttachment[] = [];
      for (const a of conversation.attachments) {
        if (!/\.eml$/i.test(a.filename)) { expanded.push(a); continue; }
        try { const inner = await port.expandEmail(conversation, a); expanded.push(...(inner.length ? inner : [a])); }
        catch (e) { expanded.push(a); item.failures.push(`Attached email ${a.id}: ${String(e)}`); }
      }
      conversation = { ...conversation, attachments: expanded };
    }
    // A conversation already tagged Human Review is waiting for finance: the agent never
    // re-tags or archives it. New attachments in it are still processed.
    const awaitingReview = (conversation.tags ?? []).some(t => frontTagKey(t) === HUMAN_REVIEW);
    if (!conversation.attachments.length) {
      if (awaitingReview) { item.tag = 'Human review (unchanged, awaiting finance)'; continue; }
      const outcome = classifyNoAttachment(`${conversation.subject}\n${conversation.body}`);
      const policy = FRONT_OUTCOME_POLICY[outcome];
      try {
        await port.applyTag(conversation.id, policy.tag);
        item.tag = policy.tag;
        if (policy.archive) { await port.archive(conversation.id); item.archived = true; report.archived++; }
      } catch (e) { item.failures.push(`Front outcome: ${String(e)}`); }
      continue;
    }
    const dispositions: DocumentDisposition[] = [];
    const attachmentIds = new Set<string>();
    for (const attachment of conversation.attachments) {
      item.documents++; report.documents++;
      if (!attachment.id || attachmentIds.has(attachment.id)) {
        dispositions.push({ attachmentId: attachment.id, disposition: 'processing_failure' });
        item.failures.push('Duplicate or missing attachment ID');
        continue;
      }
      attachmentIds.add(attachment.id);
      let failure: string | undefined;
      let xeroId: string | undefined;
      let uncertain = false;
      try {
        // Attachments already drafted or found in Xero on an earlier run are not re-read.
        const previous = await port.journal?.previous?.(conversation.id, attachment.id);
        if (previous && ['draft_verified','draft_uncertain','existing_verified'].includes(previous.status)) {
          dispositions.push({ attachmentId: attachment.id, disposition: previous.status === 'draft_uncertain' ? 'draft_uncertain_attached'
            : previous.status === 'existing_verified' ? 'xero_existing_verified' : 'xero_draft_attached' });
          continue;
        }
        if (/\.eml$/i.test(attachment.filename)) throw new DocumentNeedsHumanReview('unclear','Attached email contains no PDF invoice; finance to review');
        if (!/\.pdf$/i.test(attachment.filename)) throw new DocumentNeedsHumanReview('unclear','Word/Excel document: not yet drafted automatically; finance to review');
        const command = await port.makeDraftCommand(conversation, attachment);
        uncertain = command.uncertainFields.length > 0 || (command.reviewNotes?.length ?? 0) > 0;
        await port.journal?.begin(conversation.id, attachment.id, createHash('sha256').update(command.pdf.bytes).digest('hex'));
        const guardedXero = port.journal?.claimCreate
          ? {...xero, beforeCreate:()=>port.journal!.claimCreate!(conversation.id,attachment.id)}
          : xero;
        const outcome = await reconcileCreateAndAttach(command, guardedXero);
        if (outcome.status === 'already_in_xero') {
          await port.journal?.complete(conversation.id, attachment.id, 'existing_verified', outcome.xeroId);
          // Already in Xero (drafted earlier or entered by a person): accounted for. Whether
          // the conversation stays open is decided by the Human Review tag, not Xero status.
          dispositions.push({ attachmentId: attachment.id, disposition: 'xero_existing_verified' });
          continue;
        }
        if (outcome.status === 'draft_created') {
          xeroId = outcome.xeroId;
          await port.journal?.complete(conversation.id, attachment.id, uncertain ? 'draft_uncertain' : 'draft_verified', xeroId);
          dispositions.push({ attachmentId: attachment.id, disposition: uncertain ? 'draft_uncertain_attached' : 'xero_draft_attached' });
          if (uncertain) {
            try { await port.reportReview({ conversationId: conversation.id, attachmentId: attachment.id, xeroId, reason: [`Uncertain fields: ${command.uncertainFields.join(', ')}`, ...(command.uncertainFields.includes('grossAmount') ? ['Amount uncertain: check against the document (credit/brought-forward balance or unclear total)'] : []), ...(command.reviewNotes ?? [])].join(' | '), outcome: 'draft_uncertain', supplier:command.supplierName, extractedSupplier:command.extractedSupplierName, supplierMatchScore:command.supplierMatchScore, reference:command.number, gross:command.gross }); }
            catch (e) { item.failures.push(`Sheet report pending: ${String(e)}`); }
          }
          continue;
        }
        xeroId = outcome.status === 'attachment_failed' ? outcome.xeroId : undefined;
        failure = outcome.error;
      } catch (e) {
        if (e instanceof DocumentNeedsHumanReview && e.kind === 'supporting_document') {
          // Receipts are supporting documents: never posted, no Sheet row, no failure.
          dispositions.push({ attachmentId: attachment.id, disposition: 'supporting_document' });
          continue;
        }
        if (e instanceof DocumentNeedsHumanReview) {
          // No journal or Xero call is made for a non-invoice/unclear document.
          dispositions.push({ attachmentId: attachment.id, disposition: 'processing_failure' });
          try { await port.reportReview({conversationId:conversation.id,attachmentId:attachment.id,
            filename:attachment.filename,reason:e.message,outcome:e.kind as 'not_invoice'|'unclear'}); }
          catch (sheetError) { item.failures.push(`Sheet review log failed: ${String(sheetError)}`); }
          continue;
        }
        failure = String(e);
      }
      try { await port.journal?.complete(conversation.id, attachment.id, 'technical_failure', xeroId); } catch (e) { item.failures.push(`Journal failure: ${String(e)}`); }
      dispositions.push({ attachmentId: attachment.id, disposition: 'processing_failure' });
      item.failures.push(`${attachment.id}: ${failure}`);
      try { await port.reportReview({ conversationId: conversation.id, attachmentId: attachment.id, xeroId, reason: failure || 'Unknown processing failure', outcome: 'technical_failure' }); }
      catch (e) { item.failures.push(`Sheet report pending: ${String(e)}`); }
    }
    const decision = decideDocumentConversation(dispositions);
    if (awaitingReview) { item.tag = 'Human review (unchanged, awaiting finance)'; continue; }
    try {
      await port.applyTag(conversation.id, decision.tag);
      item.tag = decision.tag;
      if (decision.archive) { await port.archive(conversation.id); item.archived = true; report.archived++; }
    } catch (e) { item.failures.push(`Front outcome: ${String(e)}`); }
  }
  return report;
}
