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
npm test        # 77 tests against a real throwaway Postgres (needs PostgreSQL installed)
```

Real deployment and the harness hookup: see **[DEPLOY.md](DEPLOY.md)**. Design decisions and the proof for each quality attribute: **[ARCHITECTURE.md](ARCHITECTURE.md)**. How it was built, including the bugs the tests caught: **[BUILD_LOG.md](BUILD_LOG.md)**.

## Stack

Node 20+, Express, PostgreSQL (`pg`). Two runtime dependencies, no front-end build step, no inline script or style (strict CSP).

## Layout

```
src/            config, runtime (composition root), app, routes/, worker, repo, stock + mailer adapters, guard, session, templates/
public/         embed + admin CSS/JS (served from /assets)
migrations/     numbered SQL, applied on boot under an advisory lock
test/           unit, integration, resilience, security + support/ (pg, hostile mock upstreams)
scripts/sim.js  the local simulated world behind `npm run dev`
```
