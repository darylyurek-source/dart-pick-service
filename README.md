# DART pick service

A small service with its **own database**, separate from Base44. Each morning
Base44 sends it the day's stock list (about 1,120 stocks, each with its own
direction: long or short). Whenever DART needs a stock, it asks this service.
The service takes a price snapshot of every stock, waits 5 minutes, takes a
second snapshot, and returns the best stock that moved **0.5% or more in its own
direction**. Prices come from Massive (Stocks Advanced, real-time).

Nothing here chooses a direction. Base44 supplies it for every stock.

## What happens on each request

1. DART calls `POST /pick`. The service answers at once with an id and a ready time.
2. It takes snapshot 1 (one call to Massive, all US stocks, a few seconds).
3. It waits 5 minutes, counted from when snapshot 1 finished.
4. It takes snapshot 2, then for each stock works out the move in its own direction:
   long = (P1 - P0) / P0, short = (P0 - P1) / P0.
5. Stocks at 0.5% or more are *confirmed* and ranked by move size, biggest first.
6. DART polls `GET /pick/{id}` and gets the winner (or none).

Every stock in every request is recorded with its decision (confirmed, rejected,
stale, no_data, excluded), so skipped stocks can be studied later.

## What DART should do with the answer

- `status: "pending"` — keep waiting (the answer is ready about 5 minutes after the request).
- `status: "ready"` and `winner` is set — buy that stock in the direction shown (`winner.side`).
- `status: "ready"` and `winner` is `null` (`reason: "none_confirmed"`) — nothing qualified. **Leave the position empty** and ask again later. There is no hurry to fill it.
- `status: "failed"` — something went wrong (Massive unreachable, service restarted). **Leave the position empty**; never buy without a confirmed pick.

The prices returned are snapshot prices. A real fill happens a moment later, so expect a little slippage.

## API

All calls except `/health` need the header `x-api-key: <SERVICE_API_KEY>`.

| Call | What it does |
|---|---|
| `POST /universe` | Body `{"symbols":[{"symbol":"AAPL","side":"long","atr14":3.1,"prevClose":190.2}, ...]}`. `side` is required on every stock (`long` or `short`; `buy`/`sell` also accepted). `atr14` and `prevClose` are optional. Replaces the day's list. Add `"append": true` to send the list in batches. Optional `"date":"YYYY-MM-DD"` (defaults to today in New York). Stocks without a valid side are refused and counted in `rejected`. |
| `POST /pick` | Body `{"exclude":["AAPL","TSLA"], "limit":5}` (both optional). `exclude` = stocks DART already holds. Returns `202 {id, status:"pending", readyAt, pollUrl}`. |
| `GET /pick/{id}` | Status and answer. Add `?full=1` for the decision on every stock. |
| `GET /picks` | Today's requests (add `?date=`). |
| `GET /universe` | Counts for today's list (add `?list=1` for the symbols). |
| `GET /health` | No key needed. Shows market open/closed, today's list size, and the last snapshot's time, speed and stock count. |

A ready answer looks like:

```json
{
  "id": "…", "status": "ready", "reason": "confirmed",
  "winner": {"symbol":"OSW","side":"long","p0":27.07,"p1":27.61,"movePct":2.0,"rank":1},
  "candidates": [ …up to `limit`, best first… ],
  "counts": {"universe":1120,"compared":1098,"confirmed":44,"rejected":1054,"stale":6,"no_data":14,"excluded":2,"actualWaitSec":300.4}
}
```

Errors: `401` wrong key, `409 market_closed` (outside 9:30–16:00 ET, Mon–Fri), `409 no_universe` (no list sent today), `429 busy` (too many requests at once; limit 5).

## Safety rules built in

- **Fails closed.** Any failure gives no winner, never a fallback pick.
- **Stale prices are skipped.** A stock whose last trade is older than 2 minutes (at either snapshot) is marked `stale` and cannot win. On a market holiday every stock is stale, so nothing is returned.
- **Direction is never inferred.** A stock that moved the wrong way for its side is rejected, however big the move.
- **The Massive key never appears** in logs, errors or answers.
- **A restart marks unfinished requests `failed`**, so DART gets a clear answer instead of waiting forever.

## Setup

1. Create a **new** Postgres database (not the one DART uses). Tables are created automatically on start.
2. Set the environment variables (see `.env.example`): `DATABASE_URL`, `SERVICE_API_KEY` (invent a long random string), `MASSIVE_API_KEY` (massive.com/dashboard, Keys).
3. `npm install && npm start`, or use the included `Dockerfile`.
4. Host it anywhere that runs Node 22 or Docker (Render, Google Cloud Run, a small VM). It does not need to run all day: a request that is mid-wait is lost if the host stops it, so keep at least one instance running during market hours.
5. Check `GET /health`: `massiveKeySet` should be true. During market hours, `lastSnapshotCount` shows about 10,000+ stocks after the first request.
6. Send the morning list with `POST /universe`, then try one `POST /pick`.

`npm test` runs 23 tests (16 without a database). To include Postgres, set `TEST_DATABASE_URL` to an empty test database first.

## Things to know

- **Rate:** two Massive calls per request. At about 20 requests a day that is about 40 calls. Massive's paid plans have no call limit.
- **Massive's terms.** The Market Data Terms describe the data as for display use, and non-display or derived use may need a separate licence. Massive support would not give written authorisation. This was decided by the account holder; revisit it before anything beyond this test.
- **Snapshot prices are last trades.** Quiet stocks can show a last trade up to 2 minutes old; older ones are skipped.
- **Holidays** are not in the calendar; the stale-price rule covers them.
- **Not yet run against live Massive inside this service.** The snapshot format was checked by hand against Massive's real responses (13,262 stocks returned in one call; real-time timestamps; 1,670 stocks over $25 and 600,000 volume), and the service was tested end to end against a fake Massive with 13,262 stocks and real Postgres.
- **Testing options:** `ALLOW_WAIT_OVERRIDE=1` lets a request set `waitSeconds` and `thresholdPct` for quick tests. Leave it off in production.
