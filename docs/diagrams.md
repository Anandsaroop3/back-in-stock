# Architecture diagrams

These render natively on GitHub. Editable draw.io versions of the same diagrams were produced alongside (system architecture, database design, state machine, sequence, deployment).

## 1. System architecture

```mermaid
flowchart TB
  subgraph Clients
    SP[Store page<br/>hosts the iframe]
    CB[Customer browser<br/>GET /embed]
    OB[Operator browser<br/>GET /admin]
    PR[Stock provider<br/>webhooks: retries, dupes, lies]
  end
  EDGE[Edge: HTTPS proxy · scanner guard · rate limits · CSP and security headers]
  subgraph APP[Encore app: Node 22 + Express, stateless, scale out]
    R1[Embed + public API<br/>validate · caps · CORS]
    R2[Webhook receiver<br/>secret · schema · persist]
    R3[Admin console<br/>session · CSRF · CSV]
    W[Worker, in every instance<br/>events · sender · reconcile]
    REPO[Repository + migrations<br/>parameterised SQL, row-level claims]
    SC[Stock client]
    ML[Mailer]
  end
  DB[(PostgreSQL<br/>requests · webhook_events)]
  SAPI[Stock API<br/>source of truth]
  RSND[Resend API]
  SP -.frames.-> CB
  CB --> EDGE
  OB --> EDGE
  PR -->|webhook + secret| EDGE
  EDGE --> R1 & R2 & R3
  R1 --> REPO
  R2 --> REPO
  R3 --> REPO
  W --> REPO
  W --> SC
  W --> ML
  REPO --> DB
  SC -->|GET /sku| SAPI
  ML -->|POST /emails + Idempotency-Key| RSND
  classDef sec fill:#e1d5e7,stroke:#9673a6
  classDef ext fill:#ffe6cc,stroke:#d79b00
  classDef data fill:#d5e8d4,stroke:#82b366
  classDef app fill:#dae8fc,stroke:#6c8ebf
  class EDGE sec
  class PR,SAPI,RSND ext
  class DB data
  class R1,R2,R3,W,REPO,SC,ML app
```

## 2. Database design

```mermaid
erDiagram
  requests {
    bigserial id PK
    text email "lowercased"
    text sku
    text product_name
    jsonb product "snapshot for the email"
    text status "open, queued, sending, notified, failed, cancelled"
    timestamptz created_at
    timestamptz queued_at
    timestamptz notified_at
    int attempts
    timestamptz next_attempt_at "backoff"
    timestamptz locked_at "claim, stale after 120s"
    text last_error
    text trigger_event "logical link to webhook_events"
    int trigger_qty
    text provider_id "Resend id"
    text idem_key "Idempotency-Key, per request"
  }
  webhook_events {
    text event_id PK "idempotency: replays are no-ops"
    text sku
    int quantity "a hint, never trusted"
    jsonb payload "whitelisted fields only"
    timestamptz received_at
    text status "pending, processing, done, ignored, failed"
    int attempts
    timestamptz next_attempt_at
    timestamptz locked_at
    timestamptz processed_at
    text note
  }
  schema_migrations {
    text name PK
    timestamptz applied_at
  }
  webhook_events ||..o{ requests : "triggers (logical)"
```

Constraints and indexes that carry the guarantees:

| Guarantee | Mechanism |
|---|---|
| No duplicate open requests | `UNIQUE (email, sku) WHERE status IN ('open','queued','sending')` |
| Replayed webhooks are no-ops | `webhook_events.event_id` primary key, `ON CONFLICT DO NOTHING` |
| Exactly one worker owns a row | `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` plus status guards |
| Fast "who is waiting for SKU" | `INDEX (sku, status)` |
| Cheap queue scans | partial indexes on `next_attempt_at` (queued, pending) and `locked_at` (sending) |
| Safe concurrent boot | migrations run under `pg_advisory_lock` |

## 3. Request lifecycle

```mermaid
stateDiagram-v2
  [*] --> Open : signup
  Open --> Queued : restock verified
  Queued --> Sending : claimed (SKIP LOCKED)
  Sending --> Notified : provider 2xx
  Sending --> Queued : 5xx, 429, timeout (backoff, same key)
  Sending --> Failed : 422 or max attempts
  Failed --> Queued : admin retry
  Open --> Cancelled : admin cancel
  Queued --> Cancelled : admin cancel
  Notified --> [*]
```

A `Sending` row whose lock is older than 120 s belongs to a crashed worker: it is claimed again and sent with the same `Idempotency-Key`, so the provider cannot deliver twice.

## 4. Exactly-once delivery

```mermaid
sequenceDiagram
  autonumber
  participant P as Stock provider
  participant H as Encore webhook
  participant D as PostgreSQL
  participant W as Worker
  participant S as Stock API
  participant R as Resend
  P->>H: POST /webhooks/stock (event_id, sku, qty)
  H->>H: constant-time secret check, validate schema
  H->>D: INSERT event ON CONFLICT DO NOTHING
  H-->>P: 200 accepted or duplicate
  W->>D: claim event (SKIP LOCKED)
  W->>S: GET /sku (qty in webhook is only a hint)
  S-->>W: live quantity
  alt really in stock
    W->>D: open to queued (guarded UPDATE)
    W->>D: claim queued to sending (SKIP LOCKED)
    W->>R: POST /emails + Idempotency-Key
    alt 2xx
      R-->>W: id
      W->>D: sending to notified, notified_at
    else 5xx, 429 or timeout
      W->>D: back to queued, backoff, same key on retry
    end
  else webhook lied
    W->>D: event ignored, nobody emailed
  end
  Note over W,D: Crash mid-send: stale lock re-claimed, same key, provider dedupes
```

## 5. Build and deployment

```mermaid
flowchart LR
  DEV[Developer<br/>git push] --> GH[GitHub repo<br/>Dockerfile · tests]
  GH --> BLD[Docker build<br/>stage 1 npm ci --omit=dev<br/>stage 2 node:22-alpine, tini, non-root]
  subgraph RW[Railway project]
    APP1[Encore container<br/>HEALTHCHECK /healthz]
    APP2[Encore container, scaled out]
    PG[(PostgreSQL<br/>persistent volume)]
  end
  BLD --> APP1
  BLD --> APP2
  USERS[Customers · operators · stock provider] -->|HTTPS| EDGE[Railway edge<br/>TLS, public domain]
  EDGE --> APP1
  APP1 --> PG
  APP2 --> PG
  APP1 -->|verify stock, send email| UP[Stock API + Resend API<br/>harness]
  classDef ext fill:#ffe6cc,stroke:#d79b00
  classDef data fill:#d5e8d4,stroke:#82b366
  class USERS,UP ext
  class PG data
```

Local alternative: `docker compose up --build` runs the same image next to `postgres:16-alpine` with a health-gated start order.
