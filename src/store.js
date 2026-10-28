import fs from 'node:fs';
import pg from 'pg';

// Two interchangeable stores. Postgres is the real one. The memory store lets
// the tests (and a quick local try-out) run without a database.

export async function createStore({ kind = 'postgres', databaseUrl } = {}) {
  if (kind === 'memory') return createMemoryStore();
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (or set STORE=memory for testing only)');
  return createPgStore(databaseUrl);
}

// ---------------------------------------------------------------- postgres
async function createPgStore(databaseUrl) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    ssl: process.env.PGSSL === 'disable' ? false : undefined,
  });
  const sql = fs.readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);

  const reqRow = (r) => ({
    id: r.id, tradeDate: r.trade_date, status: r.status,
    createdAt: r.created_at, t0: r.t0, t1: r.t1, readyAt: r.ready_at,
    waitSec: Number(r.wait_sec), threshold: Number(r.threshold), exclude: r.exclude,
    winner: r.winner, error: r.error, counts: r.counts, candidates: r.candidates,
  });

  return {
    kind: 'postgres',

    async saveUniverse(date, items, { append = false } = {}) {
      if (!append) await pool.query('DELETE FROM universe WHERE trade_date = $1', [date]);
      await pool.query(
        `INSERT INTO universe (trade_date, symbol, side, atr14, prev_close)
         SELECT $1, s, d, a, p FROM unnest($2::text[], $3::text[], $4::numeric[], $5::numeric[]) AS t(s, d, a, p)
         ON CONFLICT (trade_date, symbol) DO UPDATE
           SET side = EXCLUDED.side, atr14 = EXCLUDED.atr14, prev_close = EXCLUDED.prev_close`,
        [date, items.map((i) => i.symbol), items.map((i) => i.side),
          items.map((i) => i.atr14 ?? null), items.map((i) => i.prevClose ?? null)],
      );
    },

    async loadUniverse(date) {
      const r = await pool.query(
        `SELECT symbol, side, atr14::float AS "atr14", prev_close::float AS "prevClose"
         FROM universe WHERE trade_date = $1 ORDER BY symbol`, [date]);
      return r.rows;
    },

    async createRequest(q) {
      await pool.query(
        `INSERT INTO requests (id, trade_date, status, created_at, wait_sec, threshold, exclude)
         VALUES ($1, $2, 'pending', to_timestamp($3 / 1000.0), $4, $5, $6)`,
        [q.id, q.tradeDate, q.createdAt, q.waitSec, q.threshold, q.exclude]);
    },

    async updateRequest(id, p) {
      await pool.query(
        `UPDATE requests SET
           status = COALESCE($2, status),
           t0 = COALESCE(to_timestamp($3 / 1000.0), t0),
           t1 = COALESCE(to_timestamp($4 / 1000.0), t1),
           ready_at = COALESCE(to_timestamp($5 / 1000.0), ready_at),
           winner = COALESCE($6, winner),
           error = COALESCE($7, error),
           counts = COALESCE($8::jsonb, counts),
           candidates = COALESCE($9::jsonb, candidates)
         WHERE id = $1`,
        [id, p.status ?? null, p.t0 ?? null, p.t1 ?? null, p.readyAt ?? null, p.winner ?? null,
          p.error ?? null, p.counts ? JSON.stringify(p.counts) : null,
          p.candidates ? JSON.stringify(p.candidates) : null]);
    },

    async getRequest(id) {
      const r = await pool.query('SELECT * FROM requests WHERE id = $1', [id]);
      return r.rows[0] ? reqRow(r.rows[0]) : null;
    },

    async listRequests(date, limit = 50) {
      const r = await pool.query(
        'SELECT * FROM requests WHERE trade_date = $1 ORDER BY created_at DESC LIMIT $2', [date, limit]);
      return r.rows.map(reqRow);
    },

    /** After a restart, requests that were mid-wait can never finish. */
    async failPending(reason) {
      const r = await pool.query(
        `UPDATE requests SET status = 'failed', error = $1, ready_at = now()
         WHERE status = 'pending'`, [reason]);
      return r.rowCount;
    },

    async savePrices(requestId, phase, byTicker, symbols) {
      const rows = symbols.map((s) => [s, byTicker.get(s)]).filter(([, p]) => p);
      if (!rows.length) return;
      await pool.query(
        `INSERT INTO snapshot_prices (request_id, phase, symbol, price, trade_ts, bid, ask)
         SELECT $1, $2, s, p, CASE WHEN t IS NULL THEN NULL ELSE to_timestamp(t / 1000.0) END, b, a
         FROM unnest($3::text[], $4::numeric[], $5::bigint[], $6::numeric[], $7::numeric[]) AS x(s, p, t, b, a)
         ON CONFLICT DO NOTHING`,
        [requestId, phase, rows.map(([s]) => s), rows.map(([, p]) => p.price),
          rows.map(([, p]) => p.tradeTs), rows.map(([, p]) => p.bid), rows.map(([, p]) => p.ask)]);
    },

    async saveResults(requestId, rows) {
      if (!rows.length) return;
      await pool.query(
        `INSERT INTO results (request_id, symbol, side, p0, p1, move_pct, status, rank)
         SELECT $1, s, d, p0, p1, m, st, rk
         FROM unnest($2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::text[], $8::int[])
              AS x(s, d, p0, p1, m, st, rk)
         ON CONFLICT (request_id, symbol) DO UPDATE
           SET p0 = EXCLUDED.p0, p1 = EXCLUDED.p1, move_pct = EXCLUDED.move_pct,
               status = EXCLUDED.status, rank = EXCLUDED.rank`,
        [requestId, rows.map((r) => r.symbol), rows.map((r) => r.side), rows.map((r) => r.p0),
          rows.map((r) => r.p1), rows.map((r) => r.movePct), rows.map((r) => r.status),
          rows.map((r) => r.rank ?? null)]);
    },

    async getResults(requestId) {
      const r = await pool.query(
        `SELECT symbol, side, p0::float, p1::float, move_pct::float AS "movePct", status, rank
         FROM results WHERE request_id = $1 ORDER BY rank NULLS LAST, symbol`, [requestId]);
      return r.rows;
    },

    async close() { await pool.end(); },
  };
}

