/**
 * Secure one-time download of the pay run CSV (it contains supplier bank details).
 *
 * The file never passes through chat. The MCP tool only returns a link; opening the link in a browser asks
 * for the PAY_RUN_DOWNLOAD_PASSWORD (a dedicated password the owner sets in Railway; if it is not set the
 * route is disabled and no file is created). The file:
 *  - is held in server memory only (never written to the database, disk or logs),
 *  - has an unguessable 256-bit id,
 *  - works once, then is gone,
 *  - expires after 15 minutes,
 *  - is lost on any restart or deploy (just create it again).
 * Repeated wrong passwords lock the route for a while.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';

export const DOWNLOAD_TTL_MS = 15 * 60 * 1000;
export const MAX_FAILED_ATTEMPTS = 5;
export const FAIL_WINDOW_MS = 10 * 60 * 1000;
const MAX_FILES = 5;
export const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type Entry = { csv: string; filename: string; expiresAt: number };
export class PayRunDownloads {
  private files = new Map<string, Entry>();
  /** Stores the CSV and returns its unguessable id. */
  create(csv: string, filename: string, now = Date.now()): string {
    if (!/^[a-z0-9._-]{1,100}$/.test(filename)) throw new Error('Invalid download file name');
    this.sweep(now);
    while (this.files.size >= MAX_FILES) this.files.delete(this.files.keys().next().value as string); // oldest out
    const id = randomBytes(32).toString('base64url');
    this.files.set(id, { csv, filename, expiresAt: now + DOWNLOAD_TTL_MS });
    return id;
  }
  /** One-time: the file is deleted as it is taken. Expired or unknown ids return null. */
  take(id: string, now = Date.now()): { csv: string; filename: string } | null {
    this.sweep(now);
    const entry = this.files.get(id);
    if (!entry) return null;
    this.files.delete(id);
    return { csv: entry.csv, filename: entry.filename };
  }
  clear(): void { this.files.clear(); }
  get size(): number { return this.files.size; }
  private sweep(now: number): void { for (const [id, e] of this.files) if (e.expiresAt <= now) this.files.delete(id); }
}

export class FailureLimiter {
  private failures: number[] = [];
  record(now = Date.now()): void { this.failures.push(now); this.prune(now); }
  locked(now = Date.now()): boolean { this.prune(now); return this.failures.length >= MAX_FAILED_ATTEMPTS; }
  reset(): void { this.failures = []; }
  private prune(now: number): void { this.failures = this.failures.filter(t => now - t < FAIL_WINDOW_MS); }
}

export const payRunDownloads = new PayRunDownloads();
export const downloadFailures = new FailureLimiter();

const digest = (s: string) => createHash('sha256').update(s).digest();
/** HTTP Basic: the username is ignored, only the password counts. Compared in constant time. */
export function passwordMatches(authorization: string | undefined, expected: string | undefined): boolean {
  if (!expected || !authorization?.startsWith('Basic ')) return false;
  let credentials: string;
  try { credentials = Buffer.from(authorization.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const separator = credentials.indexOf(':');
  if (separator < 0) return false;
  return timingSafeEqual(digest(credentials.slice(separator + 1)), digest(expected));
}

const send = (res: http.ServerResponse, status: number, body: string, extra: Record<string, string> = {}) => {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(body);
};

/** Handles GET /pay-run/<id>. Returns true when the request was for this route (and has been answered). */
export function handlePayRunDownload(req: http.IncomingMessage, res: http.ServerResponse, pathname: string,
  store: PayRunDownloads = payRunDownloads, limiter: FailureLimiter = downloadFailures,
  password: string | undefined = process.env.PAY_RUN_DOWNLOAD_PASSWORD): boolean {
  const match = /^\/pay-run\/([^/]+)$/.exec(pathname);
  if (!match) return false;
  if (req.method !== 'GET') { send(res, 405, 'Method not allowed'); return true; }
  if (!password) { send(res, 503, 'Pay run download is not configured'); return true; }
  if (limiter.locked()) { send(res, 429, 'Too many wrong passwords. Try again later.'); return true; }
  const header = req.headers.authorization;
  if (!passwordMatches(header, password)) {
    if (header) limiter.record(); // the browser's first request has no header and is not a failed attempt
    send(res, 401, 'Password required', { 'WWW-Authenticate': 'Basic realm="Pay run download", charset="UTF-8"' });
    return true;
  }
  limiter.reset();
  const id = match[1]!;
  const file = ID_PATTERN.test(id) ? store.take(id) : null;
  if (!file) { send(res, 404, 'Not found: the link has already been used, has expired, or the server has restarted. Create a new one.'); return true; }
  send(res, 200, file.csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file.filename}"` });
  return true;
}
