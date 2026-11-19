import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { PayRunDownloads, FailureLimiter, passwordMatches, handlePayRunDownload, DOWNLOAD_TTL_MS, MAX_FAILED_ATTEMPTS } from '../dist/pay-run-download.js';

const basic = (pw, user = 'anyone') => `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`;
const PASSWORD = 'correct horse battery staple';

async function withServer(store, limiter, password, fn) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!handlePayRunDownload(req, res, url.pathname, store, limiter, password)) { res.writeHead(404); res.end('other'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise(r => server.close(r)); }
}

test('ids are unguessable (43 chars, base64url) and unique', () => {
  const s = new PayRunDownloads();
  const ids = new Set(Array.from({ length: 4 }, () => s.create('a,b', 'f.csv')));
  assert.equal(ids.size, 4);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{43}$/);
});
test('a file works once, then is gone', () => {
  const s = new PayRunDownloads();
  const id = s.create('csv-body', 'pay-run.csv');
  assert.deepEqual(s.take(id), { csv: 'csv-body', filename: 'pay-run.csv' });
  assert.equal(s.take(id), null);
  assert.equal(s.size, 0);
});
test('a file expires after 15 minutes', () => {
  const s = new PayRunDownloads();
  const t0 = 1_000_000;
  const id = s.create('x', 'a.csv', t0);
  assert.equal(s.take(id, t0 + DOWNLOAD_TTL_MS), null);
  const id2 = s.create('x', 'a.csv', t0);
  assert.notEqual(s.take(id2, t0 + DOWNLOAD_TTL_MS - 1), null);
});
test('at most 5 files are held; the oldest is dropped; unsafe file names are refused', () => {
  const s = new PayRunDownloads();
  const first = s.create('x', 'a.csv');
  for (let i = 0; i < 5; i++) s.create('x', 'a.csv');
  assert.equal(s.size, 5);
  assert.equal(s.take(first), null);
  assert.throws(() => s.create('x', '../evil.csv'), /file name/);
});
test('password check: username ignored, wrong or missing or unset all fail', () => {
  assert.equal(passwordMatches(basic(PASSWORD, 'whatever'), PASSWORD), true);
  assert.equal(passwordMatches(basic('nope'), PASSWORD), false);
  assert.equal(passwordMatches(undefined, PASSWORD), false);
  assert.equal(passwordMatches('Bearer abc', PASSWORD), false);
  assert.equal(passwordMatches(basic(PASSWORD), undefined), false);
  assert.equal(passwordMatches(basic(''), ''), false);
});
test('the limiter locks after 5 wrong attempts within the window and frees afterwards', () => {
  const l = new FailureLimiter();
  for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) l.record(1000);
  assert.equal(l.locked(1000), false);
  l.record(1000);
  assert.equal(l.locked(1000), true);
  assert.equal(l.locked(1000 + 10 * 60 * 1000), false);
});

test('route: no password header gets a login prompt, wrong password is refused, right password downloads once', async () => {
  const store = new PayRunDownloads(), limiter = new FailureLimiter();
  const id = store.create('Name,Amount\r\nx,1.00\r\n', 'pay-run-test.csv');
  await withServer(store, limiter, PASSWORD, async (base) => {
    const prompt = await fetch(`${base}/pay-run/${id}`);
    assert.equal(prompt.status, 401);
    assert.match(prompt.headers.get('www-authenticate') ?? '', /^Basic/);
    assert.equal(store.size, 1); // not consumed by the prompt
    const wrong = await fetch(`${base}/pay-run/${id}`, { headers: { Authorization: basic('wrong') } });
    assert.equal(wrong.status, 401);
    assert.equal(store.size, 1); // not consumed by a wrong password
    const ok = await fetch(`${base}/pay-run/${id}`, { headers: { Authorization: basic(PASSWORD) } });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'Name,Amount\r\nx,1.00\r\n');
    assert.match(ok.headers.get('content-type') ?? '', /^text\/csv/);
    assert.equal(ok.headers.get('content-disposition'), 'attachment; filename="pay-run-test.csv"');
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const again = await fetch(`${base}/pay-run/${id}`, { headers: { Authorization: basic(PASSWORD) } });
    assert.equal(again.status, 404);
  });
});
test('route: an unconfigured password disables the route; a bad id or method is refused; other paths are not handled', async () => {
  const store = new PayRunDownloads(), limiter = new FailureLimiter();
  const id = store.create('secret', 'a.csv');
  await withServer(store, limiter, undefined, async (base) => {
    assert.equal((await fetch(`${base}/pay-run/${id}`, { headers: { Authorization: basic(PASSWORD) } })).status, 503);
    assert.equal(store.size, 1);
  });
  await withServer(store, limiter, PASSWORD, async (base) => {
    assert.equal((await fetch(`${base}/pay-run/not-a-real-id`, { headers: { Authorization: basic(PASSWORD) } })).status, 404);
    assert.equal((await fetch(`${base}/pay-run/${id}`, { method: 'POST', headers: { Authorization: basic(PASSWORD) } })).status, 405);
    assert.equal((await fetch(`${base}/somewhere-else`)).status, 404);
    assert.equal(store.size, 1);
  });
});
test('route: five wrong passwords lock the route, even for the right password, and the file is not exposed', async () => {
  const store = new PayRunDownloads(), limiter = new FailureLimiter();
  const id = store.create('secret', 'a.csv');
  await withServer(store, limiter, PASSWORD, async (base) => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) assert.equal((await fetch(`${base}/pay-run/${id}`, { headers: { Authorization: basic(`guess${i}`) } })).status, 401);
    const locked = await fetch(`${base}/pay-run/${id}`, { headers: { Authorization: basic(PASSWORD) } });
    assert.equal(locked.status, 429);
    assert.equal((await locked.text()).includes('secret'), false);
    assert.equal(store.size, 1);
  });
});
test('the module never writes the file anywhere or logs it', () => {
  const s = readFileSync(new URL('../src/pay-run-download.ts', import.meta.url), 'utf8');
  assert.equal(/writeFile|appendFile|console\.|pg|Pool/.test(s.replace(/\/\*[\s\S]*?\*\//g, '')), false);
});
