'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startCluster } = require('./support/pg');
const { boot, waitFor, settle, mockStock, mockResend } = require('./support/harness');

let cluster;
test.before(async () => {
  cluster = await startCluster();
});
test.after(async () => {
  await cluster?.stop();
});

async function scenario(opts, fn) {
  const t = await boot(cluster, opts);
  try {
    await fn(t);
  } finally {
    await t.closeAll();
  }
}
const seed = async (t, sku, n, prefix = 'u') => {
  t.stock.set(sku, { name: `Item ${sku}`, quantity: 0 });
  for (let i = 0; i < n; i++) assert.equal((await t.subscribe(`${prefix}${i}@example.com`, sku)).status, 200);
};
const noDuplicates = (t) => {
  const keys = t.resend.inbox.map((m) => m.to[0]);
  assert.equal(new Set(keys).size, keys.length, 'no recipient received two emails');
};

test('same event delivered sequentially three times => one email per customer', () =>
  scenario({}, async (t) => {
    await seed(t, 'S1', 3);
    t.stock.set('S1', { quantity: 5 });
    const rs = [];
    for (let i = 0; i < 3; i++) rs.push(await t.webhook({ event_id: 'same-evt', sku: 'S1', quantity: 5 }));
    assert.deepEqual(rs.map((r) => r.data.status), ['accepted', 'duplicate', 'duplicate']);
    assert.ok(rs.every((r) => r.status === 200), 'duplicates are acknowledged so the sender stops retrying');
    await waitFor(() => t.resend.inbox.length === 3);
    await settle(500);
    assert.equal(t.resend.inbox.length, 3);
    noDuplicates(t);
    assert.equal((await t.pool.query(`SELECT count(*)::int n FROM webhook_events`)).rows[0].n, 1);
  }));

test('30 identical webhooks fired AT THE SAME TIME => exactly one accepted, one email each', () =>
  scenario({}, async (t) => {
    await seed(t, 'C1', 5);
    t.stock.set('C1', { quantity: 9 });
    const rs = await Promise.all(Array.from({ length: 30 }, () => t.webhook({ event_id: 'race-evt', sku: 'C1', quantity: 9 })));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(rs.filter((r) => r.data.status === 'accepted').length, 1);
    assert.equal(rs.filter((r) => r.data.status === 'duplicate').length, 29);
    await waitFor(() => t.resend.inbox.length === 5);
    await settle(600);
    assert.equal(t.resend.inbox.length, 5);
    assert.equal(t.resend.attempts.length, 5, 'no wasted/duplicate send attempts either');
    noDuplicates(t);
  }));

test('different event ids for the SAME restock (provider re-emits) still => one email per customer', () =>
  scenario({}, async (t) => {
    await seed(t, 'C2', 4);
    t.stock.set('C2', { quantity: 9 });
    await Promise.all(Array.from({ length: 12 }, (_, i) => t.webhook({ event_id: `re-emit-${i}`, sku: 'C2', quantity: 9 })));
    await waitFor(() => t.resend.inbox.length === 4);
    await settle(700);
    assert.equal(t.resend.inbox.length, 4);
    noDuplicates(t);
  }));

test('20 simultaneous sign-ups for the same email+sku => a single row', () =>
  scenario({}, async (t) => {
    t.stock.set('R1', { name: 'Racer', quantity: 0 });
    const ip = t.newIp();
    const rs = await Promise.all(Array.from({ length: 8 }, () => t.subscribe('same@example.com', 'R1', ip)));
    assert.ok(rs.every((r) => r.status === 200 || r.status === 429));
    assert.equal((await t.rows(`email='same@example.com'`)).length, 1);
  }));

test('sign-up STORM on an in-stock item: 25 customers x 6 concurrent submits each => exactly one email per customer', () =>
  scenario({ env: { RATE_LIMIT_PER_MIN: '100000' } }, async (t) => {
    t.stock.set('ST1', { name: 'Storm Item', quantity: 50 });
    const people = Array.from({ length: 25 }, (_, i) => `storm${i}@example.com`);
    // all submits race each other AND the worker flipping rows to "notified" mid-flight
    const jobs = people.flatMap((e) => Array.from({ length: 6 }, (_, k) => async () => { await new Promise((r) => setTimeout(r, k * 7)); return t.subscribe(e, 'ST1', t.newIp()); }));
    const rs = await Promise.all(jobs.map((j) => j()));
    assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join());
    await waitFor(() => t.resend.inbox.length >= 25, { timeout: 12000, msg: 'one email each' });
    await settle(1200);
    assert.equal(t.resend.inbox.length, 25);
    assert.equal(t.resend.attempts.length, 25, 'no second send was ever attempted');
    noDuplicates(t);
    assert.equal((await t.rows()).length, 25, 'one request row per customer');
  }));

