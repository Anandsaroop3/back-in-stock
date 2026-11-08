# Deploy: what you need to do

Total time: about 15 minutes. Everything marked **You** needs your accounts or secrets, which I (Claude) cannot create or enter for you.

## 0. Prerequisites (You)

- A GitHub account and a Railway account (https://railway.app, free trial is enough).
- Your harness sign-up done: open https://harness-production-e601.up.railway.app, enter invite code `stock-e11d21`, and copy the five values it shows you: `STOCK_API_URL`, `STOCK_API_KEY`, `RESEND_API_KEY`, `RESEND_BASE_URL`, `WEBHOOK_SECRET`.
- Choose an `ADMIN_PASSWORD` (10 or more characters). A passphrase works well.

## 1. Run it locally first (You, about 3 minutes)

```bash
cd "D:\Upwork Jobs\back-in-stock"
npm install
npm test            # 79 tests; spins up its own throwaway Postgres, needs PostgreSQL installed (initdb on PATH)
npm run dev         # full simulation, no keys needed: http://localhost:3000/embed  /admin  (password: letmein-admin)
```

To point it at the **real** harness instead, create a `.env` from `.env.example` and run `node src/server.js` (Node 22 loads `.env` automatically). Use a tunnel so the harness can reach your webhook endpoint:

```bash
cloudflared tunnel --url http://localhost:3000     # or: ngrok http 3000
```

Then register `https://<your-tunnel>/webhooks/stock` as the webhook URL in the harness dashboard.

### Docker (alternative to step 1)

```bash
docker compose up --build     # app on http://localhost:3000 with its own Postgres; reads secrets from .env
```

The image is multi-stage (`npm ci --omit=dev`, then `node:22-alpine` with tini, running as the non-root `node` user) and has a `HEALTHCHECK` on `/healthz`. Railway builds from this Dockerfile automatically (`railway.json`).

## 2. Push the code to GitHub (You)

```bash
cd "D:\Upwork Jobs\back-in-stock"
git add -A && git commit -m "Encore back-in-stock alerts"
gh repo create back-in-stock --private --source . --push     # or create it in the GitHub UI and push
```

`.env` is git-ignored. Never commit real keys.

## 3. Deploy on Railway (You)

1. Railway dashboard, **New Project**, **Deploy from GitHub repo**, pick `back-in-stock`.
2. In the same project: **New**, **Database**, **Add PostgreSQL**.
3. Open your app service, **Variables**, and add:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference variable) |
| `STOCK_API_URL`, `STOCK_API_KEY` | from the harness |
| `RESEND_API_KEY`, `RESEND_BASE_URL` | from the harness |
| `WEBHOOK_SECRET` | from the harness |
| `ADMIN_PASSWORD` | your choice (10 or more characters) |
| `STORE_NAME` | e.g. `Northline Goods` |
| `PUBLIC_URL` | `https://<your-app>.up.railway.app` (set after step 4) |

4. **Settings**, **Networking**, **Generate Domain**. Copy the URL into `PUBLIC_URL`.
5. Railway builds with `npm start` and uses `/healthz` (configured in `railway.json`).
6. In the harness dashboard, set the webhook URL to `https://<your-app>.up.railway.app/webhooks/stock`.

Migrations run automatically on boot. If the app crash-loops, the logs name the missing variable (config is validated at startup).

## 4. Verify (You, about 5 minutes)

- `https://<app>/healthz` returns `{"ok":true}`.
- `https://<app>/embed` shows the ticket form. Submit a sold-out SKU with your own email.
- Watch the harness inbox. When the item restocks you receive the email, once.
- `https://<app>/admin` asks for your password. Your request shows `Waiting`, then `Notified` with a timestamp.
- **Restart test:** Railway, your service, **Restart**. Reload `/admin`: everything is still there.
- Embed snippet for the store page:

```html
<iframe src="https://<app>/embed?accent=%23e5412d" title="Back-in-stock alerts" style="width:100%;border:0" height="420" id="encore"></iframe>
<script>addEventListener('message',e=>{if(e.data&&e.data.type==='encore:resize')document.getElementById('encore').height=e.data.height})</script>
```

## Optional hardening

- `EMBED_ALLOWED_ORIGINS="https://store.example.com"` restricts which sites may frame `/embed` (default `*`).
- `TRUST_PROXY` defaults to `1` in production (Railway sits behind one proxy); change it only if you add another proxy such as Cloudflare in front.
- Keep `STOCK_API_KEY`, `RESEND_API_KEY`, `WEBHOOK_SECRET` only in Railway variables.

## If something fails

| Symptom | Likely cause |
|---|---|
| Boot error "Missing required environment variables" | a variable is not set on the service |
| Webhooks return 401 | `WEBHOOK_SECRET` differs from the harness value |
| Webhooks never arrive | harness webhook URL not set, or points at an old tunnel |
| Emails stay `queued`/fail in admin | `RESEND_BASE_URL` or key wrong; the admin row shows the provider's status code |
| `/admin` says "Too many failed attempts" | 8 wrong passwords from your IP; wait 15 minutes |
