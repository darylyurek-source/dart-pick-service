const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const cfg = {
  port: num(process.env.PORT, 8080),
  databaseUrl: process.env.DATABASE_URL,
  serviceKey: process.env.SERVICE_API_KEY, // Base44 sends this in the x-api-key header

  // Massive (formerly Polygon.io). Stocks Advanced plan: real-time snapshots.
  massiveKey: process.env.MASSIVE_API_KEY,
  massiveBase: process.env.MASSIVE_BASE_URL ?? 'https://api.massive.com',
  massiveTimeoutMs: num(process.env.MASSIVE_TIMEOUT_MS, 60_000),

  // The rule: wait 5 minutes, then require a 0.5% move in the stock's own direction.
  waitSec: num(process.env.WAIT_SECONDS, 300),
  thresholdPct: num(process.env.GATE_THRESHOLD_PCT, 0.5),

  // A price whose last trade is older than this is not trusted (the stock is
  // skipped, never guessed). Quiet stocks can legitimately trade less often.
  maxTradeAgeSec: num(process.env.MAX_TRADE_AGE_SEC, 120),

  // Several DARTs could ask at once; each request makes 2 full-market calls.
  maxInFlight: num(process.env.MAX_IN_FLIGHT, 5),

  // Only for testing with a short wait. Off in production.
  allowWaitOverride: process.env.ALLOW_WAIT_OVERRIDE === '1',
  // STORE=memory runs without Postgres (testing only: nothing survives a restart).
  storeKind: (process.env.STORE ?? 'postgres').toLowerCase(),
};
