# Encore: back-in-stock alerts

A customer asks to be emailed when a sold-out item returns. Encore takes the request, listens for restock webhooks, verifies them against the stock API, and sends **one** email to each waiting customer.

**The design idea:** the whole product is a *ticket*. The embedded form is a ticket that tears off its stub when you submit and hands you your place in line. The admin ("Box Office") shows requests as tickets that get punched when notified. The email is the redeemed ticket.

| Surface | URL | Notes |
|---|---|---|
| Embeddable form | `GET /embed` | iframe-friendly; `?sku=&email=&accent=&radius=&theme=&compact=1`; auto-resizes the host iframe |
| Create a request | `POST /api/requests` | `{ "email", "sku" }` JSON; idempotent, no duplicate open requests |
| Webhook | `POST /webhooks/stock` | `X-Webhook-Secret`; `{ event_id, sku, quantity }`; safe to retry |
| Admin | `GET /admin` | password; list/wall views, filters, search, CSV, cancel/retry |
| Health | `GET /healthz` | database check |

## Quick start

```bash
npm install
npm run dev     # a complete simulated store + inbox, no keys: /embed, /admin (letmein-admin), inbox on :4102
npm test        # 82 tests against a real throwaway Postgres (needs PostgreSQL installed)
```

Run it with Docker and **nothing else** (embedded PostgreSQL, no database to set up):

```bash
docker build -t encore .
docker run -p 3000:3000 -e PORT=3000 -v encore-data:/data   -e STOCK_API_URL=... -e STOCK_API_KEY=... -e RESEND_API_KEY=... -e RESEND_BASE_URL=...   -e WEBHOOK_SECRET=... -e ADMIN_PASSWORD=... encore
```

`DATABASE_URL` is optional: unset, the app stores everything in an embedded PostgreSQL under `/data` (the volume keeps it across restarts); set it to use a real PostgreSQL. Or with Postgres included: `docker compose up --build` (needs a `.env`, see `.env.example`). Diagrams of the system, database, state machine and delivery flow: **[docs/diagrams.md](docs/diagrams.md)** (render on GitHub).

Real deployment and the harness hookup: see **[DEPLOY.md](DEPLOY.md)**. Design decisions and the proof for each quality attribute: **[ARCHITECTURE.md](ARCHITECTURE.md)**. How it was built, including the bugs the tests caught: **[BUILD_LOG.md](BUILD_LOG.md)**.

## Stack

Node 20+, Express, PostgreSQL (`pg`, or embedded PGlite when no `DATABASE_URL`), Docker (multi-stage, non-root, tini, healthcheck). Three runtime dependencies, no front-end build step, no inline script or style (strict CSP).

## Layout

```
src/            config, runtime (composition root), app, routes/, worker, repo, stock + mailer adapters, guard, session, templates/
public/         embed + admin CSS/JS (served from /assets)
migrations/     numbered SQL, applied on boot under an advisory lock
test/           unit, integration, resilience, security + support/ (pg, hostile mock upstreams)
scripts/sim.js  the local simulated world behind `npm run dev`
Dockerfile, docker-compose.yml, railway.json   container build and deploy config
docs/diagrams.md   architecture, database, state machine, sequence and deployment diagrams
```
