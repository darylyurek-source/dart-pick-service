// End to end: the real HTTP API + real picker + a fake Massive server.
// Runs on the memory store; also on Postgres when TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { fetchSnapshot, MassiveError } from '../src/massive.js';
import pg from 'pg';

/** Start each Postgres test from empty tables (the memory store is new every time). */
async function wipe(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: process.env.PGSSL === 'disable' ? false : undefined });
  const tables = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  if (tables.rows.length) {
    await pool.query(`TRUNCATE ${tables.rows.map((t) => t.tablename).join(', ')}`);
  }
  await pool.end();
}

const KEY = 'SECRET-MASSIVE-KEY-123';

/** A fake Massive. Call 1 returns the base prices, later calls the moved prices. */
function fakeMassive({ base, moved, ageSec = {}, failOnCall = null, status = 200 }) {
  const state = { calls: 0, keys: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.keys.push(url.searchParams.get('apiKey'));
    state.calls++;
    if (status !== 200 || state.calls === failOnCall) {
      res.writeHead(status === 200 ? 500 : status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ERROR', error: `Unknown API Key ${url.searchParams.get('apiKey')}` }));
    }
    const prices = state.calls === 1 ? base : moved;
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    const tickers = Object.entries(prices).map(([ticker, p]) => ({
      ticker,
      lastTrade: p === null ? { i: '', p: 0, s: 0, t: 0, x: 0 }
        : { p, s: 100, x: 4, t: Number(nowNs - BigInt((ageSec[ticker] ?? 3) * 1e9)) },
      lastQuote: { p: p ?? 0, P: p ?? 0, t: Number(nowNs) },
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'OK', count: tickers.length, tickers }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

const silent = { info() {}, warn() {} };

async function boot({ massive, storeKind = 'memory', databaseUrl, marketOpen = () => true, cfgExtra = {} }) {
  const cfg = {
    serviceKey: 'svc-key', massiveKey: KEY, massiveBase: massive.url, massiveTimeoutMs: 5000,
    waitSec: 300, thresholdPct: 0.5, maxTradeAgeSec: 120, maxInFlight: 2,
    allowWaitOverride: true, storeKind, databaseUrl, ...cfgExtra,
  };
  const store = await createStore({ kind: storeKind, databaseUrl });
  if (storeKind === 'postgres') await wipe(databaseUrl);
  const app = await createApp({ cfg, store, log: silent, marketOpen });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, body, key = 'svc-key') => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { app, call, store };
}

const poll = async (call, id, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const r = await call('GET', `/pick/${id}`);
    if (r.body.status !== 'pending' || Date.now() > end) return r;
    await new Promise((x) => setTimeout(x, 25));
  }
};

const UNIVERSE = [
  { symbol: 'UPL', side: 'long' }, { symbol: 'UPS', side: 'short' },
  { symbol: 'DNS', side: 'short' }, { symbol: 'DNL', side: 'long' },
  { symbol: 'FLAT', side: 'long' }, { symbol: 'OLD', side: 'long' }, { symbol: 'NOTRADE', side: 'long' },
];
const BASE = { UPL: 100, UPS: 100, DNS: 100, DNL: 100, FLAT: 100, OLD: 100, NOTRADE: null, EXTRA: 50 };
const MOVED = { UPL: 101, UPS: 101, DNS: 98.5, DNL: 98.5, FLAT: 100.1, OLD: 110, NOTRADE: null, EXTRA: 60 };

const variants = [['memory', {}]];
if (process.env.TEST_DATABASE_URL) variants.push(['postgres', { storeKind: 'postgres', databaseUrl: process.env.TEST_DATABASE_URL }]);

for (const [name, opts] of variants) {
  test(`[${name}] full flow: universe -> pick -> best confirmed stock in its own direction`, async () => {
    const massive = await fakeMassive({ base: BASE, moved: MOVED, ageSec: { OLD: 900 } });
    const { app, call } = await boot({ massive, ...opts });
    try {
      // Morning list. Bad rows are refused, good ones stored.
      const u = await call('POST', '/universe', { symbols: [...UNIVERSE, { symbol: 'NODIR' }] });
      assert.equal(u.status, 200);
      assert.equal(u.body.accepted, 7);
      assert.equal(u.body.rejected, 1);
      assert.equal(u.body.long, 5);
      assert.equal(u.body.short, 2);

      // DART asks. Answer comes back later, not at once.
      const t = Date.now();
      const started = await call('POST', '/pick', { waitSeconds: 0.4, exclude: [], limit: 3 });
      assert.equal(started.status, 202);
      assert.equal(started.body.status, 'pending');
      assert.equal(started.body.universeSize, 7);
      const early = await call('GET', `/pick/${started.body.id}`);
      assert.equal(early.body.status, 'pending');
      assert.equal(early.body.winner, undefined);

      const done = await poll(call, started.body.id);
      const elapsed = Date.now() - t;
      assert.equal(done.body.status, 'ready');
      assert.ok(elapsed >= 380, `waited the configured time (took ${elapsed} ms)`);
      assert.equal(done.body.reason, 'confirmed');
      // DNS (short, fell 1.5%) beats UPL (long, rose 1%). UPS/DNL moved the wrong way; OLD is stale.
      assert.equal(done.body.winner.symbol, 'DNS');
      assert.equal(done.body.winner.movePct, 1.5);
      assert.deepEqual(done.body.candidates.map((c) => c.symbol), ['DNS', 'UPL']);
      assert.equal(massive.state.calls, 2, 'exactly two full-market snapshots per request');

      // Every stock has a recorded decision, skipped ones too.
      const full = await call('GET', `/pick/${started.body.id}?full=1`);
      const by = Object.fromEntries(full.body.results.map((r) => [r.symbol, r.status]));
      assert.deepEqual(by, {
        DNS: 'confirmed', UPL: 'confirmed', UPS: 'rejected', DNL: 'rejected',
        FLAT: 'rejected', OLD: 'stale', NOTRADE: 'no_data',
      });
      assert.equal(full.body.counts.confirmed, 2);
      assert.equal(full.body.counts.stale, 1);
      assert.equal(full.body.counts.no_data, 1);

      const list = await call('GET', '/picks');
      assert.equal(list.body.requests.length, 1);
    } finally { await app.close(); massive.server.close(); }
  });

  test(`[${name}] exclude list skips stocks DART already holds`, async () => {
    const massive = await fakeMassive({ base: BASE, moved: MOVED, ageSec: { OLD: 900 } });
    const { app, call } = await boot({ massive, ...opts });
    try {
      await call('POST', '/universe', { symbols: UNIVERSE });
      const s = await call('POST', '/pick', { waitSeconds: 0.05, exclude: ['dns'] });
      const done = await poll(call, s.body.id);
      assert.equal(done.body.winner.symbol, 'UPL');
      assert.equal(done.body.counts.excluded, 1);
    } finally { await app.close(); massive.server.close(); }
  });

  test(`[${name}] nothing qualifies -> ready with no winner`, async () => {
    const massive = await fakeMassive({ base: BASE, moved: { ...BASE, UPL: 100.2, DNS: 99.9 } });
    const { app, call } = await boot({ massive, ...opts });
    try {
      await call('POST', '/universe', { symbols: UNIVERSE });
      const s = await call('POST', '/pick', { waitSeconds: 0.05 });
      const done = await poll(call, s.body.id);
      assert.equal(done.body.status, 'ready');
      assert.equal(done.body.winner, null);
      assert.equal(done.body.reason, 'none_confirmed');
    } finally { await app.close(); massive.server.close(); }
  });

  test(`[${name}] Massive fails mid-request -> failed, no winner, key never leaked`, async () => {
    const massive = await fakeMassive({ base: BASE, moved: MOVED, failOnCall: 2 });
    const { app, call } = await boot({ massive, ...opts });
    try {
      await call('POST', '/universe', { symbols: UNIVERSE });
      const s = await call('POST', '/pick', { waitSeconds: 0.05 });
      const done = await poll(call, s.body.id);
      // call 2 fails, the single automatic retry is call 3 and succeeds, so this still completes
      assert.equal(done.body.status, 'ready');
      assert.equal(massive.state.calls, 3);
    } finally { await app.close(); massive.server.close(); }
  });

  test(`[${name}] rejected key -> failed, and the key text never appears in the answer`, async () => {
    const massive = await fakeMassive({ base: BASE, moved: MOVED, status: 401 });
    const { app, call } = await boot({ massive, ...opts });
    try {
      await call('POST', '/universe', { symbols: UNIVERSE });
      const s = await call('POST', '/pick', { waitSeconds: 0.05 });
      const done = await poll(call, s.body.id);
      assert.equal(done.body.status, 'failed');
      assert.equal(done.body.winner, null);
      assert.ok(!JSON.stringify(done.body).includes(KEY), 'key must not leak');
      assert.match(done.body.error, /401/);
    } finally { await app.close(); massive.server.close(); }
  });

  test(`[${name}] guards: auth, market closed, no list, busy, append`, async () => {
    const massive = await fakeMassive({ base: BASE, moved: MOVED });
    let open = true;
    const { app, call } = await boot({ massive, marketOpen: () => open, cfgExtra: { maxInFlight: 1 }, ...opts });
    try {
      assert.equal((await call('POST', '/pick', {}, 'wrong')).status, 401);
      assert.equal((await call('GET', '/universe', undefined, '')).status, 401);
      assert.equal((await call('GET', '/health', undefined, '')).status, 200); // health needs no key

      const noList = await call('POST', '/pick', { waitSeconds: 0.05 });
      assert.equal(noList.status, 409);
      assert.equal(noList.body.error, 'no_universe');

      await call('POST', '/universe', { symbols: UNIVERSE.slice(0, 3) });
      const more = await call('POST', '/universe', { symbols: UNIVERSE.slice(3), append: true });
      assert.equal(more.body.total, 7); // append added to the day's list

      open = false;
      const closed = await call('POST', '/pick', { waitSeconds: 0.05 });
      assert.equal(closed.status, 409);
      assert.equal(closed.body.error, 'market_closed');
      open = true;

      const a = await call('POST', '/pick', { waitSeconds: 0.5 });
      assert.equal(a.status, 202);
      const b = await call('POST', '/pick', { waitSeconds: 0.5 });
      assert.equal(b.status, 429);
      assert.equal(b.body.error, 'busy');
      await poll(call, a.body.id);

      assert.equal((await call('GET', '/pick/00000000-0000-0000-0000-000000000000')).status, 404);
      assert.equal(massive.state.calls, 2, 'refused requests made no Massive calls');
    } finally { await app.close(); massive.server.close(); }
  });

  test(`[${name}] a restart marks unfinished requests failed`, async () => {
    const massive = await fakeMassive({ base: BASE, moved: MOVED });
    const store = await createStore({ kind: opts.storeKind ?? 'memory', databaseUrl: opts.databaseUrl });
    if (opts.storeKind === 'postgres') await wipe(opts.databaseUrl);
    await store.createRequest({ id: 'stuck-1', tradeDate: '2026-10-28', createdAt: Date.now(), waitSec: 300, threshold: 0.5, exclude: [] });
    const app = await createApp({ cfg: { serviceKey: 'k', massiveKey: KEY, massiveBase: massive.url, maxInFlight: 1 }, store, log: silent });
    try {
      const r = await store.getRequest('stuck-1');
      assert.equal(r.status, 'failed');
      assert.match(r.error, /restarted/);
    } finally { await app.close(); massive.server.close(); }
  });
}

test('snapshot client: scrubs the key from errors and does not retry a rejected key', async () => {
  const massive = await fakeMassive({ base: BASE, moved: MOVED, status: 403 });
  try {
    await assert.rejects(
      fetchSnapshot({ key: KEY, base: massive.url, timeoutMs: 2000 }),
      (e) => e instanceof MassiveError && !e.message.includes(KEY) && /403/.test(e.message),
    );
    assert.equal(massive.state.calls, 1, 'a rejected key is not retried');
    await assert.rejects(fetchSnapshot({ key: '', base: massive.url }), /MASSIVE_API_KEY/);
  } finally { massive.server.close(); }
});
