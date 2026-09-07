-- OrderRescue journal.
--
-- Two things this schema is responsible for, beyond storage:
--   1. Making a duplicate economic action structurally impossible
--      (one operation per intent; unique venue identifiers).
--   2. Making evidence tamper-evident (append-only hash chain).

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intents (
  intent_id        TEXT PRIMARY KEY,
  idempotency_key  TEXT NOT NULL UNIQUE,
  intent_digest    TEXT NOT NULL,
  account_ref      TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  side             TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type       TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT')),
  quantity         TEXT,
  quote_quantity   TEXT,
  limit_price      TEXT,
  time_in_force    TEXT,
  max_notional     TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  confirmation_ref TEXT,
  confirmed_at     TEXT,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  schema_version   INTEGER NOT NULL
);

-- intent_id is UNIQUE, not merely indexed: one intent can never own two
-- operations, so there is no shape in which this table holds two dispatchable
-- records for the same economic decision.
CREATE TABLE IF NOT EXISTS operations (
  operation_id             TEXT PRIMARY KEY,
  intent_id                TEXT NOT NULL UNIQUE REFERENCES intents(intent_id),
  venue_client_order_id    TEXT NOT NULL UNIQUE,
  venue_order_id           TEXT UNIQUE,
  state                    TEXT NOT NULL,
  state_version            INTEGER NOT NULL DEFAULT 0,
  submit_attempt_count     INTEGER NOT NULL DEFAULT 0,
  executed_quantity        TEXT NOT NULL DEFAULT '0',
  cumulative_quote_quantity TEXT NOT NULL DEFAULT '0',
  first_submitted_at       TEXT,
  last_observed_at         TEXT,
  terminal_reason          TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS operations_state_idx ON operations(state);

CREATE TABLE IF NOT EXISTS evidence_events (
  sequence            INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id        TEXT NOT NULL REFERENCES operations(operation_id),
  event_type          TEXT NOT NULL,
  source              TEXT NOT NULL,
  source_timestamp    TEXT,
  observed_at         TEXT NOT NULL,
  payload_digest      TEXT NOT NULL,
  facts_json          TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS evidence_operation_idx ON evidence_events(operation_id, sequence);

CREATE TABLE IF NOT EXISTS reconciliation_jobs (
  operation_id     TEXT PRIMARY KEY REFERENCES operations(operation_id),
  status           TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SETTLED', 'GAVE_UP')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TEXT,
  next_attempt_at  TEXT NOT NULL,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS reconciliation_due_idx ON reconciliation_jobs(status, next_attempt_at);
