import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, favourableMovePct, normSide } from '../src/engine.js';
import { toMs, extractPrice } from '../src/massive.js';
import { parseUniverse } from '../src/server.js';
import { inSession, tradeDate } from '../src/time.js';

const snap = (fetchedAt, prices) => ({
  fetchedAt,
  byTicker: new Map(Object.entries(prices).map(([s, [price, ageSec = 5]]) =>
    [s, { price, tradeTs: fetchedAt - ageSec * 1000, bid: null, ask: null }])),
});
const T0 = 1_800_000_000_000;

test('favourable move uses the stock\'s own direction', () => {
  assert.equal(favourableMovePct('long', 100, 101), 1);
  assert.equal(favourableMovePct('long', 100, 99), -1);
  assert.equal(favourableMovePct('short', 100, 99), 1);
  assert.equal(favourableMovePct('short', 100, 101), -1);
});

test('normSide accepts long/short/buy/sell only', () => {
  assert.equal(normSide(' LONG '), 'long');
  assert.equal(normSide('sell'), 'short');
  assert.equal(normSide('up'), null);
  assert.equal(normSide(undefined), null);
});

test('evaluate: direction is supplied, never inferred', () => {
  const universe = [
    { symbol: 'UPL', side: 'long' },   // rose 1%    -> confirmed
    { symbol: 'UPS', side: 'short' },  // rose 1%    -> wrong way, rejected
    { symbol: 'DNS', side: 'short' },  // fell 2%    -> confirmed (best)
    { symbol: 'DNL', side: 'long' },   // fell 2%    -> wrong way, rejected
    { symbol: 'FLAT', side: 'long' },  // 0.2%       -> rejected (below threshold)
    { symbol: 'EDGE', side: 'long' },  // exactly 0.5% -> confirmed
  ];
  const first = snap(T0, { UPL: [100], UPS: [100], DNS: [100], DNL: [100], FLAT: [100], EDGE: [100] });
  const second = snap(T0 + 300_000, { UPL: [101], UPS: [101], DNS: [98], DNL: [98], FLAT: [100.2], EDGE: [100.5] });
  const r = evaluate({ universe, first, second, thresholdPct: 0.5, maxTradeAgeSec: 120 });
  const by = Object.fromEntries(r.rows.map((x) => [x.symbol, x]));
  assert.equal(by.UPL.status, 'confirmed');
  assert.equal(by.UPS.status, 'rejected');
  assert.equal(by.DNS.status, 'confirmed');
  assert.equal(by.DNL.status, 'rejected');
  assert.equal(by.FLAT.status, 'rejected');
  assert.equal(by.EDGE.status, 'confirmed');
  assert.deepEqual(r.confirmed.map((x) => x.symbol), ['DNS', 'UPL', 'EDGE']); // ranked by move size
  assert.equal(r.winner.symbol, 'DNS');
  assert.equal(r.winner.movePct, 2);
  assert.equal(r.winner.rank, 1);
  assert.deepEqual(r.counts, { universe: 6, confirmed: 3, rejected: 3, stale: 0, no_data: 0, excluded: 0, compared: 6 });
});

test('evaluate: stale, missing and excluded stocks are skipped, never guessed', () => {
  const universe = [
    { symbol: 'OLD', side: 'long' }, { symbol: 'NEW', side: 'long' },
    { symbol: 'GONE', side: 'long' }, { symbol: 'HELD', side: 'long' },
  ];
  const first = snap(T0, { OLD: [100, 600], NEW: [100], HELD: [100] });          // OLD last traded 10 min ago
  const second = snap(T0 + 300_000, { OLD: [105, 5], NEW: [101], HELD: [110] }); // GONE absent from both
  const r = evaluate({ universe, first, second, thresholdPct: 0.5, maxTradeAgeSec: 120, exclude: ['held'] });
  const by = Object.fromEntries(r.rows.map((x) => [x.symbol, x.status]));
  assert.deepEqual(by, { OLD: 'stale', NEW: 'confirmed', GONE: 'no_data', HELD: 'excluded' });
  assert.equal(r.winner.symbol, 'NEW');
});

test('evaluate: nothing qualifies -> no winner', () => {
  const r = evaluate({
    universe: [{ symbol: 'A', side: 'long' }],
    first: snap(T0, { A: [100] }), second: snap(T0 + 1, { A: [100.1] }),
    thresholdPct: 0.5, maxTradeAgeSec: 120,
  });
  assert.equal(r.winner, null);
  assert.equal(r.confirmed.length, 0);
});

test('toMs handles ns, ms and seconds; extractPrice needs a trade', () => {
  assert.equal(toMs(1793201658486041944), 1793201658486);
  assert.equal(toMs(1793201580000), 1793201580000);
  assert.equal(toMs(1793201580), 1793201580000);
  assert.equal(toMs(0), null);
  assert.equal(toMs(null), null);
  assert.equal(extractPrice({ ticker: 'X', lastTrade: { i: '', p: 0, s: 0, t: 0 } }), null);
  assert.equal(extractPrice({ ticker: 'X' }), null);
  const p = extractPrice({ lastTrade: { p: 402.14, t: 1793201658486041944 }, lastQuote: { p: 402.1, P: 402.18 } });
  assert.deepEqual(p, { price: 402.14, tradeTs: 1793201658486, bid: 402.1, ask: 402.18 });
});

test('parseUniverse requires a direction on every stock', () => {
  const r = parseUniverse({ symbols: [
    { symbol: 'aapl', side: 'long' }, { symbol: 'TSLA', side: 'SHORT', atr14: '3.2' },
    { symbol: 'MSFT' }, { symbol: 'bad symbol!', side: 'long' }, { symbol: 'AAPL', side: 'short' },
  ] });
  assert.deepEqual(r.items.map((i) => [i.symbol, i.side]), [['AAPL', 'short'], ['TSLA', 'short']]); // last one wins
  assert.equal(r.items[1].atr14, 3.2);
  assert.equal(r.rejected.length, 2);
  assert.ok(parseUniverse({ symbols: 'AAPL' }).error);
});

test('session: weekdays 9:30-16:00 Eastern only', () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(inSession(at('2026-10-28T13:29:00Z')), false); // 9:29 ET (EDT)
  assert.equal(inSession(at('2026-10-28T13:30:00Z')), true);  // 9:30 ET
  assert.equal(inSession(at('2026-10-28T19:59:00Z')), true);  // 15:59 ET
  assert.equal(inSession(at('2026-10-28T20:00:00Z')), false); // 16:00 ET
  assert.equal(inSession(at('2026-10-31T15:00:00Z')), false); // Saturday
  assert.equal(tradeDate(at('2026-10-28T03:00:00Z')), '2026-10-27'); // still the 27th in New York
});
