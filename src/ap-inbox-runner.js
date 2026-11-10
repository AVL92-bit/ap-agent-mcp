import { classifyNoAttachment, FRONT_OUTCOME_POLICY } from './ap-outcome-policy.js';
import { decideDocumentConversation } from './ap-conversation-completion.js';
import { reconcileCreateAndAttach } from './ap-xero-document-coordinator.js';
/** Never archive when a required operation fails; a Sheet outage is reported but
 * does not undo a successful draft or prevent its Front outcome. */
export async function runApInbox(port, xero) {
    const conversations = await port.listAllOpenConversations();
    const ids = new Set();
    const report = { conversations: conversations.length, documents: 0, archived: 0, items: [] };
    for (const conversation of conversations) {
        const item = { conversationId: conversation.id, archived: false, documents: 0, failures: [] };
        report.items.push(item);
        if (!conversation.id || ids.has(conversation.id)) {
            item.failures.push('Duplicate or missing conversation ID');
            continue;
        }
        ids.add(conversation.id);
        if (!conversation.attachments.length) {
            const outcome = classifyNoAttachment(`${conversation.subject}\n${conversation.body}`);
            const policy = FRONT_OUTCOME_POLICY[outcome];
            try {
                await port.applyTag(conversation.id, policy.tag);
                item.tag = policy.tag;
                if (policy.archive) {
                    await port.archive(conversation.id);
                    item.archived = true;
                    report.archived++;
                }
            }
            catch (e) {
                item.failures.push(`Front outcome: ${String(e)}`);
            }
            continue;
        }
        const dispositions = [];
        const attachmentIds = new Set();
        for (const attachment of conversation.attachments) {
            item.documents++;
            report.documents++;
            if (!attachment.id || attachmentIds.has(attachment.id)) {
                dispositions.push({ attachmentId: attachment.id, disposition: 'processing_failure' });
                item.failures.push('Duplicate or missing attachment ID');
                continue;
            }
            attachmentIds.add(attachment.id);
            let failure;
            let xeroId;
            let uncertain = false;
            try {
                if (!/\.pdf$/i.test(attachment.filename))
                    throw new Error('Unsupported attachment format');
                const command = await port.makeDraftCommand(conversation, attachment);
                uncertain = command.uncertainFields.length > 0;
                const outcome = await reconcileCreateAndAttach(command, xero);
                if (outcome.status === 'already_in_xero') {
                    dispositions.push({ attachmentId: attachment.id, disposition: 'xero_existing_verified' });
                    continue;
                }
                if (outcome.status === 'draft_created') {
                    xeroId = outcome.xeroId;
                    dispositions.push({ attachmentId: attachment.id, disposition: uncertain ? 'draft_uncertain_attached' : 'xero_draft_attached' });
                    if (uncertain) {
                        try {
                            await port.reportReview({ conversationId: conversation.id, attachmentId: attachment.id, xeroId, reason: `Uncertain fields: ${command.uncertainFields.join(', ')}`, outcome: 'draft_uncertain' });
                        }
                        catch (e) {
                            item.failures.push(`Sheet report pending: ${String(e)}`);
                        }
                    }
                    continue;
                }
                xeroId = outcome.status === 'attachment_failed' ? outcome.xeroId : undefined;
                failure = outcome.error;
            }
            catch (e) {
                failure = String(e);
            }
            dispositions.push({ attachmentId: attachment.id, disposition: 'processing_failure' });
            item.failures.push(`${attachment.id}: ${failure}`);
            try {
                await port.reportReview({ conversationId: conversation.id, attachmentId: attachment.id, xeroId, reason: failure || 'Unknown processing failure', outcome: 'technical_failure' });
            }
            catch (e) {
                item.failures.push(`Sheet report pending: ${String(e)}`);
            }
        }
        const decision = decideDocumentConversation(dispositions);
        try {
            await port.applyTag(conversation.id, decision.tag);
            item.tag = decision.tag;
            if (decision.archive) {
                await port.archive(conversation.id);
                item.archived = true;
                report.archived++;
            }
        }
        catch (e) {
            item.failures.push(`Front outcome: ${String(e)}`);
        }
    }
    return report;
}
