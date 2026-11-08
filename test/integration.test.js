'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startCluster } = require('./support/pg');
const { boot, waitFor, settle, ADMIN } = require('./support/harness');

let cluster;
let t; // booted app
test.before(async () => {
  cluster = await startCluster();
  t = await boot(cluster);
  t.stock.set('KET-1', { name: 'Aero Kettle', quantity: 0, image_url: 'https://cdn.example.com/kettle.png' });
  t.stock.set('MUG-2', { name: 'Stoneware Mug', quantity: 0 });
  t.stock.set('LAMP-3', { name: 'Brass Lamp', quantity: 5 });
});
test.after(async () => {
  await t?.closeAll();
  await cluster?.stop();
});

const inboxFor = (to) => t.resend.inbox.filter((m) => m.to.includes(to));

test('GET /embed serves the form, frameable, with strict CSP and no tech banner', async () => {
  const r = await t.req('GET', '/embed');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.text, /<form[^>]*id="form"/);
  assert.match(r.text, /name="email"/);
  assert.match(r.text, /name="sku"/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors \*/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), null, 'embed must be frameable');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(r.text), 'no inline scripts');
  assert.ok(!/\son\w+\s*=/i.test(r.text), 'no inline event handlers');
});

test('static assets are served and nothing outside /public is reachable', async () => {
  for (const f of ['embed.css', 'embed.js', 'admin.css', 'admin.js']) {
    const r = await t.req('GET', `/assets/${f}`);
    assert.equal(r.status, 200, f);
  }
  assert.equal((await t.req('GET', '/assets/nope.js')).status, 404);
  assert.equal((await t.req('GET', '/assets/')).status, 404, 'no directory listing');
});

test('catalogue and product lookups feed the form', async () => {
  const c = await t.req('GET', '/api/catalogue');
  assert.equal(c.status, 200);
  assert.ok(c.data.products.length >= 3);
  assert.equal(c.data.products[0].inStock, false, 'sold-out items first');
  const p = await t.req('GET', '/api/products/KET-1');
  assert.equal(p.status, 200);
  assert.equal(p.data.name, 'Aero Kettle');
  assert.equal(p.data.inStock, false);
  const unk = await t.req('GET', '/api/products/NOPE-1');
  assert.equal(unk.status, 200, 'the provider treats any SKU as valid (quantity 0)');
  assert.equal(unk.data.known, false);
  assert.equal(p.data.known, true);
  assert.equal((await t.req('GET', '/api/products/bad%20sku')).status, 400);
});

