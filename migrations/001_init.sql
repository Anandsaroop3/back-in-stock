-- Encore schema. Applied once, in order, under an advisory lock.

CREATE TABLE requests (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT        NOT NULL,
  sku             TEXT        NOT NULL,
  product_name    TEXT,
  product         JSONB,
  status          TEXT        NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','queued','sending','notified','failed','cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  queued_at       TIMESTAMPTZ,
  notified_at     TIMESTAMPTZ,
  attempts        INT         NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  locked_at       TIMESTAMPTZ,
  last_error      TEXT,
  trigger_event   TEXT,
  trigger_qty     INT,
  provider_id     TEXT,
  idem_key        TEXT        NOT NULL DEFAULT gen_random_uuid()::text
);

-- "No duplicate open requests": enforced by the database, not by application code.
CREATE UNIQUE INDEX requests_one_open
  ON requests (email, sku) WHERE status IN ('open','queued','sending');
CREATE INDEX requests_sku_status ON requests (sku, status);
CREATE INDEX requests_queue      ON requests (next_attempt_at) WHERE status = 'queued';
CREATE INDEX requests_sending    ON requests (locked_at)       WHERE status = 'sending';
CREATE INDEX requests_created    ON requests (created_at DESC);

CREATE TABLE webhook_events (
  event_id        TEXT        PRIMARY KEY,           -- idempotency: replays are no-ops
  sku             TEXT        NOT NULL,
  quantity        INT         NOT NULL,
  payload         JSONB       NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','done','ignored','failed')),
  attempts        INT         NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at       TIMESTAMPTZ,
  processed_at    TIMESTAMPTZ,
  note            TEXT
);
CREATE INDEX webhook_events_work ON webhook_events (next_attempt_at)
  WHERE status IN ('pending','processing');
