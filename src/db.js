'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const logger = require('./log');

/**
 * Zero-config storage: an embedded PostgreSQL (PGlite, same SQL, same migrations) persisted in a
 * data directory. Used when DATABASE_URL is not set, so `docker run` works with only the app's own
 * variables. A single in-process connection, so work is serialised through a mutex; fine for one
 * instance, and DATABASE_URL (real Postgres) is the path for scale-out.
 */
function createEmbeddedPool(config) {
  const { PGlite } = require('@electric-sql/pglite');
  const target = config.dataDir === ':memory:' ? 'memory://' : config.dataDir;
  if (target !== 'memory://') fs.mkdirSync(target, { recursive: true });
  const db = new PGlite(target, { parsers: { 20: (v) => Number(v) } }); // int8 -> number
  let tail = Promise.resolve();
  const lock = () => {
    let release;
    const next = new Promise((r) => (release = r));
    const turn = tail.then(() => release);
    tail = tail.then(() => next);
    return turn;
  };
  const run = async (text, params) => {
    await db.waitReady;
    if (params === undefined || params.length === 0) {
      const res = await db.exec(text); // allows multi-statement migrations
      const last = res[res.length - 1] || { rows: [] };
      return { rows: last.rows, rowCount: last.affectedRows || last.rows.length };
    }
    const res = await db.query(text, params);
    return { rows: res.rows, rowCount: res.affectedRows || res.rows.length };
  };
  return {
    embedded: true,
    async query(text, params) {
      const release = await lock();
      try {
        return await run(text, params);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await lock();
      let released = false;
      return {
        query: (text, params) => run(text, params),
        release() {
          if (released) return;
          released = true;
          release();
        },
      };
    },
    on() {},
    async end() {
      await tail;
      await db.close();
    },
  };
}

function createPool(config) {
  if (!config.databaseUrl) return createEmbeddedPool(config);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 12,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000,
  });
  // An idle client erroring (e.g. failover) must not crash the process.
  pool.on('error', (err) => logger.error('pg pool error', { err: err.message }));
  return pool;
}

const LOCK_KEY = 727274;

/** Apply SQL migrations in order. Safe to run from many instances at once. */
async function migrate(pool, dir = path.join(__dirname, '..', 'migrations')) {
  const client = await pool.connect();
  try {
    if (!pool.embedded) await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        logger.info('migration applied', { file: f });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    try {
      if (!pool.embedded) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    } catch {
      /* connection may be gone */
    }
    client.release();
  }
}

module.exports = { createPool, migrate };
