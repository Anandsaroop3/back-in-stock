'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const logger = require('./log');

function createPool(config) {
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
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
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
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    } catch {
      /* connection may be gone */
    }
    client.release();
  }
}

module.exports = { createPool, migrate };
