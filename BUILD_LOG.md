# Build log: what was built and how

Built with Claude Code (an AI pair-programmer) driving a design-first, test-first loop. The human set the goals and constraints; the model wrote code, ran the tests, drove a real browser to look at the UI, and fixed what it found.

## How the work went

1. **Discussion before code.** Read the brief for the *hidden* requirements ("don't trust the webhook", "sometimes the same thing twice at once", "once, not zero, not twice", "survive a restart") and designed around them. Decision: Postgres plus a transactional-outbox worker, not an in-memory queue.
2. **Core first, UI second.** Schema, webhook path, worker and mailer before any pixels, because correctness was the riskiest part.
3. **Adversarial test suite.** Real app, real Postgres, and mock upstreams that lie, flap, hang, drop connections after accepting an email, and replay idempotency keys (`test/support/`).
4. **Looked at it in a browser.** Ran a full simulation (`npm run dev`), clicked through the embed and admin, and checked the email at desktop and phone widths.
5. **Fixed what the tests and browser found** (below), then wrote the docs.

## What the tests and the browser caught (these were mine, not hypotheticals)

| # | Found by | Problem | Fix |
|---|---|---|---|
| 1 | integration test | A customer who had just been emailed could re-submit while the item was still in stock and get a **second email**. That breaks "once", and it lets anyone email-bomb an address. | 24 h re-notify cooldown; per-address caps (active and daily) |
| 2 | security suite (only under load) | The cooldown check and the insert were not atomic. If the worker flipped the first request to `notified` between them, a second email slipped through. | `createRequest` is now one transaction that locks the live row; added a 150-concurrent-submit storm test |
| 3 | security suite | The stock client treated `[1,2,3]` or `{}` returned with a 200 as "item exists, sold out" and would have stored requests for it. | `normalize()` rejects arrays and objects with no stock fields |
| 4 | **real browser** (curl-based tests missed it) | `Referrer-Policy: no-referrer` makes browsers send `Origin: null` on form posts, so my own CSRF guard rejected the **legitimate admin login**. | Trust the unforgeable `Sec-Fetch-Site` header first, `Origin` as fallback; policy changed to `same-origin`; regression test |
| 5 | browser | "Sending now" stamp invisible in dark mode; "punched" hole overlapped a timestamp in Wall view; KPI tile orphan gap; email button wrapped; "Time in line: 0s" looked silly | CSS and template fixes |
| 6 | browser console | Half-typed text (`ke`) was looked up as a SKU, causing needless 404s | exact-match lookups only |

Items 1 to 3 were found by tests I wrote, not by luck: the value of the suite is that it catches regressions in exactly the behaviours the brief says will be probed.

## What is verified

- `npm test`: **76 tests, all passing** (unit 12, integration 15, resilience 16, security 33). Run twice back to back, about 60 s each, no flakes.
- `npm audit --omit=dev`: 0 vulnerabilities (two runtime dependencies).
- UI checked in a real browser: embed (dark, light, custom accent, phone width, tear animation, both success states), login, admin list and Wall views, and the email at desktop and phone widths in light and dark.

## What is NOT verified (please read)

- **Not run against the real harness.** No keys were available, so everything was tested against my own mocks. The one assumption I could not check is the exact JSON of the stock API (I rely on `quantity` and `in_stock`). Run the DEPLOY.md verification steps to confirm.
- **Not deployed yet.** Railway needs your account; see DEPLOY.md.
- **Email rendering was checked in a browser only**, not in Gmail, Outlook or Apple Mail. The markup is conservative (tables, inline styles, plain-text twin), but I have not seen it in those clients.
- The sign-up storm test was added after the fix and passes; I did not re-run it against the unfixed code to prove it would have failed there.
- Rate-limit and ban counters are per-instance memory (see ARCHITECTURE.md, "Known limit").
