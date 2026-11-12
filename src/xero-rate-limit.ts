/** Shared, process-local Xero request pacing. No automatic replay of writes. */
const MIN_INTERVAL_MS = 2000;
let nextSlot = 0;
let queue: Promise<void> = Promise.resolve();
let blockedUntil = 0;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function xeroFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!new URL(url).hostname.endsWith('.xero.com')) return fetch(input, init);
  // Serialize request starts across all Xero modules in this Node process.
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  const previous = queue;
  queue = turn;
  await previous;
  try {
    const now = Date.now();
    // A long block means the daily limit: fail fast instead of sleeping for hours.
    if (blockedUntil - now > 2 * 60_000) {
      throw new Error(`Xero rate-limit pause: Xero API blocked until ${new Date(blockedUntil).toISOString()}; stop Xero calls and resume after cooldown`);
    }
    const delay = Math.max(0, nextSlot - now, blockedUntil - now);
    if (delay) await sleep(delay);
    nextSlot = Date.now() + MIN_INTERVAL_MS;
  } finally { release(); }
  const response = await fetch(input, init);
  const endpoint = new URL(url).pathname;
  const problem = response.headers.get('X-Rate-Limit-Problem');
  const retry = response.headers.get('Retry-After');
  const minute = response.headers.get('X-MinLimit-Remaining');
  const day = response.headers.get('X-DayLimit-Remaining');
  console.info('Xero API request', JSON.stringify({ method: init?.method ?? 'GET', endpoint, status: response.status,
    minute_remaining: minute, day_remaining: day, rate_limit_problem: problem, retry_after_seconds: retry }));
  if (response.status === 429) {
    const seconds = retry == null ? NaN : Number(retry);
    const wait = Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 60_000;
    blockedUntil = Math.max(blockedUntil, Date.now() + wait);
    // Stop the current workflow rather than silently retrying a potentially mutating operation.
    throw new Error(`Xero HTTP 429 rate limit${problem ? ` (${problem})` : ''}; Retry-After: ${retry ?? 'not supplied'} seconds; stop Xero calls and resume after cooldown`);
  }
  return response;
}
