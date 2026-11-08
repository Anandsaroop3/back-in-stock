'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('../src/util');
const session = require('../src/session');
const { normalize } = require('../src/stock');
const { renderEmail } = require('../src/templates/email');
const { Limiter, SCANNER_UA, PROBE_PATH, ipKey } = require('../src/guard');
const { loadConfig } = require('../src/config');

test('html`` escapes by default and raw() opts out', () => {
  assert.equal(util.html`<b>${'<script>alert(1)</script>'}</b>`.value, '<b>&lt;script&gt;alert(1)&lt;/script&gt;</b>');
  assert.equal(util.html`<i>${util.raw('<u>x</u>')}</i>`.value, '<i><u>x</u></i>');
  assert.equal(util.html`${[util.html`<a>${'&'}</a>`, '<']}`.value, '<a>&amp;</a>&lt;');
  assert.equal(util.html`x${null}${undefined}${false}y`.value, 'xy');
  assert.equal(util.esc(`"'\``), '&quot;&#39;&#96;');
});

test('normalizeEmail accepts real addresses and rejects hostile ones', () => {
  assert.equal(util.normalizeEmail('  Jane.Doe+tag@Example.COM '), 'jane.doe+tag@example.com');
  for (const bad of [
    '', 'plain', 'a@b', '@x.com', 'a@@x.com', 'a b@x.com', 'a@x..com', 'a@-x.com', 'a@x.cöm',
    'a@b.com\r\nBcc: victim@x.com', 'a@b.com\nSubject: hi', '<script>@x.com', 'a'.repeat(65) + '@x.com',
    'a@' + 'b'.repeat(250) + '.com', null, undefined, 42, {}, ['a@b.com'],
  ]) assert.equal(util.normalizeEmail(bad), null, `should reject ${JSON.stringify(bad)}`);
});

test('normalizeSku / isEventId are strict allow-lists', () => {
  assert.equal(util.normalizeSku('ABC-123_x.9'), 'ABC-123_x.9');
  for (const bad of ['', ' ', "a'b", 'a b', '../x', 'a/b', '-lead', 'x'.repeat(65), null, 5, 'a;DROP TABLE']) assert.equal(util.normalizeSku(bad), null);
  assert.ok(util.isEventId('evt_01:abc-2.x'));
  for (const bad of ['', 'a b', 'x\n', 'a'.repeat(129), null, 7]) assert.equal(util.isEventId(bad), false);
});

