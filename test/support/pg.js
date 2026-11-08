'use strict';
/**
 * Throwaway Postgres for tests: initdb into a temp dir on a free port, one fresh database per test group.
 * Set TEST_PG_URL (an admin connection string) to use an existing server instead, e.g. in CI.
 */
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

function findBin(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  if (process.env.PG_BIN) return path.join(process.env.PG_BIN, exe);
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) if (d && fs.existsSync(path.join(d, exe))) return path.join(d, exe);
  const roots = ['C:/Program Files/PostgreSQL', '/usr/lib/postgresql', '/opt/homebrew/opt/postgresql@17/bin'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    if (fs.existsSync(path.join(root, exe))) return path.join(root, exe);
    for (const v of fs.readdirSync(root).sort().reverse()) {
      const p = path.join(root, v, 'bin', exe);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error(`Cannot find ${exe}. Install PostgreSQL or set PG_BIN / TEST_PG_URL.`);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

async function startCluster() {
  if (process.env.TEST_PG_URL) {
    const base = new URL(process.env.TEST_PG_URL);
    return {
      async createDb(name) {
        const c = new Client({ connectionString: process.env.TEST_PG_URL });
        await c.connect();
        await c.query(`DROP DATABASE IF EXISTS "${name}"`);
        await c.query(`CREATE DATABASE "${name}"`);
        await c.end();
        const u = new URL(base);
        u.pathname = `/${name}`;
        return u.toString();
      },
      async stop() {},
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-pg-'));
  const initdb = findBin('initdb');
  const pgctl = findBin('pg_ctl');
  execFileSync(initdb, ['-D', dir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-sync'], { stdio: 'ignore' });
  const port = await freePort();
  execFileSync(pgctl, ['start', '-D', dir, '-w', '-s', '-l', path.join(dir, 'log.txt'), '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=200`], {
    stdio: 'ignore',
  });
  let n = 0;
  return {
    async createDb(name = `t${Date.now()}_${n++}`) {
      const c = new Client({ connectionString: `postgres://postgres@127.0.0.1:${port}/postgres` });
      await c.connect();
      await c.query(`CREATE DATABASE "${name}"`);
      await c.end();
      return `postgres://postgres@127.0.0.1:${port}/${name}`;
    },
    async stop() {
      try {
        execFileSync(pgctl, ['stop', '-D', dir, '-m', 'immediate', '-s', '-w'], { stdio: 'ignore' });
      } catch {
        /* already stopped */
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

module.exports = { startCluster, freePort };
