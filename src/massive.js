// Massive (formerly Polygon.io) full-market snapshot client.
// One call returns every US stock with its last trade and quote. The key is
// sent in the URL, so errors are scrubbed before they are logged or returned.

/** Massive mixes nanosecond and millisecond timestamps; guess the unit by size. */
export function toMs(ts) {
  if (ts === null || ts === undefined) return null;
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e17) return Math.round(n / 1e6);  // nanoseconds
  if (n > 1e14) return Math.round(n / 1e3);  // microseconds
  if (n > 1e11) return Math.round(n);        // milliseconds
  return Math.round(n * 1000);               // seconds
}

/** The price DART would have seen: the last trade. No trade today -> null. */
export function extractPrice(t) {
  const trade = t?.lastTrade;
  const price = trade?.p;
  if (!(price > 0)) return null;
  const q = t?.lastQuote;
  return {
    price,
    tradeTs: toMs(trade.t),
    bid: q?.p > 0 ? q.p : null,
    ask: q?.P > 0 ? q.P : null,
  };
}

export class MassiveError extends Error {}

function scrub(text, key) {
  return key ? String(text).split(key).join('***') : String(text);
}

/**
 * Fetch the whole-market snapshot.
 * Returns { byTicker: Map(symbol -> {price, tradeTs, bid, ask}), count, fetchedAt, elapsedMs }.
 */
export async function fetchSnapshot({ key, base, timeoutMs = 60_000, fetchImpl = fetch, retries = 1 }) {
  if (!key) throw new MassiveError('MASSIVE_API_KEY is not set');
  const url = `${base}/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${encodeURIComponent(key)}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = scrub((await res.text()).slice(0, 200), key);
        const hint = res.status === 401 || res.status === 403
          ? ' (key rejected or plan does not include snapshots)' : '';
        const err = new MassiveError(`Massive answered HTTP ${res.status}${hint}: ${body}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      if (data.status !== 'OK' && data.status !== 'DELAYED') {
        throw new MassiveError(`Massive status ${data.status}: ${scrub(data.error ?? '', key)}`);
      }
      const byTicker = new Map();
      for (const t of data.tickers ?? []) {
        const p = extractPrice(t);
        if (p && t.ticker) byTicker.set(t.ticker, p);
      }
      const fetchedAt = Date.now();
      return { byTicker, count: (data.tickers ?? []).length, fetchedAt, elapsedMs: fetchedAt - started };
    } catch (e) {
      lastErr = e instanceof MassiveError ? e : new MassiveError(scrub(e.message ?? e, key));
      // A rejected key will not fix itself on retry; anything else might.
      if (lastErr.status === 401 || lastErr.status === 403 || lastErr.status === 400) break;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}
