'use strict';
const { loadConfig } = require('../../src/config');
const { start } = require('../../src/runtime');
const { mockStock, mockResend } = require('./mocks');
const { setSilent } = require('../../src/log');

setSilent(true);

const SECRET = 'test-webhook-secret-123456';
const ADMIN = 'correct-horse-battery';

function envFor({ dbUrl, stock, resend }, extra = {}) {
  return {
    DATABASE_URL: dbUrl,
    STOCK_API_URL: stock.url,
    STOCK_API_KEY: stock.key,
    RESEND_API_KEY: resend.key,
    RESEND_BASE_URL: resend.url,
    WEBHOOK_SECRET: SECRET,
    ADMIN_PASSWORD: ADMIN,
    TRUST_PROXY: '1',
    STORE_NAME: 'Northline',
    // fast loops for tests
    WORKER_INTERVAL_MS: '40',
    RECONCILE_INTERVAL_MS: '1500',
    BACKOFF_BASE_MS: '30',
    BACKOFF_MAX_MS: '200',
    STALE_LOCK_SEC: '2',
    STOCK_TIMEOUT_MS: '600',
    RESEND_TIMEOUT_MS: '600',
    ...extra,
  };
}

/** Boot the real app against mock upstreams and a fresh database. */
async function boot(cluster, { env = {}, stock, resend, dbUrl, autostartWorker = true, embedded = false } = {}) {
  stock = stock || (await mockStock());
  resend = resend || (await mockResend());
  if (!embedded) dbUrl = dbUrl || (await cluster.createDb());
  const config = loadConfig(envFor({ dbUrl, stock, resend }, env));
  const app = await start(config, { port: 0, autostartWorker });
  const base = `http://127.0.0.1:${app.port}`;
  let ipN = 10;
  const api = {
    base, app, stock, resend, config, dbUrl, pool: app.pool,
    /** a fresh client IP (the app trusts one proxy hop) so tests never ban each other */
    newIp: () => `198.51.100.${ipN++}`,
    async req(method, path, { headers = {}, body, ip, json = true, redirect = 'manual' } = {}) {
      const h = { 'x-forwarded-for': ip || api.newIp(), ...headers };
      let payload = body;
      if (body !== undefined && typeof body !== 'string' && json) {
        payload = JSON.stringify(body);
        h['content-type'] = h['content-type'] || 'application/json';
      }
      const res = await fetch(base + path, { method, headers: h, body: payload, redirect });
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        /* html etc */
      }
      return { status: res.status, headers: res.headers, text, data };
    },
    webhook: (body, { secret = SECRET, ip } = {}) =>
      api.req('POST', '/webhooks/stock', { body, ip, headers: secret === null ? {} : { 'x-webhook-secret': secret } }),
    subscribe: (email, sku, ip) => api.req('POST', '/api/requests', { body: { email, sku }, ip }),
    async close() {
      await app.close();
    },
    async closeAll() {
      await app.close();
      await stock.close();
      await resend.close();
    },
    async rows(where = 'true', args = []) {
      return (await app.pool.query(`SELECT * FROM requests WHERE ${where} ORDER BY id`, args)).rows;
    },
  };
  return api;
}

async function waitFor(fn, { timeout = 8000, every = 40, msg = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${msg}`);
    await new Promise((r) => setTimeout(r, every));
  }
}
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

module.exports = { boot, waitFor, settle, SECRET, ADMIN, mockStock, mockResend };
