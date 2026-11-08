'use strict';
const http = require('node:http');
const { createPool, migrate } = require('./db');
const { StockClient } = require('./stock');
const { Repo } = require('./repo');
const { Worker } = require('./worker');
const { createApp } = require('./app');
const { ipKey } = require('./guard');
const logger = require('./log');

/**
 * Composition root: the only place where concrete pieces are wired together.
 * Everything else receives its dependencies, which is what makes the system testable
 * (tests start the real thing against mock upstreams).
 */
async function start(config, { port = config.port, autostartWorker = true } = {}) {
  const pool = createPool(config);
  await migrate(pool);
  const repo = new Repo(pool);
  const stock = new StockClient(config.stock);
  const worker = new Worker({ pool, stock, config });
  const app = createApp({ config, repo, stock, worker });

  const server = http.createServer({ maxHeaderSize: 8192 }, app);
  // Slow-client (slowloris) protection.
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  // Garbage that is not HTTP at all (port scanners, nmap -sV probes): count it and hang up.
  server.on('clientError', (err, socket) => {
    const ip = ipKey(socket.remoteAddress);
    app.guard.strike(ip, 10, 'non-http-traffic');
    if (socket.writable && err.code !== 'ECONNRESET') socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  if (autostartWorker) worker.start();
  const actualPort = server.address().port;
  logger.info('listening', { port: actualPort });

  let closing = null;
  /** Graceful shutdown: stop accepting, let in-flight sends finish, then release the DB. */
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await worker.stop();
      await pool.end();
    })();
    return closing;
  }

  return { server, app, pool, repo, stock, worker, port: actualPort, close };
}

module.exports = { start };