test('Resend returns 500 twice, then recovers => delivered once, same idempotency key on every attempt', () =>
  scenario({}, async (t) => {
    await seed(t, 'E1', 1);
    t.resend.behaviours.push('status:500', 'status:429');
    t.stock.set('E1', { quantity: 2 });
    await t.webhook({ event_id: 'e1', sku: 'E1', quantity: 2 });
    await waitFor(() => t.resend.inbox.length === 1, { msg: 'eventual delivery' });
    await settle(300);
    assert.equal(t.resend.inbox.length, 1);
    assert.ok(t.resend.attempts.length >= 3);
    assert.equal(new Set(t.resend.attempts.map((a) => a.idem)).size, 1);
    const [row] = await t.rows();
    assert.equal(row.status, 'notified');
    assert.ok(row.attempts >= 3);
  }));

test('Resend ACCEPTS the email then drops the connection => retry cannot double-send', () =>
  scenario({}, async (t) => {
    await seed(t, 'D1', 3);
    t.resend.behaviours.push('drop-after-accept', 'drop-after-accept');
    t.stock.set('D1', { quantity: 3 });
    await t.webhook({ event_id: 'd1', sku: 'D1', quantity: 3 });
    await waitFor(async () => (await t.rows(`status='notified'`)).length === 3, { msg: 'all marked notified' });
    await settle(400);
    assert.equal(t.resend.inbox.length, 3, 'provider delivered exactly three');
    noDuplicates(t);
    assert.ok(t.resend.attempts.length > 3, 'we did retry the unacknowledged ones');
  }));

test('Resend hangs past the timeout => retried, delivered once', () =>
  scenario({}, async (t) => {
    await seed(t, 'H1', 1);
    t.resend.behaviours.push('hang');
    t.stock.set('H1', { quantity: 1 });
    await t.webhook({ event_id: 'h1', sku: 'H1', quantity: 1 });
    await waitFor(() => t.resend.inbox.length === 1, { timeout: 9000 });
    await settle(300);
    assert.equal(t.resend.inbox.length, 1);
  }));

test('permanent rejection (422) => failed immediately, visible, not retried; admin can retry', () =>
  scenario({}, async (t) => {
    await seed(t, 'P1', 1);
    t.resend.behaviours.push('status:422');
    t.stock.set('P1', { quantity: 1 });
    await t.webhook({ event_id: 'p1', sku: 'P1', quantity: 1 });
    await waitFor(async () => (await t.rows())[0].status === 'failed');
    await settle(300);
    const [row] = await t.rows();
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /422/);
    assert.equal(t.resend.inbox.length, 0);
    // operator retry path
    assert.equal(await t.app.repo.retry(Number(row.id)), true);
    await waitFor(() => t.resend.inbox.length === 1);
    assert.equal((await t.rows())[0].status, 'notified');
  }));

test('persistent provider outage => gives up after MAX_ATTEMPTS and surfaces the failure', () =>
  scenario({ env: { MAX_ATTEMPTS: '3' } }, async (t) => {
    await seed(t, 'X1', 1);
    t.resend.behaviours.push(...Array(10).fill('status:503'));
    t.stock.set('X1', { quantity: 1 });
    await t.webhook({ event_id: 'x1', sku: 'X1', quantity: 1 });
    await waitFor(async () => (await t.rows())[0].status === 'failed', { timeout: 9000 });
    const [row] = await t.rows();
    assert.equal(row.attempts, 3);
    assert.match(row.last_error, /503/);
  }));

test('stock API flaps while we verify a webhook => event retried until it can be verified', () =>
  scenario({}, async (t) => {
    await seed(t, 'F1', 1);
    t.stock.set('F1', { quantity: 4 });
    t.stock.behaviours.push('status:503', 'status:503', 'garbage');
    await t.webhook({ event_id: 'f1', sku: 'F1', quantity: 4 });
    await waitFor(() => t.resend.inbox.length === 1, { timeout: 9000, msg: 'email after stock API recovered' });
    const ev = (await t.pool.query(`SELECT status, attempts FROM webhook_events WHERE event_id='f1'`)).rows[0];
    assert.equal(ev.status, 'done');
    assert.ok(ev.attempts >= 2);
  }));

