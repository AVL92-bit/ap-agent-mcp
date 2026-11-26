import type { ReviewRow } from './ap-sheet-outbox.js';

/** Front comments: the same exception rows that go to the Finance review Google Sheet, written as an internal
 * comment on the Front conversation (trial, started 2026-11-26, runs alongside the Sheet). A comment is internal
 * (never sent to the supplier), is queued and de-duplicated by the same outbox as the Sheet (one comment per
 * conversation + document + outcome), and a failure to comment never blocks a draft, a tag or an archive.
 * Comments carry no bank details and no personal data: the reason, file, supplier, reference and amount only.
 * Turn off with the Railway variable FRONT_COMMENTS_ENABLED=false. */
export const FRONT_COMMENTS_TABLE = 'ap_front_comment_outbox';
export const FRONT_COMMENT_MAX_ATTEMPTS = 5;
export const frontCommentsEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  env.FRONT_COMMENTS_ENABLED?.trim().toLowerCase() !== 'false';

const LABEL: Record<ReviewRow['outcome'], string> = {
  draft_uncertain: 'DRAFT CREATED IN XERO - check before approving',
  supplier_missing: 'NOT DRAFTED - supplier not in Xero',
  unclear: 'NOT DRAFTED - needs a person',
  not_invoice: 'NOT AN INVOICE',
  not_posted: 'NOT POSTED - already in Xero or amended',
  technical_failure: 'FAILED - the agent could not process this',
  long_thread: 'LONG THREAD - only the newest email was processed',
};
const money = (n: number) => `£${n.toFixed(2)}`;
export function frontCommentText(row: ReviewRow): string {
  const detail = [
    row.filename ? `File: ${row.filename}` : null,
    row.supplier ? `Supplier in Xero: ${row.supplier}` : null,
    row.extractedSupplier && row.extractedSupplier !== row.supplier ? `Supplier on the document: ${row.extractedSupplier}` : null,
    row.reference ? `Invoice number: ${row.reference}` : null,
    typeof row.gross === 'number' && Number.isFinite(row.gross) ? `Amount: ${money(row.gross)}` : null,
  ].filter(Boolean);
  return [`AP Agent: ${LABEL[row.outcome] ?? row.outcome}`, row.reason, ...detail].join('\n').slice(0, 4000);
}

export type FrontWrite = (path: string, method: 'POST' | 'PATCH', body?: unknown) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
/** Posts one internal comment on the row's conversation. Throws on any non-success so the outbox retries or gives up. */
export function makeFrontCommentDeliver(write: FrontWrite): (row: ReviewRow) => Promise<void> {
  return async (row) => {
    if (!/^cnv_[A-Za-z0-9]+$/.test(row.conversationId)) throw new Error('Invalid Front conversation id');
    const response = await write(`/conversations/${encodeURIComponent(row.conversationId)}/comments`, 'POST', { body: frontCommentText(row) });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      throw new Error(`Front comment HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
  };
}

/** Put comments that were given up on (e.g. while the Front token lacked a scope) back in the queue, with a fresh
 * attempt count. Touches only the comment queue; nothing is sent until the next run. Returns how many were reset. */
export async function requeueGivenUpComments(db: { query(sql: string, args?: unknown[]): Promise<{ rowCount?: number | null; rows: unknown[] }> }): Promise<number> {
  const r = await db.query(`UPDATE ${FRONT_COMMENTS_TABLE} SET delivered_at=NULL, attempts=0, last_error=NULL, updated_at=now()
    WHERE delivered_at IS NOT NULL AND last_error LIKE 'GAVE UP%'`);
  return Number(r.rowCount ?? 0);
}
