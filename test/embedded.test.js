'use strict';
// Zero-config mode: with no DATABASE_URL the app must come up on its own (embedded PostgreSQL),
// keep its guarantees, and survive a restart. This is what `docker run` with only the app's own env vars gets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { boot, waitFor, settle } = require('./support/harness');

test('embedded mode: boots without DATABASE_URL, emails exactly once, and persists across a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-embedded-'));
  const stock = await require('./support/mocks').mockStock();
  const resend = await require('./support/mocks').mockResend();
  stock.set('KET-1', { name: 'Aero Kettle', quantity: 0 });
  const opts = { embedded: true, stock, resend, env: { DATA_DIR: dir } };
  let t = await boot(null, opts);
  try {
    assert.equal(t.app.pool.embedded, true);
    assert.equal((await t.req('GET', '/healthz')).status, 200);
    assert.equal((await t.subscribe('a@example.com', 'KET-1')).status, 200);
    assert.equal((await t.subscribe('a@example.com', 'KET-1')).status, 200, 'duplicate accepted, not stored twice');
    assert.equal((await t.rows()).length, 1);

    // restart: the request is still there and still waiting
    await t.close();
    t = await boot(null, opts);
    assert.equal((await t.rows()).length, 1, 'survived restart');

    // restock + replayed webhook: exactly one email
    stock.set('KET-1', { name: 'Aero Kettle', quantity: 5 });
    const ev = { event_id: 'evt_embedded_1', sku: 'KET-1', quantity: 5 };
    assert.equal((await t.webhook(ev)).status, 200);
    assert.equal((await t.webhook(ev)).status, 200);
    await waitFor(async () => (await t.rows("status='notified'")).length === 1, { msg: 'notified' });
    await settle(500);
    assert.equal(resend.inbox.filter((m) => m.to.includes('a@example.com')).length, 1);
  } finally {
    await t.close();
    await stock.close();
    await resend.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
