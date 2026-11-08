'use strict';
/**
 * `npm run dev`: a complete local world, no keys or external services needed.
 *   - throwaway Postgres
 *   - mock store (catalogue + stock API) that restocks and sells out on its own and POSTs webhooks
 *   - mock Resend with a browsable inbox at http://localhost:4102/inbox
 *   - the real app on http://localhost:3000  (/embed, /admin  password: "letmein-admin")
 */
const { startCluster } = require('../test/support/pg');
const { mockStock, mockResend } = require('../test/support/mocks');
const { loadConfig } = require('../src/config');
const { start } = require('../src/runtime');

const SECRET = 'sim-webhook-secret-123456';
const PRODUCTS = [
  ['AERO-KETTLE', 'Aero Gooseneck Kettle', 0, 'kettle'],
  ['STONE-MUG', 'Stoneware Mug, Ash', 0, 'mug'],
  ['LINEN-THROW', 'Washed Linen Throw', 0, 'linen'],
  ['BRASS-LAMP', 'Brass Desk Lamp', 6, 'lamp'],
  ['OAK-TRAY', 'Oak Serving Tray', 0, 'tray'],
  ['FIELD-NOTES', 'Field Notes, 3-pack', 14, 'notes'],
  ['CAST-PAN', 'Cast Iron Skillet 26cm', 0, 'pan'],
  ['WOOL-SOCKS', 'Merino Hiking Socks', 0, 'socks'],
  ['GLASS-CARAFE', 'Hand-blown Carafe', 3, 'carafe'],
  ['PAPER-LANTERN', 'Paper Lantern, Large', 0, 'lantern'],
];
const NAMES = ['maya', 'jonas', 'priya', 'luca', 'amara', 'tomas', 'ines', 'kofi', 'yuki', 'noor', 'ben', 'sara', 'omar', 'elif', 'raj'];

(async () => {
  const cluster = await startCluster();
  const dbUrl = await cluster.createDb('encore_sim');
  const stock = await mockStock({ key: 'sim-stock-key', port: 4101 });
  const resend = await mockResend({ key: 'sim-resend-key', port: 4102 });
  for (const [sku, name, quantity, seed] of PRODUCTS) stock.set(sku, { name, quantity, image_url: `https://picsum.photos/seed/${seed}/600/400` });

  const config = loadConfig({
    DATABASE_URL: dbUrl, STOCK_API_URL: stock.url, STOCK_API_KEY: 'sim-stock-key', RESEND_API_KEY: 'sim-resend-key',
    RESEND_BASE_URL: resend.url, WEBHOOK_SECRET: SECRET, ADMIN_PASSWORD: 'letmein-admin', PORT: '3000',
    TRUST_PROXY: '1', STORE_NAME: 'Northline Goods', STORE_URL: 'https://example.com/shop', RECONCILE_INTERVAL_MS: '8000',
  });
  const app = await start(config);
  const base = `http://localhost:${app.port}`;
  const post = (path, body, headers = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...headers }, body: JSON.stringify(body) }).catch(() => {});

  // seed history
  const soldOut = PRODUCTS.filter((p) => p[2] === 0).map((p) => p[0]);
  for (let i = 0; i < 22; i++) await post('/api/requests', { email: `${NAMES[i % NAMES.length]}${i}@example.com`, sku: soldOut[i % soldOut.length] });
  let evt = 0;
  const hook = (sku, quantity) => post('/webhooks/stock', { event_id: `sim-${Date.now()}-${evt++}`, sku, quantity }, { 'x-webhook-secret': SECRET });
  stock.set('STONE-MUG', { quantity: 5 });
  await hook('STONE-MUG', 5);

  // the store never sleeps
  setInterval(async () => {
    const [sku] = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];
    const p = stock.products.get(sku);
    if (p.quantity === 0) {
      const q = 1 + Math.floor(Math.random() * 8);
      stock.set(sku, { quantity: q });
      await hook(sku, q);
      if (Math.random() < 0.5) await hook(sku, q); // senders retry
    } else if (Math.random() < 0.5) {
      stock.set(sku, { quantity: 0 });
      await hook(sku, 0);
    }
    if (Math.random() < 0.6) await post('/api/requests', { email: `${NAMES[Math.floor(Math.random() * NAMES.length)]}${Math.floor(Math.random() * 900)}@example.com`, sku: soldOut[Math.floor(Math.random() * soldOut.length)] });
  }, 4000);

  console.log(`\n  Encore sim running\n  embed   ${base}/embed\n  admin   ${base}/admin   (password: letmein-admin)\n  inbox   ${resend.url}/inbox\n`);
  const bye = async () => { await app.close(); await stock.close(); await resend.close(); await cluster.stop(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
})().catch((e) => { console.error(e); process.exit(1); });