test('csvCell neutralises formula injection and quotes properly', () => {
  assert.equal(util.csvCell('=1+1'), "'=1+1");
  assert.equal(util.csvCell('+cmd'), "'+cmd");
  assert.equal(util.csvCell('-2'), "'-2");
  assert.equal(util.csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(util.csvCell('a,"b"'), '"a,""b"""');
  assert.equal(util.csvCell(null), '');
});

test('safeEqual / ticketCode / fmtDuration / maskEmail', () => {
  assert.ok(util.safeEqual('abc', 'abc'));
  assert.ok(!util.safeEqual('abc', 'abd'));
  assert.ok(!util.safeEqual('abc', 'abcd'));
  const a = util.ticketCode('s', 'a@b.com', 'X1');
  assert.match(a, /^E-[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.equal(a, util.ticketCode('s', 'a@b.com', 'X1'));
  assert.notEqual(a, util.ticketCode('s', 'a@b.com', 'X2'));
  assert.notEqual(a, util.ticketCode('other', 'a@b.com', 'X1'));
  assert.equal(util.fmtDuration(3 * 86400e3 + 4 * 3600e3), '3d 4h');
  assert.equal(util.fmtDuration(65e3), '1m');
  assert.equal(util.maskEmail('jane@x.com'), 'j***@x.com');
});

test('stock.normalize trusts nothing from upstream', () => {
  assert.equal(normalize({ sku: 'A', quantity: 0, in_stock: true }, 'A').inStock, false, 'flag true but quantity 0 => not in stock');
  assert.equal(normalize({ sku: 'A', quantity: 3, in_stock: false }, 'A').inStock, false);
  assert.equal(normalize({ sku: 'A', quantity: 3 }, 'A').inStock, true);
  assert.equal(normalize({ sku: 'A', in_stock: true }, 'A').inStock, true);
  assert.equal(normalize({ quantity: 2 }, 'FALLBACK').sku, 'FALLBACK');
  assert.equal(normalize({ sku: 'A', quantity: -4 }, 'A').inStock, false);
  assert.equal(normalize({ sku: 'A', quantity: 1.5 }, 'A').inStock, false);
  assert.equal(normalize({ sku: 'A', quantity: 1, image: 'http://insecure/x.png' }, 'A').image, null);
  assert.equal(normalize({ sku: 'A', quantity: 1, image: 'javascript:alert(1)' }, 'A').image, null);
  assert.match(normalize({ sku: 'A', quantity: 1, image: 'https://cdn.x/i.png' }, 'A').image, /^https:\/\/cdn\.x\//);
  const n = normalize({ sku: 'A', quantity: 1, name: 'Bad\r\nName' + 'x'.repeat(500) }, 'A').name;
  assert.ok(!/[\r\n]/.test(n) && n.length <= 140);
  assert.equal(normalize(null, 'A'), null);
  assert.equal(normalize('str', 'A'), null);
});

test('email: responsive HTML, plain-text twin, everything escaped', () => {
  const evil = '<img src=x onerror=alert(1)>"\'';
  const m = renderEmail({
    storeName: '<b>Store</b>', productName: evil, imageUrl: 'https://cdn.x/i.png?a=1&b="2"', price: '$19.50', quantity: 3,
    ctaUrl: 'https://shop.x/p?a=1&b="x"', waitedMs: 3 * 86400e3, ticket: 'E-ABC123',
  });
  assert.match(m.html, /<meta name="viewport" content="width=device-width/);
  assert.match(m.html, /@media only screen and \(max-width:620px\)/);
  assert.match(m.html, /prefers-color-scheme:dark/);
  assert.ok(!m.html.includes('<img src=x'), 'product name must be escaped');
  assert.ok(!m.html.includes('<b>Store</b>'));
  assert.ok(m.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!/href="[^"]*"[^>]*"x"/.test(m.html), 'attribute break-out must not be possible');
  assert.match(m.html, /E-ABC123/);
  assert.match(m.html, /3d 0h/);
  assert.ok(!/[\r\n]/.test(m.subject), 'subject has no header-injection characters');
  assert.match(m.text, /Get it now: https:\/\/shop\.x\//);
  assert.match(m.text, /Only 3 left/);
  const plain = renderEmail({ storeName: 'S', productName: 'Kettle', imageUrl: null, price: null, quantity: 500, ctaUrl: 'https://s.x', waitedMs: NaN, ticket: 'E-X' });
  assert.ok(!/Only \d+ left/.test(plain.html), 'no fake scarcity when stock is plentiful');
  assert.ok(!plain.html.includes('<img class="hero"'));
});

test('session tokens: tamper-proof and expiring', () => {
  const secret = Buffer.from('k'.repeat(32));
  const { token, nonce } = session.issue(secret, 60);
  assert.deepEqual(session.verify(secret, token), { nonce });
  assert.equal(session.verify(Buffer.from('z'.repeat(32)), token), null, 'wrong secret');
  const parts = token.split('.');
  assert.equal(session.verify(secret, `${parts[0]}.${Number(parts[1]) + 999999}.${parts[2]}.${parts[3]}`), null, 'extended expiry');
  assert.equal(session.verify(secret, token.slice(0, -2) + 'AA'), null, 'bad signature');
  assert.equal(session.verify(secret, session.issue(secret, -5).token), null, 'expired');
  for (const junk of ['', 'a.b.c', null, undefined, 'v1..', 'x'.repeat(500)]) assert.equal(session.verify(secret, junk), null);
  assert.notEqual(session.csrfToken(secret, 'n1'), session.csrfToken(secret, 'n2'));
  assert.deepEqual(session.parseCookies('a=1; b=two=2;  c = 3'), { a: '1', b: 'two=2', c: '3' });
});

test('scanner signatures and probe paths', () => {
  for (const ua of ['Mozilla/5.0 (compatible; Nmap Scripting Engine; https://nmap.org/book/nse.html)', 'sqlmap/1.7', 'Nikto/2.5', 'masscan/1.3', 'gobuster/3.6', 'Nuclei - Open-source project']) assert.ok(SCANNER_UA.test(ua), ua);
  for (const ua of ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126 Safari/537.36', 'curl/8.4.0', '']) assert.ok(!SCANNER_UA.test(ua), ua);
  for (const p of ['/.env', '/.git/config', '/wp-login.php', '/phpmyadmin/', '/a/../../etc/passwd', '/x.php?id=1', '/assets/%2e%2e/secret', '/cgi-bin/test']) assert.ok(PROBE_PATH.test(p), p);
  for (const p of ['/embed', '/embed?sku=ABC', '/admin', '/api/products/A-1', '/assets/embed.css', '/webhooks/stock']) assert.ok(!PROBE_PATH.test(p), p);
});

test('ipKey buckets IPv6 by /64 and unwraps mapped IPv4', () => {
  assert.equal(ipKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipKey('2001:db8:1:2:1:2:3:4'));
  assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
});

test('Limiter: window, peek does not consume', async () => {
  const l = new Limiter({ windowMs: 80, max: 3 });
  assert.ok(l.consume('k').ok && l.consume('k').ok && l.consume('k').ok);
  assert.ok(!l.consume('k').ok);
  assert.ok(l.consume('other').ok, 'keys are independent');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(l.consume('k').ok, 'window resets');
  const p = new Limiter({ windowMs: 1000, max: 1 });
  for (let i = 0; i < 5; i++) assert.ok(p.peek('x').ok);
  p.consume('x');
  assert.ok(!p.peek('x').ok);
});

test('config fails fast and enforces production strength', () => {
  const ok = {
    DATABASE_URL: 'postgres://x/y', STOCK_API_URL: 'https://s.x/api/', STOCK_API_KEY: 'k', RESEND_API_KEY: 'r',
    RESEND_BASE_URL: 'https://r.x/', WEBHOOK_SECRET: 'w'.repeat(20), ADMIN_PASSWORD: 'p'.repeat(12),
  };
  const c = loadConfig(ok);
  assert.equal(c.stock.apiUrl, 'https://s.x/api', 'trailing slash stripped');
  assert.equal(c.resend.baseUrl, 'https://r.x');
  assert.throws(() => loadConfig({ ...ok, STOCK_API_KEY: '' }), /STOCK_API_KEY/);
  assert.throws(() => loadConfig({ ...ok, NODE_ENV: 'production', ADMIN_PASSWORD: 'short' }), /ADMIN_PASSWORD/);
  assert.throws(() => loadConfig({ ...ok, NODE_ENV: 'production', WEBHOOK_SECRET: 'tiny' }), /WEBHOOK_SECRET/);
  assert.throws(() => loadConfig({ ...ok, STOCK_API_URL: 'ftp://x' }), /http/);
  assert.throws(() => loadConfig({ ...ok, PORT: '99999' }), /Invalid integer/);
  assert.notDeepEqual(loadConfig(ok).sessionSecret, loadConfig({ ...ok, ADMIN_PASSWORD: 'q'.repeat(12) }).sessionSecret, 'rotating the password invalidates sessions');
});

test('config: unresolved or malformed DATABASE_URL fails fast with an actionable message', () => {
  const ok = {
    STOCK_API_URL: 'https://s.x/api', STOCK_API_KEY: 'k', RESEND_API_KEY: 'r', RESEND_BASE_URL: 'https://r.x',
    WEBHOOK_SECRET: 'w'.repeat(20), ADMIN_PASSWORD: 'p'.repeat(12),
  };
  assert.throws(() => loadConfig({ ...ok, DATABASE_URL: '${{Postgres.DATABASE_URL}}' }), /unresolved Railway reference/);
  assert.throws(() => loadConfig({ ...ok, DATABASE_URL: 'not a url' }), /not a valid connection URL/);
  assert.ok(loadConfig({ ...ok, DATABASE_URL: 'postgresql://u:p@postgres.railway.internal:5432/railway' }));
});
