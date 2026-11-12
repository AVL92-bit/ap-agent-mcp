/** Dry run of the complete AP inbox. Runs the SAME runApInbox orchestration as a live
 * run, with every write replaced by a recording: no Xero draft, PDF upload, journal,
 * Sheet row, Front tag or archive. Xero READS (duplicate lookup, attachment check,
 * contacts, accounts, bill history) are real, so the report shows what a live run would do.
 */
import { runApInbox, type InboxConversation, type InboxPort } from './ap-inbox-runner.js';
import type { DraftCommand, XeroDraftPort } from './ap-xero-document-coordinator.js';

export type DryRunDocument = {
  attachmentId: string; filename: string;
  outcome: 'would_create_draft' | 'already_in_xero' | 'would_attach_pdf_to_existing' | 'supporting_document' | 'not_drafted' | 'failure';
  reason?: string;
  draft?: { number: string; supplierContactId: string; supplierName?: string; extractedSupplierName?: string;
    supplierMatchScore?: number; accountCode: string; invoiceDate: string; dueDate: string; gross: number;
    kind: string; uncertainFields: string[] };
  xeroId?: string;
};
export type DryRunConversation = {
  conversationId: string; subject: string; documents: DryRunDocument[];
  frontTag?: string; wouldArchive: boolean; sheetRows: Array<{ outcome: string; reason: string; filename?: string }>;
  failures: string[];
};
export type DryRunReport = { dry_run: true; writes_performed: 0; conversations_scanned: number;
  conversations_in_run: number; items: DryRunConversation[] };

/** Limit a run to named conversations and/or a maximum count, after a complete scan. */
export function selectConversations(all: InboxConversation[], limit: { conversationIds?: string[]; maxConversations?: number }): InboxConversation[] {
  let chosen = all;
  if (limit.conversationIds?.length) {
    const wanted = new Set(limit.conversationIds);
    const unknown = limit.conversationIds.filter(id => !all.some(c => c.id === id));
    if (unknown.length) throw new Error(`Not open/unassigned in the AP inbox: ${unknown.join(', ')}`);
    chosen = all.filter(c => wanted.has(c.id));
  }
  if (limit.maxConversations !== undefined) chosen = chosen.slice(0, limit.maxConversations);
  return chosen;
}

export async function dryRunApInbox(input: {
  conversations: InboxConversation[];
  conversationsScanned: number;
  makeDraftCommand: InboxPort['makeDraftCommand'];
  liveXero: XeroDraftPort; // only lookup and verifyOriginal (reads) are called
}): Promise<DryRunReport> {
  const items = new Map<string, DryRunConversation>();
  const item = (id: string) => items.get(id)!;
  for (const c of input.conversations) items.set(c.id, { conversationId: c.id, subject: c.subject, documents: [],
    wouldArchive: false, sheetRows: [], failures: [] });
  const current: { conversationId?: string; attachmentId?: string; filename?: string; command?: DraftCommand } = {};
  const doc = (): DryRunDocument | undefined =>
    item(current.conversationId!)?.documents.find(d => d.attachmentId === current.attachmentId);
  const pretendAttached = new Set<string>();
  let fakeIds = 0;

  const port: InboxPort = {
    listAllOpenConversations: async () => input.conversations,
    makeDraftCommand: async (conversation, attachment) => {
      current.conversationId = conversation.id; current.attachmentId = attachment.id;
      current.filename = attachment.filename; current.command = undefined;
      const entry: DryRunDocument = { attachmentId: attachment.id, filename: attachment.filename, outcome: 'failure' };
      item(conversation.id).documents.push(entry);
      try {
        const command = await input.makeDraftCommand(conversation, attachment);
        current.command = command;
        entry.draft = { number: command.number, supplierContactId: command.supplierContactId, supplierName: command.supplierName,
          extractedSupplierName: command.extractedSupplierName, supplierMatchScore: command.supplierMatchScore,
          accountCode: command.accountCode, invoiceDate: command.invoiceDate, dueDate: command.dueDate,
          gross: command.gross, kind: command.kind, uncertainFields: command.uncertainFields };
        return command;
      } catch (error) {
        const e = error as { kind?: string; message?: string };
        entry.outcome = e?.kind === 'supporting_document' ? 'supporting_document' : 'not_drafted';
        entry.reason = e?.message ?? String(error);
        throw error;
      }
    },
    applyTag: async (conversationId, tag) => { item(conversationId).frontTag = tag; },
    archive: async conversationId => { item(conversationId).wouldArchive = true; },
    reportReview: async row => {
      item(row.conversationId).sheetRows.push({ outcome: row.outcome, reason: row.reason, filename: row.filename });
      const d = item(row.conversationId).documents.find(x => x.attachmentId === row.attachmentId);
      // Attachments rejected before extraction (e.g. images) still appear in the report.
      if (!d) item(row.conversationId).documents.push({ attachmentId: row.attachmentId, filename: row.filename ?? '',
        outcome: 'not_drafted', reason: row.reason });
      else if (d.outcome === 'failure' && row.outcome === 'technical_failure') d.reason = row.reason;
    },
    // No journal: a dry run never claims or records an attempt.
  };
  const xero: XeroDraftPort = {
    lookup: number => input.liveXero.lookup(number),
    verifyOriginal: async (kind, id, pdf) => {
      if (id.startsWith('DRY-RUN-') || pretendAttached.has(id)) return true;
      return input.liveXero.verifyOriginal ? input.liveXero.verifyOriginal(kind, id, pdf) : false;
    },
    attachOriginal: async (_kind, id) => {
      pretendAttached.add(id);
      const d = doc(); if (d && !id.startsWith('DRY-RUN-')) { d.outcome = 'would_attach_pdf_to_existing'; d.xeroId = id; }
    },
    createDraft: async () => {
      const d = doc(); if (d) d.outcome = 'would_create_draft';
      return `DRY-RUN-${++fakeIds}`;
    },
  };
  const report = await runApInbox(port, xero);
  for (const r of report.items) {
    const it = items.get(r.conversationId); if (!it) continue;
    it.failures.push(...r.failures);
    for (const d of it.documents) {
      if (d.outcome === 'failure' && d.draft && !d.reason) { d.outcome = 'already_in_xero'; }
    }
  }
  return { dry_run: true, writes_performed: 0, conversations_scanned: input.conversationsScanned,
    conversations_in_run: input.conversations.length, items: [...items.values()] };
}
