'use strict';
/**
 * Programmable upstreams. They are deliberately hostile on demand: they can lie, flap, hang,
 * accept an email and then drop the connection, and replay idempotency keys.
 */
const http = require('node:http');

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
}
const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });

/* ---------------------------- stock API ---------------------------- */
async function mockStock({ key = 'stock-key', port: fixedPort = 0 } = {}) {
  const state = {
    key,
    products: new Map(),
    behaviours: [], // queue of 'status:503' | 'hang' consumed per request
    calls: [],
    set(sku, patch) {
      const p = state.products.get(sku) || { sku, name: sku, quantity: 0, image_url: null, price: 19.5, currency: 'USD' };
      state.products.set(sku, { ...p, ...patch });
    },
  };
  const view = (p) => ({ ...p, in_stock: p.quantity > 0 });
  const server = http.createServer(async (req, res) => {
    state.calls.push(req.url);
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401).end('{}');
      return;
    }
    const b = state.behaviours.shift();
    if (b === 'hang') return; // never answers
    if (b && b.startsWith('status:')) {
      res.writeHead(Number(b.slice(7))).end('{"error":"mock"}');
      return;
    }
    if (b === 'garbage') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('<html>nope');
      return;
    }
    const path = req.url.split('?')[0];
    res.setHeader('content-type', 'application/json');
    if (path === '/' || path === '') {
      res.end(JSON.stringify({ products: [...state.products.values()].map(view) }));
      return;
    }
    const sku = decodeURIComponent(path.slice(1));
    const p = state.products.get(sku);
    if (!p) {
      res.writeHead(404).end('{"error":"not found"}');
      return;
    }
    res.end(JSON.stringify(view(p)));
  });
  const port = await listen(server, fixedPort);
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))),
  });
}

/* ---------------------------- Resend-format API ---------------------------- */
async function mockResend({ key = 'resend-key', port: fixedPort = 0 } = {}) {
  const state = {
    key,
    inbox: [], // delivered, unique per idempotency key
    attempts: [], // every request we received
    byKey: new Map(),
    behaviours: [], // 'status:500' | 'drop-after-accept' | 'drop-before' | 'hang'
    delayMs: 0,
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/inbox') {
      res.setHeader('content-type', 'text/html');
      res.end(
        `<!doctype html><meta charset=utf-8><title>Mock inbox</title><body style="font:14px system-ui;padding:20px"><h1>Mock inbox (${state.inbox.length})</h1><ol>${state.inbox
          .map((m, i) => `<li><a href="/inbox/${i}">${m.to} — ${m.subject.replace(/</g, '&lt;')}</a></li>`)
          .join('')}</ol>`
      );
      return;
    }
    const mm = req.url.match(/^\/inbox\/(\d+)(\/text)?$/);
    if (req.method === 'GET' && mm) {
      const m = state.inbox[Number(mm[1])];
      if (!m) return res.writeHead(404).end();
      res.setHeader('content-type', mm[2] ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8');
      return res.end(mm[2] ? m.text : m.html);
    }
    if (req.method !== 'POST' || req.url !== '/emails') return res.writeHead(404).end('{}');
    const raw = await readBody(req);
    if (req.headers.authorization !== `Bearer ${key}`) return res.writeHead(401).end('{"message":"bad key"}');
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return res.writeHead(400).end('{"message":"bad json"}');
    }
    const idem = req.headers['idempotency-key'] || null;
    state.attempts.push({ idem, to: body.to });
    const b = state.behaviours.shift();
    if (b === 'hang') return;
    if (b === 'drop-before') return req.socket.destroy();
    if (b && b.startsWith('status:')) return res.writeHead(Number(b.slice(7))).end('{"message":"mock error"}');

    let rec = idem ? state.byKey.get(idem) : null;
    const replay = Boolean(rec);
    if (!rec) {
      rec = { id: `em_${state.inbox.length + 1}`, ...body, idem, at: Date.now() };
      if (idem) state.byKey.set(idem, rec);
      state.inbox.push(rec);
    }
    if (b === 'drop-after-accept') return req.socket.destroy(); // accepted, but the caller never learns
    res.writeHead(200, { 'content-type': 'application/json', ...(replay ? { 'idempotent-replayed': 'true' } : {}) });
    res.end(JSON.stringify({ id: rec.id }));
  });
  const port = await listen(server, fixedPort);
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))),
  });
}

module.exports = { mockStock, mockResend };
