'use strict';
const { loadConfig } = require('./config');
const { start } = require('./runtime');
const logger = require('./log');

// Local convenience: load .env if present (never in production, where the platform injects env).
if (process.env.NODE_ENV !== 'production') {
  try {
    process.loadEnvFile?.('.env');
  } catch {
    /* no .env file: fine */
  }
}

async function main() {
  const config = loadConfig();
  const app = await start(config);

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal: sig });
    const force = setTimeout(() => process.exit(1), 15000);
    force.unref();
    try {
      await app.close();
      process.exit(0);
    } catch (e) {
      logger.error('shutdown failed', { err: e.message });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // Last-resort handlers: log and exit non-zero so the platform restarts us into a clean state.
  process.on('unhandledRejection', (e) => {
    logger.error('unhandledRejection', { err: String(e?.message || e) });
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (e) => {
    logger.error('uncaughtException', { err: e.message });
    shutdown('uncaughtException');
  });
}

main().catch((e) => {
  // AggregateError (e.g. ECONNREFUSED on both IPv4 and IPv6) has an empty message: surface code and causes too
  const parts = [e.message, e.code, ...(e.errors || []).map((x) => x.message || x.code)].filter(Boolean);
  logger.error('fatal startup error', { err: parts.join(' | ') || e.name || String(e) });
  process.exit(1);
});
