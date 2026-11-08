'use strict';
/**
 * Run the real server (with your .env: real harness keys) against a throwaway local Postgres,
 * so you can try the app without configuring a database. Data is deleted on exit.
 *   node scripts/run-with-temp-db.js
 */
const { startCluster } = require('../test/support/pg');

(async () => {
  const cluster = await startCluster();
  process.env.DATABASE_URL = await cluster.createDb('encore_local'); // wins over a blank DATABASE_URL in .env
  const stop = async () => {
    await cluster.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  require('../src/server.js');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