// ------------------------------------------------------------------ memory
function createMemoryStore() {
  const universe = new Map();   // date -> Map(symbol -> item)
  const requests = new Map();
  const prices = new Map();     // `${id}|${phase}` -> Map
  const results = new Map();

  return {
    kind: 'memory',
    async saveUniverse(date, items, { append = false } = {}) {
      if (!append || !universe.has(date)) universe.set(date, new Map());
      const m = universe.get(date);
      for (const i of items) m.set(i.symbol, { atr14: null, prevClose: null, ...i });
    },
    async loadUniverse(date) {
      return [...(universe.get(date)?.values() ?? [])].sort((a, b) => a.symbol.localeCompare(b.symbol));
    },
    async createRequest(q) {
      requests.set(q.id, {
        id: q.id, tradeDate: q.tradeDate, status: 'pending', createdAt: new Date(q.createdAt),
        t0: null, t1: null, readyAt: null, waitSec: q.waitSec, threshold: q.threshold,
        exclude: q.exclude, winner: null, error: null, counts: null, candidates: null,
      });
    },
    async updateRequest(id, p) {
      const r = requests.get(id);
      if (!r) return;
      for (const k of ['status', 'winner', 'error', 'counts', 'candidates']) if (p[k] != null) r[k] = p[k];
      for (const k of ['t0', 't1', 'readyAt']) if (p[k] != null) r[k] = new Date(p[k]);
    },
    async getRequest(id) { return requests.get(id) ?? null; },
    async listRequests(date, limit = 50) {
      return [...requests.values()].filter((r) => r.tradeDate === date)
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    },
    async failPending(reason) {
      let n = 0;
      for (const r of requests.values()) {
        if (r.status === 'pending') { r.status = 'failed'; r.error = reason; r.readyAt = new Date(); n++; }
      }
      return n;
    },
    async savePrices(requestId, phase, byTicker, symbols) {
      const m = new Map();
      for (const s of symbols) if (byTicker.has(s)) m.set(s, byTicker.get(s));
      prices.set(`${requestId}|${phase}`, m);
    },
    async saveResults(requestId, rows) { results.set(requestId, rows.map((r) => ({ ...r }))); },
    async getResults(requestId) { return results.get(requestId) ?? []; },
    async close() {},
  };
}
