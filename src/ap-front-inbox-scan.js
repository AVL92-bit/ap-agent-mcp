import { collectFrontMessagePages } from './front-message-pages.js';
const ROOT = 'https://api2.frontapp.com';
const HOSTS = new Set(['api2.frontapp.com', 'medicspot-limited.api.frontapp.com']);
function checkedNext(value, path) {
    const u = new URL(value, ROOT);
    if (u.protocol !== 'https:' || !HOSTS.has(u.hostname) || u.pathname !== path || u.username || u.password || u.hash)
        throw new Error('Unsafe Front pagination link');
    return u.href;
}
/** Complete inbox enumeration; no writes are allowed until all pages and all message histories have been read. */
export async function scanApFrontInbox(input) {
    const { inboxId, fetchPage } = input;
    if (!/^inb_[A-Za-z0-9_-]+$/.test(inboxId))
        throw new Error('Invalid Front inbox ID');
    const maxPages = input.maxPages ?? 1000, maxConversations = input.maxConversations ?? 10000;
    if (!Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(maxConversations) || maxConversations < 1)
        throw new Error('Invalid scan limits');
    const path = `/inboxes/${encodeURIComponent(inboxId)}/conversations`;
    let next = `${path}?${new URLSearchParams({ 'q[statuses]': 'unassigned', limit: '100' })}`;
    const seenPages = new Set(), seenConversations = new Set();
    const found = [];
    while (next) {
        if (seenPages.size >= maxPages)
            throw new Error('Incomplete Front inbox pagination');
        const url = checkedNext(next, path);
        if (seenPages.has(url))
            throw new Error('Repeated Front inbox page');
        seenPages.add(url);
        const page = await fetchPage(url);
        if (!Array.isArray(page._results))
            throw new Error('Malformed Front inbox page');
        for (const c of page._results) {
            if (c.status !== 'unassigned' || c.assignee != null)
                continue;
            if (!c.id || !/^cnv_[A-Za-z0-9_-]+$/.test(c.id))
                throw new Error('Invalid conversation in inbox listing');
            if (seenConversations.has(c.id))
                continue;
            seenConversations.add(c.id);
            found.push(c);
            if (found.length > maxConversations)
                throw new Error('Incomplete Front inbox: conversation limit reached');
        }
        const rawNext = page._pagination?.next;
        if (rawNext) {
            const u = new URL(checkedNext(rawNext, path));
            if (u.searchParams.getAll('q[statuses]').some(x => x !== 'unassigned') || u.searchParams.has('q[status_categories]') || u.searchParams.has('q[status_ids]'))
                throw new Error('Front pagination changed inbox filter');
            u.searchParams.set('q[statuses]', 'unassigned');
            next = u.href;
        }
        else
            next = null;
    }
    const result = [];
    for (const c of found) {
        const messages = await collectFrontMessagePages(c.id, fetchPage, maxPages);
        if (messages.hasMore || !messages.messages.length)
            throw new Error(`Incomplete message history: ${c.id}`);
        const attachments = [];
        const seenAttachmentIds = new Set();
        for (const m of messages.messages) {
            for (const a of m.attachments ?? []) {
                const id = a.id || a.url?.match(/\/download\/(fil_[A-Za-z0-9_-]+)/)?.[1];
                // Do not drop unidentified attachments: the runner must fail them explicitly.
                if (id && seenAttachmentIds.has(id)) {
                    attachments.push({ id, filename: a.filename ?? '', messageId: m.id ?? '' });
                    continue;
                }
                if (id)
                    seenAttachmentIds.add(id);
                attachments.push({ id: id ?? '', filename: a.filename ?? '', messageId: m.id ?? '' });
            }
        }
        result.push({ id: c.id, subject: c.subject ?? '', body: messages.messages.map(m => [m.subject, m.body, m.text, m.blurb].filter(Boolean).join('\n')).join('\n'), attachments });
    }
    return result;
}
