import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { cfg as defaultCfg } from './config.js';
import { createStore } from './store.js';
import { createPicker, PickError } from './picker.js';
import { normSide } from './engine.js';
import { inSession, tradeDate } from './time.js';

const FEATURE_VERSION = 'confirm-v1';
const MAX_BODY = 2_000_000; // bytes; 1,120 symbols is about 100 KB

const defaultLog = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), ...a),
};

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/** Validate the morning list. Every stock needs its own direction. */
export function parseUniverse(body) {
  const items = new Map();
  const rejected = [];
  if (!Array.isArray(body?.symbols)) return { items: [], rejected: [], error: 'symbols must be an array' };
  for (const raw of body.symbols) {
    const symbol = String(raw?.symbol ?? '').trim().toUpperCase();
    const side = normSide(raw?.side);
    if (!SYMBOL_RE.test(symbol)) { rejected.push({ symbol: raw?.symbol ?? null, reason: 'bad symbol' }); continue; }
    if (!side) { rejected.push({ symbol, reason: 'side must be long or short' }); continue; }
    const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    items.set(symbol, { symbol, side, atr14: num(raw.atr14), prevClose: num(raw.prevClose) }); // last one wins
  }
  return { items: [...items.values()], rejected };
}

const publicRequest = (r, results) => {
  const out = {
    id: r.id,
    status: r.status,
    tradeDate: r.tradeDate instanceof Date ? r.tradeDate.toISOString().slice(0, 10) : r.tradeDate,
    waitSec: r.waitSec,
    thresholdPct: r.threshold,
    exclude: r.exclude,
    t0: r.t0 ? new Date(r.t0).toISOString() : null,
    t1: r.t1 ? new Date(r.t1).toISOString() : null,
  };
  if (r.status === 'ready') {
    out.winner = r.candidates?.[0] ?? null;
    out.reason = out.winner ? 'confirmed' : 'none_confirmed';
    out.candidates = r.candidates ?? [];
    out.counts = r.counts;
  } else if (r.status === 'failed') {
    out.winner = null;
    out.reason = 'failed';
    out.error = r.error;
  }
  if (results) out.results = results;
  return out;
};

export async function createApp({
  cfg = defaultCfg, log = defaultLog, store, picker, now = () => Date.now(), marketOpen = inSession,
} = {}) {
  store ??= await createStore({ kind: cfg.storeKind, databaseUrl: cfg.databaseUrl });
  picker ??= createPicker({ cfg, store, log, marketOpen });

  const interrupted = await store.failPending('service restarted before the request finished');
  if (interrupted) log.warn?.(`${interrupted} unfinished request(s) from before the restart were marked failed`);

  const authorised = (req) => {
    if (!cfg.serviceKey) return false; // refuse to run open
    const got = Buffer.from(String(req.headers['x-api-key'] ?? ''));
    const want = Buffer.from(cfg.serviceKey);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };

  const send = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };

  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new PickError('too_large', 'Body too large', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new PickError('bad_json', 'Body is not valid JSON', 400)); }
    });
    req.on('error', reject);
  });

  const meta = () => ({
    asof: new Date(now()).toISOString(),
    featureVersion: FEATURE_VERSION,
    marketOpen: marketOpen(now()),
  });

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && path === '/health') {
      const date = tradeDate(now());
      const universe = await store.loadUniverse(date);
      return send(res, 200, {
        ok: true,
        ...meta(),
        store: store.kind,
        massiveKeySet: Boolean(cfg.massiveKey),
        universeToday: universe.length,
        inFlight: picker.inFlightCount(),
        lastSnapshotAt: picker.stats.lastSnapshotAt ? new Date(picker.stats.lastSnapshotAt).toISOString() : null,
        lastSnapshotMs: picker.stats.lastSnapshotMs,
        lastSnapshotCount: picker.stats.lastSnapshotCount,
      });
    }

    if (!authorised(req)) return send(res, 401, { error: 'unauthorised' });

    // Morning list: [{symbol, side, atr14?, prevClose?}, ...]
    if (req.method === 'POST' && path === '/universe') {
      const body = await readJson(req);
      const { items, rejected, error } = parseUniverse(body);
      if (error) return send(res, 400, { error });
      if (!items.length) return send(res, 400, { error: 'no valid symbols', rejected: rejected.slice(0, 20) });
      const date = body.date ?? tradeDate(now());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: 'date must be YYYY-MM-DD' });
      await store.saveUniverse(date, items, { append: body.append === true });
      const all = await store.loadUniverse(date);
      return send(res, 200, {
        ok: true, date, accepted: items.length, rejected: rejected.length,
        rejectedExamples: rejected.slice(0, 20), total: all.length,
        long: all.filter((u) => u.side === 'long').length, short: all.filter((u) => u.side === 'short').length,
        meta: meta(),
      });
    }

    if (req.method === 'GET' && path === '/universe') {
      const date = url.searchParams.get('date') ?? tradeDate(now());
      const all = await store.loadUniverse(date);
      return send(res, 200, {
        date, total: all.length,
        long: all.filter((u) => u.side === 'long').length, short: all.filter((u) => u.side === 'short').length,
        symbols: url.searchParams.get('list') === '1' ? all : undefined,
      });
    }

    // DART asks for a stock. Returns at once with an id; the answer is ready after the wait.
    if (req.method === 'POST' && path === '/pick') {
      const body = await readJson(req);
      const limit = Math.min(Math.max(Number(body.limit ?? 5) || 5, 1), 50);
      const started = await picker.start({
        exclude: Array.isArray(body.exclude) ? body.exclude : [],
        limit,
        waitSec: body.waitSeconds,
        thresholdPct: body.thresholdPct,
      });
      return send(res, 202, {
        ...started,
        readyAt: new Date(started.readyAt).toISOString(),
        pollUrl: `/pick/${started.id}`,
        meta: meta(),
      });
    }

    const one = path.match(/^\/pick\/([0-9a-f-]{36})$/);
    if (req.method === 'GET' && one) {
      const r = await store.getRequest(one[1]);
      if (!r) return send(res, 404, { error: 'unknown request id' });
      const results = url.searchParams.get('full') === '1' ? await store.getResults(r.id) : undefined;
      return send(res, 200, { ...publicRequest(r, results), meta: meta() });
    }

    if (req.method === 'GET' && path === '/picks') {
      const date = url.searchParams.get('date') ?? tradeDate(now());
      const rows = await store.listRequests(date, 100);
      return send(res, 200, { date, requests: rows.map((r) => publicRequest(r)), meta: meta() });
    }

    return send(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (e instanceof PickError) return send(res, e.http, { error: e.code, message: e.message });
      log.warn?.('request error', e.stack ?? e.message);
      send(res, 500, { error: 'internal error' });
    });
  });

  return {
    server, store, picker,
    async close() { await picker.idle(); server.close(); await store.close(); },
  };
}

// Run as a service: `node src/server.js`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!defaultCfg.serviceKey) { console.error('SERVICE_API_KEY is not set'); process.exit(1); }
  if (!defaultCfg.massiveKey) { console.error('MASSIVE_API_KEY is not set'); process.exit(1); }
  const app = await createApp();
  app.server.listen(defaultCfg.port, () => defaultLog.info(`dart pick service listening on ${defaultCfg.port}`));
  // Do not wait for requests that are mid-5-minute-wait: the host will not give us that long.
  // After a restart they are marked failed, and DART simply asks again.
  const stop = () => { defaultLog.info('shutting down'); app.server.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
