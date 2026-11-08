'use strict';
const crypto = require('node:crypto');

const REQUIRED = [
  'DATABASE_URL',
  'STOCK_API_URL',
  'STOCK_API_KEY',
  'RESEND_API_KEY',
  'RESEND_BASE_URL',
  'WEBHOOK_SECRET',
  'ADMIN_PASSWORD',
];

function int(v, dflt, min, max) {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid integer "${v}" (expected ${min}..${max})`);
  }
  return n;
}

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function stripSlash(u) {
  return u.replace(/\/+$/, '');
}

function httpUrl(name, v) {
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`${name} must be http(s)`);
  }
  return stripSlash(u.toString());
}

/**
 * Parse and validate configuration. Fails fast: a misconfigured instance must
 * never come up half-working.
 */
function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  // A Railway variable reference that did not resolve arrives as the literal text "${{Service.VAR}}".
  if (env.DATABASE_URL.includes('${{')) {
    throw new Error(
      'DATABASE_URL is an unresolved Railway reference. The service name in ${{Name.DATABASE_URL}} must match your Postgres service exactly, or paste the real connection string.'
    );
  }
  try {
    new URL(env.DATABASE_URL);
  } catch {
    throw new Error('DATABASE_URL is not a valid connection URL (expected postgres://user:pass@host:port/db)');
  }
  const isProd = env.NODE_ENV === 'production';
  if (isProd && env.ADMIN_PASSWORD.length < 10) {
    throw new Error('ADMIN_PASSWORD must be at least 10 characters in production');
  }
  if (isProd && env.WEBHOOK_SECRET.length < 16) {
    throw new Error('WEBHOOK_SECRET must be at least 16 characters in production');
  }

  const port = int(env.PORT, 3000, 1, 65535);
  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null;
  const publicUrl = stripSlash(env.PUBLIC_URL || railwayDomain || `http://localhost:${port}`);

  // Derived so that rotating the admin password / webhook secret invalidates sessions.
  const sessionSecret = env.SESSION_SECRET
    ? Buffer.from(env.SESSION_SECRET)
    : crypto.createHmac('sha256', env.WEBHOOK_SECRET).update(`session:${env.ADMIN_PASSWORD}`).digest();

  const trustRaw = env.TRUST_PROXY ?? (isProd ? '1' : '0');
  const trustProxy = trustRaw === 'false' ? false : Number.isInteger(Number(trustRaw)) ? Number(trustRaw) : trustRaw;

  return {
    isProd,
    port,
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    trustProxy,
    databaseUrl: env.DATABASE_URL,
    databaseSsl: bool(env.DATABASE_SSL, false),
    stock: {
      apiUrl: httpUrl('STOCK_API_URL', env.STOCK_API_URL),
      apiKey: env.STOCK_API_KEY,
      timeoutMs: int(env.STOCK_TIMEOUT_MS, 5000, 100, 60000),
    },
    resend: {
      baseUrl: httpUrl('RESEND_BASE_URL', env.RESEND_BASE_URL),
      apiKey: env.RESEND_API_KEY,
      timeoutMs: int(env.RESEND_TIMEOUT_MS, 10000, 100, 60000),
    },
    webhookSecret: env.WEBHOOK_SECRET,
    adminPassword: env.ADMIN_PASSWORD,
    sessionSecret,
    sessionTtlSec: int(env.SESSION_TTL_SEC, 8 * 3600, 60, 7 * 86400),
    brand: {
      storeName: (env.STORE_NAME || 'Your Store').slice(0, 60),
      storeUrl: env.STORE_URL ? httpUrl('STORE_URL', env.STORE_URL) : null,
      emailFrom: env.EMAIL_FROM || 'Encore <onboarding@resend.dev>',
    },
    embedAncestors: (env.EMBED_ALLOWED_ORIGINS || '*').trim(),
    worker: {
      intervalMs: int(env.WORKER_INTERVAL_MS, 1000, 20, 60000),
      reconcileMs: int(env.RECONCILE_INTERVAL_MS, 30000, 100, 3600000),
      staleLockSec: int(env.STALE_LOCK_SEC, 120, 1, 3600),
      maxAttempts: int(env.MAX_ATTEMPTS, 8, 1, 50),
      backoffBaseMs: int(env.BACKOFF_BASE_MS, 2000, 1, 600000),
      backoffMaxMs: int(env.BACKOFF_MAX_MS, 900000, 1, 3600000),
      batch: int(env.SEND_BATCH, 10, 1, 100),
      concurrency: int(env.SEND_CONCURRENCY, 4, 1, 32),
    },
    limits: {
      maxOpenPerEmail: int(env.MAX_OPEN_PER_EMAIL, 25, 1, 1000),
      maxPerEmailPerDay: int(env.MAX_PER_EMAIL_PER_DAY, 30, 1, 10000),
    },
    guard: {
      enabled: bool(env.GUARD_ENABLED, true),
      banThreshold: int(env.BAN_THRESHOLD, 20, 1, 1000),
      banMs: int(env.BAN_MS, 30 * 60 * 1000, 1000, 86400000),
      globalPerMin: int(env.RATE_LIMIT_PER_MIN, 300, 5, 100000),
      webhookPerMin: int(env.WEBHOOK_RATE_LIMIT_PER_MIN, 1200, 5, 1000000),
    },
    assetVersion: Date.now().toString(36),
  };
}

module.exports = { loadConfig };
