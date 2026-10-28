-- DART pick service schema. Idempotent: safe to run on every start.
-- This is its own database. It never touches DART's trading database.

-- The morning list from Base44: each stock with its own intended direction.
CREATE TABLE IF NOT EXISTS universe (
  trade_date  date    NOT NULL,
  symbol      text    NOT NULL,
  side        text    NOT NULL CHECK (side IN ('long', 'short')),
  atr14       numeric,
  prev_close  numeric,
  PRIMARY KEY (trade_date, symbol)
);

-- One row per call from DART.
CREATE TABLE IF NOT EXISTS requests (
  id          text        PRIMARY KEY,
  trade_date  date        NOT NULL,
  status      text        NOT NULL,   -- pending | ready | failed
  created_at  timestamptz NOT NULL DEFAULT now(),
  t0          timestamptz,            -- when the first snapshot completed
  t1          timestamptz,            -- when the second snapshot completed
  ready_at    timestamptz,            -- when the answer was finished
  wait_sec    numeric     NOT NULL,
  threshold   numeric     NOT NULL,
  exclude     text[]      NOT NULL DEFAULT '{}',
  winner      text,                   -- the symbol returned, null if none confirmed
  error       text,
  counts      jsonb,
  candidates  jsonb                   -- top confirmed names, best first
);
CREATE INDEX IF NOT EXISTS requests_day_idx ON requests (trade_date, created_at);

-- The prices seen in each of the two snapshots (phase 0 = first, 1 = second).
CREATE TABLE IF NOT EXISTS snapshot_prices (
  request_id  text        NOT NULL,
  phase       smallint    NOT NULL,
  symbol      text        NOT NULL,
  price       numeric     NOT NULL,
  trade_ts    timestamptz,
  bid         numeric,
  ask         numeric,
  PRIMARY KEY (request_id, phase, symbol)
);

-- The decision for every stock in every request, skipped ones included,
-- so rejected and stale names can be studied later.
CREATE TABLE IF NOT EXISTS results (
  request_id  text        NOT NULL,
  symbol      text        NOT NULL,
  side        text        NOT NULL,
  p0          numeric,
  p1          numeric,
  move_pct    numeric,                -- favourable move in the stock's own direction
  status      text        NOT NULL,   -- confirmed | rejected | stale | no_data | excluded
  rank        int,
  PRIMARY KEY (request_id, symbol)
);
