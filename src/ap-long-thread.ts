/**
 * Long forwarded email threads (owner decision 2026-11-19).
 *
 * A conversation that carries documents from THREE OR MORE different emails (a forwarded chain, or the same
 * thread answered and re-forwarded many times) is a "long thread". Re-reading and reporting every old document
 * on every run buries finance in noise, so the agent:
 *   1. processes only the NEWEST email's documents normally (drafts the most recent invoice),
 *   2. marks every older unprocessed document as skipped (never re-read, never re-reported),
 *   3. writes ONE Sheet row explaining what was done, and
 *   4. tags the conversation Human review (sticky) for finance to read the thread.
 *
 * A "source" is one email: a plain attachment's source is its message; a PDF found inside an attached
 * email (.eml) has that email as its source. So one email with six invoices attached is ONE source and is
 * never treated as a long thread.
 */
export type ThreadAttachment = { id: string; filename: string; messageId: string; sourceId?: string; receivedAt?: number };

export const LONG_THREAD_MIN_SOURCES = 3;
/** Journal statuses meaning "this document is already accounted for"; they do not count towards a long thread. */
export const HANDLED_STATUSES = new Set(['draft_verified', 'draft_uncertain', 'existing_verified', 'skipped_long_thread']);

export const sourceOf = (a: ThreadAttachment): string => a.sourceId ?? (/\.eml$/i.test(a.filename) ? a.id : a.messageId);

export type LongThreadPlan<T extends ThreadAttachment> =
  | { isLong: false; keep: T[]; skipped: []; sources: number }
  | { isLong: true; keep: T[]; skipped: T[]; sources: number; keptDocuments: T[]; newestAt: number | null };

/** `previous` maps attachment id -> earlier journal status. Pure: no I/O. */
export function planLongThread<T extends ThreadAttachment>(attachments: T[], previous: Map<string, string>): LongThreadPlan<T> {
  const unprocessed = attachments.filter(a => a.id && !HANDLED_STATUSES.has(previous.get(a.id) ?? ''));
  const bySource = new Map<string, T[]>();
  for (const a of unprocessed) {
    const key = sourceOf(a);
    const list = bySource.get(key);
    if (list) list.push(a); else bySource.set(key, [a]);
  }
  if (bySource.size < LONG_THREAD_MIN_SOURCES) return { isLong: false, keep: attachments, skipped: [], sources: bySource.size };
  // Newest source by received time; if times are missing or tie, the one that appears last in the thread wins.
  const position = new Map(attachments.map((a, i) => [a, i] as const));
  const newestTime = (docs: T[]) => Math.max(...docs.map(d => d.receivedAt ?? 0));
  const lastPosition = (docs: T[]) => Math.max(...docs.map(d => position.get(d) ?? 0));
  const [, keptDocuments] = [...bySource.entries()]
    .sort((a, b) => newestTime(b[1]) - newestTime(a[1]) || lastPosition(b[1]) - lastPosition(a[1]))[0]!;
  const kept = new Set(keptDocuments);
  const skipped = unprocessed.filter(a => !kept.has(a));
  const skippedSet = new Set(skipped);
  const t = newestTime(keptDocuments);
  return { isLong: true, keep: attachments.filter(a => !skippedSet.has(a)), skipped, sources: bySource.size, keptDocuments, newestAt: t > 0 ? t : null };
}

const day = (ms: number | null) => ms ? new Date(ms).toISOString().slice(0, 10) : 'date unknown';
/** The single Sheet note for a long thread. Names files only; never any amounts or bank details. */
export function longThreadNote(plan: Extract<LongThreadPlan<ThreadAttachment>, { isLong: true }>): string {
  const names = (docs: ThreadAttachment[], max: number) => {
    const list = docs.slice(0, max).map(d => d.filename || d.id).join(', ');
    return docs.length > max ? `${list} and ${docs.length - max} more` : list;
  };
  return `Long email thread: documents from ${plan.sources} different emails. Only the newest (${day(plan.newestAt)}: ${names(plan.keptDocuments, 4)}) was processed. `
    + `${plan.skipped.length} older document(s) were skipped and will not be re-read: ${names(plan.skipped, 6)}. `
    + 'Open the conversation in Front, check the actions are clear and that no other invoice in the thread needs drafting.';
}