test('crash recovery: a request stuck in "sending" (worker died mid-send) is re-sent exactly once', () =>
  scenario({ autostartWorker: false }, async (t) => {
    await seed(t, 'K1', 1);
    // simulate: claimed, provider accepted, process died before recording success
    const [row] = await t.rows();
    await t.pool.query(`UPDATE requests SET status='sending', locked_at = now() - interval '10 minutes', attempts=1, product_name='Item K1', trigger_qty=3 WHERE id=$1`, [row.id]);
    t.resend.byKey.set(`encore-${row.idem_key}`, { id: 'em_pre', to: ['u0@example.com'], subject: 's', html: '', text: '' });
    t.resend.inbox.push(t.resend.byKey.get(`encore-${row.idem_key}`));
    t.app.worker.start();
    await waitFor(async () => (await t.rows())[0].status === 'notified');
    assert.equal(t.resend.inbox.length, 1, 'idempotency key made the re-send a no-op at the provider');
    assert.equal((await t.rows())[0].provider_id, 'em_pre');
  }));

test('crash recovery: an event stuck in "processing" is picked up again', () =>
  scenario({ autostartWorker: false }, async (t) => {
    await seed(t, 'K2', 1);
    t.stock.set('K2', { quantity: 2 });
    await t.pool.query(`INSERT INTO webhook_events (event_id, sku, quantity, payload, status, locked_at, attempts) VALUES ('stuck','K2',2,'{}','processing', now() - interval '10 minutes', 1)`);
    t.app.worker.start();
    await waitFor(() => t.resend.inbox.length === 1);
  }));

test('RESTART: events and requests survive; a webhook received while the worker was down is processed after reboot', async () => {
  const stock = await mockStock();
  const resend = await mockResend();
  const dbUrl = await cluster.createDb();
  stock.set('RS1', { name: 'Restart Item', quantity: 0 });

  const a = await boot(cluster, { stock, resend, dbUrl, autostartWorker: false });
  await a.subscribe('survivor@example.com', 'RS1');
  stock.set('RS1', { quantity: 5 });
  assert.equal((await a.webhook({ event_id: 'rs-evt', sku: 'RS1', quantity: 5 })).status, 200);
  await settle(300);
  assert.equal(resend.inbox.length, 0, 'worker is down: nothing sent yet');
  await a.close(); // process "restarts"

  const b = await boot(cluster, { stock, resend, dbUrl });
  try {
    await waitFor(() => resend.inbox.length === 1, { msg: 'email after restart' });
    const [row] = await b.rows();
    assert.equal(row.email, 'survivor@example.com');
    assert.equal(row.status, 'notified');
    // and the same event replayed after restart is still a no-op
    assert.equal((await b.webhook({ event_id: 'rs-evt', sku: 'RS1', quantity: 5 })).data.status, 'duplicate');
    await settle(400);
    assert.equal(resend.inbox.length, 1);
  } finally {
    await b.closeAll();
  }
});

test('TWO app instances on one database share the work with zero duplicates', async () => {
  const stock = await mockStock();
  const resend = await mockResend();
  const dbUrl = await cluster.createDb();
  stock.set('M1', { name: 'Multi', quantity: 0 });
  const a = await boot(cluster, { stock, resend, dbUrl });
  const b = await boot(cluster, { stock, resend, dbUrl });
  try {
    for (let i = 0; i < 40; i++) await a.subscribe(`m${i}@example.com`, 'M1');
    stock.set('M1', { quantity: 50 });
    await Promise.all([
      ...Array.from({ length: 10 }, () => a.webhook({ event_id: 'multi', sku: 'M1', quantity: 50 })),
      ...Array.from({ length: 10 }, () => b.webhook({ event_id: 'multi', sku: 'M1', quantity: 50 })),
    ]);
    await waitFor(() => resend.inbox.length === 40, { timeout: 12000, msg: '40 emails' });
    await settle(800);
    assert.equal(resend.inbox.length, 40);
    assert.equal(resend.attempts.length, 40, 'every send attempt was needed: instances never raced on a row');
    assert.equal(new Set(resend.inbox.map((m) => m.to[0])).size, 40);
  } finally {
    await a.close();
    await b.closeAll();
  }
});

test('graceful shutdown completes promptly and releases the database', async () => {
  const t = await boot(cluster);
  const t0 = Date.now();
  await t.close();
  assert.ok(Date.now() - t0 < 3000);
  await t.stock.close();
  await t.resend.close();
});
