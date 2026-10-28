// The rule, as pure functions (no network, no clock, no database).
//
//   P0 = price at the first snapshot, P1 = price at the second snapshot.
//   Favourable move = % change in the stock's OWN direction:
//     long  -> (P1 - P0) / P0
//     short -> (P0 - P1) / P0
//   Confirmed when favourable move >= threshold. Ranked by that move, biggest first.
//   The direction comes from Base44; this code never picks a direction.

export const normSide = (s) => {
  const v = String(s ?? '').trim().toLowerCase();
  if (v === 'long' || v === 'buy') return 'long';
  if (v === 'short' || v === 'sell') return 'short';
  return null;
};

export function favourableMovePct(side, p0, p1) {
  const raw = ((p1 - p0) / p0) * 100;
  return side === 'short' ? -raw : raw;
}

const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * @param universe  array of { symbol, side }
 * @param first     { byTicker, fetchedAt }
 * @param second    { byTicker, fetchedAt }
 * @returns { rows, winner, counts }  rows has one entry per universe symbol, with a status:
 *   confirmed | rejected | stale | no_data | excluded
 */
export function evaluate({ universe, first, second, thresholdPct, maxTradeAgeSec, exclude = [] }) {
  const skip = new Set(exclude.map((s) => String(s).toUpperCase()));
  const maxAgeMs = maxTradeAgeSec * 1000;
  const rows = [];

  for (const { symbol, side } of universe) {
    const row = { symbol, side, p0: null, p1: null, movePct: null, status: 'no_data' };
    rows.push(row);
    if (skip.has(symbol)) { row.status = 'excluded'; continue; }

    const a = first.byTicker.get(symbol);
    const b = second.byTicker.get(symbol);
    if (a) row.p0 = a.price;
    if (b) row.p1 = b.price;
    if (!a || !b) continue; // no_data: no trade today in one of the snapshots

    // Old prints would make the "5 minute" move something else; skip, never guess.
    const ageA = a.tradeTs == null ? Infinity : first.fetchedAt - a.tradeTs;
    const ageB = b.tradeTs == null ? Infinity : second.fetchedAt - b.tradeTs;
    if (ageA > maxAgeMs || ageB > maxAgeMs) { row.status = 'stale'; continue; }

    row.movePct = round(favourableMovePct(side, a.price, b.price));
    row.status = row.movePct >= thresholdPct ? 'confirmed' : 'rejected';
  }

  const confirmed = rows
    .filter((r) => r.status === 'confirmed')
    .sort((x, y) => y.movePct - x.movePct || x.symbol.localeCompare(y.symbol));
  confirmed.forEach((r, i) => { r.rank = i + 1; });

  const counts = { universe: rows.length, confirmed: confirmed.length };
  for (const s of ['rejected', 'stale', 'no_data', 'excluded']) {
    counts[s] = rows.filter((r) => r.status === s).length;
  }
  counts.compared = counts.confirmed + counts.rejected;

  return { rows, winner: confirmed[0] ?? null, confirmed, counts };
}
