import { createHash } from 'node:crypto';
import { DocumentNeedsHumanReview } from './ap-document-verification.js';
import { classifyNoAttachment, FRONT_OUTCOME_POLICY } from './ap-outcome-policy.js';
import { decideDocumentConversation, type DocumentDisposition } from './ap-conversation-completion.js';
import { reconcileCreateAndAttach, type DraftCommand, type XeroDraftPort } from './ap-xero-document-coordinator.js';

/** Application-owned orchestration boundary. All conversation IDs and attachments
 * come from the inbox port, never from an LLM-supplied selection. */
export type InboxAttachment = { id: string; filename: string; messageId: string };
export type InboxConversation = { id: string; subject: string; body: string; attachments: InboxAttachment[] };
export type InboxPort = {
  listAllOpenConversations(): Promise<InboxConversation[]>; // MUST throw on truncated pagination
  makeDraftCommand(conversation: InboxConversation, attachment: InboxAttachment): Promise<DraftCommand>;
  applyTag(conversationId: string, tag: string): Promise<void>;
  archive(conversationId: string): Promise<void>;
  reportReview(row: { conversationId: string; attachmentId: string; xeroId?: string; reason: string; outcome: 'draft_uncertain'|'technical_failure'|'not_invoice'|'unclear'; filename?: string; supplier?: string; extractedSupplier?: string; supplierMatchScore?: number; reference?: string; gross?: number }): Promise<void>;
  journal?: { begin(conversationId:string, attachmentId:string, sha256:string):Promise<void>; claimCreate?(conversationId:string, attachmentId:string):Promise<boolean>; complete(conversationId:string, attachmentId:string, status:string, xeroId?:string):Promise<void> };
};
export type InboxRunItem = { conversationId: string; tag?: string; archived: boolean; documents: number; failures: string[] };
export type InboxRunReport = { conversations: number; documents: number; archived: number; items: InboxRunItem[] };

/** Never archive when a required operation fails; a Sheet outage is reported but
 * does not undo a successful draft or prevent its Front outcome. */
export async function runApInbox(port: InboxPort, xero: XeroDraftPort): Promise<InboxRunReport> {
  const conversations = await port.listAllOpenConversations();
  const ids = new Set<string>();
  const report: InboxRunReport = { conversations: conversations.length, documents: 0, archived: 0, items: [] };
  for (const conversation of conversations) {
    const item: InboxRunItem = { conversationId: conversation.id, archived: false, documents: 0, failures: [] };
    report.items.push(item);
    if (!conversation.id || ids.has(conversation.id)) { item.failures.push('Duplicate or missing conversation ID'); continue; }
    ids.add(conversation.id);
    if (!conversation.attachments.length) {
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
        if (!/\.pdf$/i.test(attachment.filename)) throw new DocumentNeedsHumanReview('unclear','This document format is not yet supported for invoice-content verification');
        const command = await port.makeDraftCommand(conversation, attachment);
        uncertain = command.uncertainFields.length > 0;
        await port.journal?.begin(conversation.id, attachment.id, createHash('sha256').update(command.pdf.bytes).digest('hex'));
        const guardedXero = port.journal?.claimCreate
          ? {...xero, beforeCreate:()=>port.journal!.claimCreate!(conversation.id,attachment.id)}
          : xero;
        const outcome = await reconcileCreateAndAttach(command, guardedXero);
        if (outcome.status === 'already_in_xero') {
          await port.journal?.complete(conversation.id, attachment.id, 'existing_verified', outcome.xeroId);
          dispositions.push({ attachmentId: attachment.id, disposition: 'xero_existing_verified' });
          continue;
        }
        if (outcome.status === 'draft_created') {
          xeroId = outcome.xeroId;
          await port.journal?.complete(conversation.id, attachment.id, uncertain ? 'draft_uncertain' : 'draft_verified', xeroId);
          dispositions.push({ attachmentId: attachment.id, disposition: uncertain ? 'draft_uncertain_attached' : 'xero_draft_attached' });
          if (uncertain) {
            try { await port.reportReview({ conversationId: conversation.id, attachmentId: attachment.id, xeroId, reason: `Uncertain fields: ${command.uncertainFields.join(', ')}${command.uncertainFields.includes('grossAmount') ? ' | Amount uncertain due to carried-forward credit or ambiguous invoice total; verify current-period charges against original PDF' : ''}`, outcome: 'draft_uncertain', supplier:command.supplierName, extractedSupplier:command.extractedSupplierName, supplierMatchScore:command.supplierMatchScore, reference:command.number, gross:command.gross }); }
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
    try {
      await port.applyTag(conversation.id, decision.tag);
      item.tag = decision.tag;
      if (decision.archive) { await port.archive(conversation.id); item.archived = true; report.archived++; }
    } catch (e) { item.failures.push(`Front outcome: ${String(e)}`); }
  }
  return report;
}
