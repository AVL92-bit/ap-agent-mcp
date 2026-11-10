/** Fetch all Front conversation messages before making any archive decision.
 * Reject incomplete, cyclic or cross-origin pagination rather than assuming
 * the first page represents the whole conversation.
 */
export type FrontPage<T> = {
  _results?: T[];
  _pagination?: {next?: string | null};
};
export async function collectFrontMessagePages<T>(
  conversationId: string,
  fetchPage: (url: string) => Promise<FrontPage<T>>,
  maxPages = 1000,
): Promise<{messages:T[]; hasMore:boolean; pages:number}> {
  if (!/^cnv_[A-Za-z0-9_-]+$/.test(conversationId)) throw new Error('Invalid Front conversation ID');
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error('Invalid page limit');
  const path = `/conversations/${encodeURIComponent(conversationId)}/messages`;
  let next: string | null = `${path}?limit=100`;
  const visited = new Set<string>();
  const messages: T[] = [];
  while (next) {
    if (visited.size >= maxPages) return {messages,hasMore:true,pages:visited.size};
    const parsed = new URL(next,'https://api2.frontapp.com');
    if (parsed.protocol !== 'https:' || !['api2.frontapp.com','medicspot-limited.api.frontapp.com'].includes(parsed.hostname) ||
        parsed.username || parsed.password || parsed.pathname !== path) {
      throw new Error('Unsafe Front message pagination URL');
    }
    const canonical = parsed.href;
    if (visited.has(canonical)) throw new Error('Repeated Front message page');
    visited.add(canonical);
    const page = await fetchPage(canonical);
    if (!Array.isArray(page._results)) throw new Error('Invalid Front message page');
    messages.push(...page._results);
    next = page._pagination?.next ?? null;
  }
  return {messages,hasMore:false,pages:visited.size};
}
