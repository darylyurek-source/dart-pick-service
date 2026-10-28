// One request from DART:
//   1. snapshot all prices now (P0)
//   2. wait the configured time (5 minutes)
//   3. snapshot again (P1)
//   4. return the best stock that moved the threshold in ITS OWN direction
//
// Fail closed: if anything goes wrong, or nothing qualifies, the answer has no
// winner. DART should leave the position empty and ask again later; it must
// never fall back to buying at once.

import crypto from 'node:crypto';
import { evaluate } from './engine.js';
import { fetchSnapshot } from './massive.js';
import { inSession, tradeDate } from './time.js';

export class PickError extends Error {
  constructor(code, message, http = 400) { super(message); this.code = code; this.http = http; }
}

export function createPicker({
  cfg, store, log = console,
  snapshot = (opts) => fetchSnapshot(opts),     // swappable in tests
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  marketOpen = inSession,
}) {
  const inFlight = new Map(); // id -> promise (so shutdown/tests can await)
  const stats = { lastSnapshotAt: null, lastSnapshotMs: null, lastSnapshotCount: null };

  const take = async () => {
    const snap = await snapshot({
      key: cfg.massiveKey, base: cfg.massiveBase, timeoutMs: cfg.massiveTimeoutMs,
    });
    stats.lastSnapshotAt = snap.fetchedAt;
    stats.lastSnapshotMs = snap.elapsedMs;
    stats.lastSnapshotCount = snap.count;
    return snap;
  };

  async function run(id, universe, { waitSec, thresholdPct, exclude, limit }) {
    try {
      const symbols = universe.map((u) => u.symbol);

      const first = await take();
      await store.savePrices(id, 0, first.byTicker, symbols);
      await store.updateRequest(id, { t0: first.fetchedAt });

      // Count the wait from when the first snapshot finished, not from when it started.
      const waitMs = Math.max(0, first.fetchedAt + waitSec * 1000 - now());
      await sleep(waitMs);

      const second = await take();
      await store.savePrices(id, 1, second.byTicker, symbols);

      const result = evaluate({
        universe, first, second, thresholdPct, maxTradeAgeSec: cfg.maxTradeAgeSec, exclude,
      });
      await store.saveResults(id, result.rows);

      const candidates = result.confirmed.slice(0, limit).map((r) => ({
        symbol: r.symbol, side: r.side, p0: r.p0, p1: r.p1, movePct: r.movePct, rank: r.rank,
      }));
      await store.updateRequest(id, {
        status: 'ready',
        t1: second.fetchedAt,
        readyAt: now(),
        winner: result.winner?.symbol ?? null,
        counts: { ...result.counts, actualWaitSec: Math.round((second.fetchedAt - first.fetchedAt) / 100) / 10 },
        candidates,
      });
      log.info?.(`pick ${id}: ${result.winner ? `${result.winner.symbol} ${result.winner.movePct}%` : 'none confirmed'} `
        + `(${result.counts.confirmed} confirmed of ${result.counts.compared} compared)`);
    } catch (e) {
      log.warn?.(`pick ${id} failed: ${e.message}`);
      try { await store.updateRequest(id, { status: 'failed', error: String(e.message).slice(0, 500), readyAt: now() }); }
      catch (e2) { log.warn?.('could not record failure', e2.message); }
    }
  }

  return {
    stats,
    inFlightCount: () => inFlight.size,

    /** Start a request. Returns at once; the answer is ready after the wait. */
    async start({ exclude = [], limit = 5, waitSec, thresholdPct } = {}) {
      const t = now();
      if (!marketOpen(t)) {
        throw new PickError('market_closed', 'The market is closed. No pick is possible.', 409);
      }
      if (inFlight.size >= cfg.maxInFlight) {
        throw new PickError('busy', `Too many requests in progress (max ${cfg.maxInFlight}). Try again shortly.`, 429);
      }
      const date = tradeDate(t);
      const universe = (await store.loadUniverse(date)).map((u) => ({ symbol: u.symbol, side: u.side }));
      if (!universe.length) {
        throw new PickError('no_universe', `No stock list for ${date}. Send POST /universe first.`, 409);
      }

      const wait = cfg.allowWaitOverride && waitSec != null ? Number(waitSec) : cfg.waitSec;
      const thr = thresholdPct != null && cfg.allowWaitOverride ? Number(thresholdPct) : cfg.thresholdPct;
      const id = crypto.randomUUID();
      const ex = exclude.map((s) => String(s).toUpperCase());

      await store.createRequest({
        id, tradeDate: date, createdAt: t, waitSec: wait, threshold: thr, exclude: ex,
      });
      const job = run(id, universe, { waitSec: wait, thresholdPct: thr, exclude: ex, limit })
        .finally(() => inFlight.delete(id));
      inFlight.set(id, job);

      return { id, status: 'pending', readyAt: t + wait * 1000 + 5000, waitSec: wait, universeSize: universe.length };
    },

    /** Wait for every running request (tests, graceful shutdown). */
    async idle() { await Promise.all([...inFlight.values()]); },
  };
}
