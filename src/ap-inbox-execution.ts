import { scanApFrontInbox } from './ap-front-inbox-scan.js';
import { runApInbox, type InboxConversation, type InboxPort, type InboxRunReport } from './ap-inbox-runner.js';
import type { XeroDraftPort } from './ap-xero-document-coordinator.js';

/** One application-owned scan/execute boundary. The scan MUST finish before
 * any write is attempted. No LLM-supplied conversation or document selection. */
export async function executeCompleteApInbox(input: {
  inboxId: string;
  fetchFrontPage: (url: string) => Promise<{_results?:unknown[];_pagination?:{next?:string|null}}>;
  makeDraftCommand: InboxPort['makeDraftCommand'];
  applyTag: InboxPort['applyTag'];
  archive: InboxPort['archive'];
  reportReview: InboxPort['reportReview'];
  xero: XeroDraftPort;
  journal?: InboxPort['journal'];
  expandEmail?: InboxPort['expandEmail'];
  maxPages?: number;
  maxConversations?: number;
  /** Optional limit applied AFTER the complete scan (named conversations / max count). */
  select?: (all: InboxConversation[]) => InboxConversation[];
}): Promise<InboxRunReport> {
  const scanned: InboxConversation[] = await scanApFrontInbox({
    inboxId: input.inboxId, fetchPage: input.fetchFrontPage,
    maxPages: input.maxPages, maxConversations: input.maxConversations,
  });
  const conversations = input.select ? input.select(scanned) : scanned;
  const port: InboxPort = {
    listAllOpenConversations: async () => conversations,
    makeDraftCommand: input.makeDraftCommand,
    applyTag: input.applyTag,
    archive: input.archive,
    reportReview: input.reportReview,
    journal: input.journal,
    expandEmail: input.expandEmail,
  };
  return runApInbox(port, input.xero);
}