test('POST /api/requests: happy path stores one open request', async () => {
  const r = await t.subscribe('Jane@Example.com', 'KET-1');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.status, 'waiting');
  assert.match(r.data.ticket, /^E-[0-9A-Z]{6}$/);
  assert.equal(r.data.position, 1);
  assert.equal(r.data.inStockNow, false);
  assert.equal(r.data.product.name, 'Aero Kettle');
  const rows = await t.rows(`sku='KET-1'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'jane@example.com', 'email normalised');
  assert.equal(rows[0].status, 'open');
});

test('no duplicate open requests (case/space-insensitive), identical response either way', async () => {
  const a = await t.subscribe('dup@example.com', 'MUG-2');
  const b = await t.subscribe('  DUP@Example.com ', 'MUG-2');
  assert.equal(a.status, b.status);
  assert.deepEqual(Object.keys(a.data).sort(), Object.keys(b.data).sort());
  assert.equal(a.data.ticket, b.data.ticket);
  assert.equal((await t.rows(`email='dup@example.com' AND sku='MUG-2'`)).length, 1);
  // different SKU is a different request
  await t.subscribe('dup@example.com', 'KET-1');
  assert.equal((await t.rows(`email='dup@example.com'`)).length, 2);
});

test('validation: every bad input gets a precise 4xx and writes nothing', async () => {
  const before = (await t.rows()).length;
  const cases = [
    [{ email: 'nope', sku: 'KET-1' }, 400, 'invalid_email'],
    [{ email: 'a@b.com', sku: "x' OR 1=1--" }, 400, 'invalid_sku'],
    [{ email: 'a@b.com' }, 400, 'invalid_sku'],
    [{ sku: 'KET-1' }, 400, 'invalid_email'],
    [{ email: ['a@b.com'], sku: 'KET-1' }, 400, 'invalid_email'],
    [{ email: 'a@b.com', sku: { $ne: null } }, 400, 'invalid_sku'],
    [[], 400, 'invalid_body'],
  ];
  for (const [body, status, code] of cases) {
    const r = await t.req('POST', '/api/requests', { body });
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal(r.data.error.code, code, JSON.stringify(body));
  }
  assert.equal((await t.req('POST', '/api/requests', { body: 'email=a@b.com&sku=KET-1', json: false, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await t.req('POST', '/api/requests', { body: '{bad json', json: false, headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await t.req('POST', '/api/requests', { body: JSON.stringify({ email: 'a@b.com', sku: 'KET-1', pad: 'x'.repeat(9000) }), json: false, headers: { 'content-type': 'application/json' } })).status, 413);
  assert.equal((await t.rows()).length, before);
});

test('stock API down: we refuse politely (503) rather than store unverified requests', async () => {
  t.stock.behaviours.push('status:503');
  const before = (await t.rows()).length;
  const r = await t.subscribe('late@example.com', 'KET-1');
  assert.equal(r.status, 503);
  assert.equal(r.data.error.code, 'stock_unavailable');
  assert.equal((await t.rows()).length, before);
});

test('restock webhook: each waiting customer is emailed once; admin shows status + notified time', async () => {
  t.stock.set('FLOW-1', { name: 'Linen Throw', quantity: 0 });
  await t.subscribe('a1@example.com', 'FLOW-1');
  await t.subscribe('a2@example.com', 'FLOW-1');
  await t.subscribe('other@example.com', 'MUG-2');
  t.stock.set('FLOW-1', { quantity: 7 });

  const w = await t.webhook({ event_id: 'evt-flow-1', sku: 'FLOW-1', quantity: 7, extra: 'ignored' });
  assert.equal(w.status, 200);
  assert.equal(w.data.status, 'accepted');

  await waitFor(() => inboxFor('a1@example.com').length && inboxFor('a2@example.com').length, { msg: 'both emails' });
  await settle();
  assert.equal(inboxFor('a1@example.com').length, 1);
  assert.equal(inboxFor('a2@example.com').length, 1);
  assert.equal(inboxFor('other@example.com').length, 0, 'other SKU untouched');

  const m = inboxFor('a1@example.com')[0];
  assert.equal(m.subject, 'Linen Throw is back in stock');
  assert.match(m.html, /Linen Throw is back/);
  assert.match(m.html, /width=device-width/);
  assert.ok(m.text.includes('Linen Throw'));
  assert.deepEqual(m.to, ['a1@example.com']);
  assert.ok(m.idem?.startsWith('encore-'), 'sent with an idempotency key');

  const rows = await t.rows(`sku='FLOW-1'`);
  for (const row of rows) {
    assert.equal(row.status, 'notified');
    assert.ok(row.notified_at);
    assert.ok(row.provider_id);
    assert.equal(row.trigger_event, 'evt-flow-1');
  }
  const [mug] = await t.rows(`email='other@example.com'`);
  assert.equal(mug.status, 'open');
  assert.equal(mug.notified_at, null);

  const admin = await t.req('GET', '/admin', { headers: { authorization: 'Basic ' + Buffer.from(`admin:${ADMIN}`).toString('base64'), accept: 'text/html' } });
  assert.equal(admin.status, 200);
  assert.match(admin.text, /a1@example\.com/);
  assert.match(admin.text, /chip--notified/);
  assert.match(admin.text, /<time datetime="20\d\d-/);
  assert.match(admin.text, /Linen Throw/);
});

test('after being notified: re-asking while still in stock does NOT email again; after a sell-out it queues for the next restock', async () => {
  // still in stock (qty 7) and already emailed <24h ago => no second email, no new row
  const again = await t.subscribe('a1@example.com', 'FLOW-1');
  assert.equal(again.status, 200);
  await settle(400);
  assert.equal(inboxFor('a1@example.com').length, 1);
  assert.equal((await t.rows(`email='a1@example.com' AND sku='FLOW-1'`)).length, 1);

  // item sells out; now a fresh ask is legitimate and waits for the NEXT restock
  t.stock.set('FLOW-1', { quantity: 0 });
  await t.webhook({ event_id: 'evt-flow-1b', sku: 'FLOW-1', quantity: 0 });
  await t.subscribe('a1@example.com', 'FLOW-1');
  await settle(400);
  assert.equal(inboxFor('a1@example.com').length, 1, 'no email while sold out');
  assert.deepEqual((await t.rows(`email='a1@example.com' AND sku='FLOW-1'`)).map((x) => x.status), ['notified', 'open']);

  t.stock.set('FLOW-1', { quantity: 3 });
  await t.webhook({ event_id: 'evt-flow-1c', sku: 'FLOW-1', quantity: 3 });
  await waitFor(() => inboxFor('a1@example.com').length === 2, { msg: 'second restock email' });
});

test('a webhook that lies (says in stock, API says no) sends nothing', async () => {
  t.stock.set('LIE-1', { name: 'Phantom Item', quantity: 0 });
  await t.subscribe('liar@example.com', 'LIE-1');
  const w = await t.webhook({ event_id: 'evt-lie', sku: 'LIE-1', quantity: 99 });
  assert.equal(w.status, 200);
  await waitFor(async () => (await t.pool.query(`SELECT status FROM webhook_events WHERE event_id='evt-lie'`)).rows[0]?.status === 'ignored', { msg: 'event ignored' });
  assert.equal(inboxFor('liar@example.com').length, 0);
  const note = (await t.pool.query(`SELECT note FROM webhook_events WHERE event_id='evt-lie'`)).rows[0].note;
  assert.match(note, /not trusted/);
  assert.equal((await t.rows(`email='liar@example.com'`))[0].status, 'open');
});

test('a sold-out event (quantity 0) never emails anyone', async () => {
  t.stock.set('SO-1', { name: 'Sold Thing', quantity: 4 });
  await t.subscribe('so@example.com', 'SO-1'); // in stock => released immediately; reset to isolate
  await waitFor(() => inboxFor('so@example.com').length === 1);
  const before = t.resend.inbox.length;
  await t.webhook({ event_id: 'evt-so-0', sku: 'SO-1', quantity: 0 });
  await settle(300);
  assert.equal(t.resend.inbox.length, before);
});

test('webhook for an unknown SKU is stored then ignored', async () => {
  const w = await t.webhook({ event_id: 'evt-ghost', sku: 'GHOST-9', quantity: 3 });
  assert.equal(w.status, 200);
  await waitFor(async () => (await t.pool.query(`SELECT status,note FROM webhook_events WHERE event_id='evt-ghost'`)).rows[0]?.status === 'ignored');
});

test('asking about an item that is in stock right now is emailed immediately, exactly once', async () => {
  const r = await t.subscribe('eager@example.com', 'LAMP-3');
  assert.equal(r.data.inStockNow, true);
  await waitFor(() => inboxFor('eager@example.com').length === 1, { msg: 'immediate email' });
  await t.subscribe('eager@example.com', 'LAMP-3');
  await settle(500);
  assert.equal(inboxFor('eager@example.com').length, 1, 'repeat ask while queued/sent is not a second email');
});

test('reconciliation: a restock whose webhook never arrives is still caught', async () => {
  t.stock.set('MISS-1', { name: 'Lost Webhook Lamp', quantity: 0 });
  await t.subscribe('patient@example.com', 'MISS-1');
  t.stock.set('MISS-1', { quantity: 3 }); // NO webhook
  await waitFor(() => inboxFor('patient@example.com').length === 1, { timeout: 9000, msg: 'reconcile email' });
  await settle(600);
  assert.equal(inboxFor('patient@example.com').length, 1);
  const [row] = await t.rows(`email='patient@example.com'`);
  assert.equal(row.status, 'notified');
  assert.match(row.trigger_event, /^reconcile:/);
});

test('health endpoint reflects the database', async () => {
  const r = await t.req('GET', '/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
});

test('REAL-PROVIDER BEHAVIOUR: per-SKU payload has no name; any SKU is valid; hand-set stock on an off-catalogue SKU still notifies', async () => {
  t.app.stock.missRefreshMs = 0; // deterministic: a catalogue miss refreshes immediately
  t.stock.minimalLive = true; // per-SKU answers {sku, quantity, in_stock} only, like the real harness
  try {
    t.stock.set('REAL-1', { name: 'Gooseneck Kettle, Matte Black', quantity: 0 });
    const known = await t.subscribe('real1@example.com', 'REAL-1');
    assert.equal(known.data.product.name, 'Gooseneck Kettle, Matte Black', 'name comes from the catalogue');
    assert.equal(known.data.product.known, true);

    // not in the catalogue: the provider lets you set stock for it by hand, so it must be accepted
    const off = await t.subscribe('real2@example.com', 'HANDSET-9');
    assert.equal(off.status, 200);
    assert.equal(off.data.product.known, false);
    assert.equal(off.data.product.name, 'HANDSET-9');

    t.stock.set('REAL-1', { quantity: 3 });
    t.stock.products.set('HANDSET-9', { sku: 'HANDSET-9', name: 'HANDSET-9', quantity: 4 }); // "Set stock by hand"
    await t.webhook({ event_id: 'real-1', sku: 'REAL-1', quantity: 3 });
    await t.webhook({ event_id: 'real-2', sku: 'HANDSET-9', quantity: 4 });
    await waitFor(() => inboxFor('real1@example.com').length && inboxFor('real2@example.com').length, { msg: 'both emails' });
    assert.equal(inboxFor('real1@example.com')[0].subject, 'Gooseneck Kettle, Matte Black is back in stock', 'enriched name reaches the email');
    assert.match(inboxFor('real2@example.com')[0].subject, /HANDSET-9 is back in stock/);
  } finally {
    t.app.stock.missRefreshMs = 2000;
    t.stock.minimalLive = false;
  }
});

test('admin dashboard: 24h activity chart renders, CSP-clean, and counts what happened', async () => {
  const r = await t.req('GET', '/admin', { headers: { authorization: 'Basic ' + Buffer.from(`admin:${ADMIN}`).toString('base64'), accept: 'text/html' } });
  assert.equal(r.status, 200);
  assert.match(r.text, /<svg class="activity"/);
  assert.equal((r.text.match(/<g><title>/g) || []).length, 24, 'one slot per hour');
  assert.match(r.text, /bar-req/, 'requests were made in the last hour');
  assert.match(r.text, /bar-ok/, 'emails were sent in the last hour');
  assert.ok(!/\sstyle="/i.test(r.text), 'no inline style attributes (strict CSP)');
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(r.text), 'no inline scripts');
});

test('migrations are ordered, recorded, and idempotent (002 index present, re-run is a no-op)', async () => {
  const done = (await t.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((x) => x.name);
  assert.deepEqual(done, ['001_init.sql', '002_notified_index.sql']);
  const idx = await t.pool.query(`SELECT 1 FROM pg_indexes WHERE indexname='requests_notified_at'`);
  assert.equal(idx.rowCount, 1);
  const { migrate } = require('../src/db');
  await migrate(t.pool);
  assert.equal((await t.pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 2);
});
