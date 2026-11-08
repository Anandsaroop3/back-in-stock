# Encore: architecture and quality attributes

Back-in-stock alerts. Customers ask for a sold-out item; when it returns, each of them gets one email.

This document answers two questions a reviewer should be able to check: **what are the design decisions**, and **where is the proof** that each quality attribute holds. Every claim in the right-hand column of the tables is an automated test you can run with `npm test`.

## 1. System shape

```
 store page ──iframe──▶ GET /embed ──fetch──▶ POST /api/requests ─┐
                                                                  ▼
 stock provider ──POST /webhooks/stock──▶ [verify secret] [validate] ──▶  PostgreSQL
                       (retries, dupes)        persist event, then 200      ├─ requests        (state machine)
                                                                            └─ webhook_events  (idempotency log)
                                                                                   ▲
 worker (in every instance; any number may run) ───────────────────────────────────┘
   1. events:    pending ──verify with stock API──▶ requests open → queued
   2. sender:    queued ──claim──▶ sending ──Resend + Idempotency-Key──▶ notified | queued(retry) | failed
   3. reconcile: every 30s, catalogue says "in stock" but we never heard → open → queued
 GET /admin ──▶ same database, read model + two operator actions (cancel, retry)
```

Layers (each depends only on the one below, which keeps modules replaceable and testable):

| Layer | Files | Responsibility |
|---|---|---|
| Composition root | `src/runtime.js`, `src/server.js` | wiring, lifecycle, signals, graceful shutdown |
| HTTP | `src/app.js`, `src/routes/*` | parsing, auth, status codes only; no SQL |
| Domain/worker | `src/worker.js` | the delivery engine and its state transitions |
| Data access | `src/repo.js`, `src/db.js`, `migrations/` | every query is parameterised and lives here (plus the worker's queue SQL) |
| Adapters | `src/stock.js`, `src/mailer.js` | the only code that talks to the outside world; treats upstream as untrusted |
| Presentation | `src/templates/*`, `public/*` | escape-by-default templates, no inline script or style |
| Cross-cutting | `src/config.js`, `src/guard.js`, `src/session.js`, `src/util.js`, `src/log.js` | fail-fast config, rate limiting, sessions, validation, structured logs |

State machine of a request: `open → queued → sending → notified`, with `sending → queued` on a transient failure, `→ failed` after `MAX_ATTEMPTS` or a permanent rejection, and `open|queued → cancelled` by an operator. "No duplicate open requests" is a **partial unique index** `(email, sku) WHERE status IN ('open','queued','sending')`, so the database enforces it, not application code.

## 2. Quality attributes: claim, mechanism, proof

### Reliability: "customers hear from you once, not zero times, not twice"

| Claim | Mechanism | Proof (`test/…`) |
|---|---|---|
| A duplicate webhook never causes a second email | `webhook_events.event_id` primary key, `ON CONFLICT DO NOTHING` | resilience: *same event delivered sequentially three times*; *30 identical webhooks fired at the same time* |
| The provider re-emitting the same restock under new event ids still sends once | emails are keyed to the **request row**, not the event; `open → queued` is a single guarded UPDATE | resilience: *different event ids for the SAME restock* |
| Two instances (or a crash and a restart) cannot double-send | `FOR UPDATE SKIP LOCKED` claiming plus a status guard on every transition | resilience: *TWO app instances … zero duplicates* (40 customers, exactly 40 send attempts) |
| An email the provider accepted but whose response we lost is not sent again | stable `Idempotency-Key` per request, reused on every retry | resilience: *Resend ACCEPTS the email then drops the connection* |
| Never *zero* emails: a lost, late or early webhook is recovered | webhook is persisted before the 200; reconciliation sweep compares open requests with live stock | integration: *reconciliation … webhook never arrives*; resilience: *RESTART …* |
| A worker that dies mid-send is recovered | claims older than `STALE_LOCK_SEC` are re-claimed (same idempotency key, so the provider dedupes) | resilience: *crash recovery* (two tests) |
| A signup racing the worker cannot cause a second email | `createRequest` locks the live row in a transaction (found by a failing test, see BUILD_LOG) | resilience: *sign-up STORM* (150 concurrent submits, 25 customers, exactly 25 emails) |

### Availability and fault tolerance

- Outbound calls have timeouts, exponential backoff with jitter, and a cap, so a slow provider degrades throughput, not correctness (*Resend hangs*, *returns 500 twice*, *stock API flaps*).
- A permanent rejection (400/422) fails fast and is visible in the admin, with a one-click retry; a persistent outage ends in `failed` after `MAX_ATTEMPTS`, never an infinite loop (*persistent provider outage*).
- Stateless app tier: scale by adding instances; Postgres coordinates them. A pool-level error handler stops a database failover from crashing the process. SIGTERM drains in-flight work (*graceful shutdown*).
- `/healthz` checks the database for the platform's health probe.

### Durability / recoverability

All state is in Postgres. Events and requests survive restarts, and an event received while the worker was down is processed after boot (*RESTART* test). Migrations are numbered SQL files applied under an advisory lock, so many instances can boot at once.

### Security

Mapped to **OWASP Top 10 (2021)** and **OWASP API Top 10 (2023)**. Each row has a tagged test in `test/security.test.js`.

| Category | Control |
|---|---|
| A01 / API1 / API5 Broken access control | admin behind password on every route; no public read of requests; CSRF token plus same-origin check on actions; Basic-auth sessions cannot mutate; verb tampering tested |
| A02 Cryptographic failures | HMAC-SHA256 signed sessions; constant-time comparisons; `__Host-` cookie prefix, `Secure`, HSTS when served over https; secrets only from env |
| A03 / API3 Injection and property validation | parameterised SQL only; strict allow-list validation of every field; LIKE wildcards escaped; escape-by-default HTML templates; CSV formula neutralisation; mass-assignment test |
| A04 Insecure design | re-notify cooldown, per-address caps (active and daily), rate limits, no waitlist enumeration (identical responses) |
| A05 / API8 Misconfiguration | CSP with no `unsafe-inline`; nosniff, frame, referrer and permissions policies; no tech banner; uniform error envelope with no stack traces; CORS only on the credential-less public API |
| A06 Vulnerable components | two runtime dependencies; `npm audit` reports 0 |
| A07 / API2 Authentication failures | webhook secret checked before the body is parsed; admin brute-force lockout (per IP and global); signed, expiring sessions; password never accepted in a URL |
| A08 Integrity failures | webhook payload strictly validated; upstream stock data treated as untrusted and re-verified (a webhook that lies sends nothing) |
| A09 Logging and monitoring | structured JSON logs of auth failures, bans, sends and retries; emails masked in logs |
| A10 / API7 SSRF | upstream URLs come only from env; redirects are never followed (so the bearer token cannot be bounced elsewhere) |
| API4 Resource consumption | body limits (4 KB / 16 KB), per-route rate limits, response-size cap on upstream, header limits, server timeouts |

**Port scanners (nmap).** An application cannot stop raw TCP scans; that is the network edge's job. On Railway the only reachable surface is the HTTPS proxy. What the app does: it recognises scanner **behaviour** at the HTTP layer and drops that client's connections without answering. That covers scanner user agents, probe paths (`/.env`, `/wp-login.php`, `../`), directory brute-forcing (404 strikes), and non-HTTP garbage (nmap `-sV` probes). Webhook and health routes are exempt so a hostile client can never lock out the real sender. For a self-hosted VM, add a host firewall (`ufw allow 443`) and fail-fast network rules; nothing in this app replaces that.

### Performance and scalability

- Hot paths are indexed (`(sku,status)`, queue and stale-lock partial indexes). The webhook handler does one INSERT and returns; heavy work is off the request path.
- Sending is batched with bounded concurrency. The catalogue is cached for 15 s for the UI.
- **Known limit:** rate-limit and ban counters are in memory per instance. With N instances an attacker gets N times the budget. Moving them to Postgres or Redis is the next step; correctness (dedupe, delivery) does not depend on them.

### Maintainability and testability

- Dependency injection through a single composition root: tests boot the **real** app against a real throwaway Postgres and programmable hostile mocks (`test/support/`).
- Fail-fast, validated configuration (`src/config.js`); weak production secrets refuse to start.
- Small modules with one reason to change; no SQL in route handlers; no inline script or style in templates.
- `npm run dev` starts a complete simulated world (store, restocks, inbox) with no keys.

### Usability and accessibility

Labelled fields, `aria-live` errors, a fully keyboard-operable combobox, focus management on success, `prefers-reduced-motion` honoured, 16 px inputs (no iOS zoom), light and dark themes, host-store theming (`?accent=&radius=&theme=&compact=1`), iframe auto-resize via `postMessage`. Email: table layout, plain-text twin, preheader, dark-mode and phone styles.

## 3. Deliberate limits

- No double opt-in or unsubscribe: the spec asks for exactly one transactional email per request. The cooldown and caps limit abuse, but a production service would confirm the address first.
- Idempotency keys at Resend last 24 h; retries are capped well inside that window.
- The stock API's exact response shape is not known; `src/stock.js` accepts the documented fields (`quantity`, `in_stock`) and rejects anything without them.
- Not load-tested beyond the concurrency scenarios in the suite.
