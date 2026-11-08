'use strict';
/**
 * Security regression suite. Each test is tagged with the OWASP Top 10 (2021) / API Top 10 (2023)
 * category it defends, so a reviewer can trace claim -> proof.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { startCluster } = require('./support/pg');
const { boot, waitFor, settle, ADMIN, SECRET } = require('./support/harness');
const session = require('../src/session');

let cluster, t;
test.before(async () => {
  cluster = await startCluster();
  t = await boot(cluster);
  t.stock.set('SEC-1', { name: 'Secure Thing', quantity: 0 });
  t.stock.set('SEC-2', { name: 'Second Thing', quantity: 0 });
});
test.after(async () => {
  await t?.closeAll();
  await cluster?.stop();
});

const basic = (pw = ADMIN) => ({ authorization: 'Basic ' + Buffer.from(`admin:${pw}`).toString('base64') });
const htmlAccept = { accept: 'text/html' };
const form = (o) => new URLSearchParams(o).toString();

async function login(app, ip) {
  const r = await app.req('POST', '/admin/login', { body: form({ password: ADMIN }), json: false, ip, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { r, cookie };
}
const csrfFrom = (htmlText) => (htmlText.match(/name="_csrf" value="([^"]+)"/) || [])[1];

function rawRequest(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'x-forwarded-for': t.newIp(), ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const eventCount = async () => (await t.pool.query('SELECT count(*)::int n FROM webhook_events')).rows[0].n;

/* ===================== A05 Security misconfiguration / headers ===================== */
test('[A05] hardening headers on every surface; CSP forbids inline script and style', async () => {
  const surfaces = [
    ['GET', '/embed'], ['GET', '/api/catalogue'], ['GET', '/healthz'], ['GET', '/admin'], ['GET', '/nonexistent'],
  ];
  for (const [m, p] of surfaces) {
    const r = await t.req(m, p);
    const h = (n) => r.headers.get(n);
    assert.equal(h('x-content-type-options'), 'nosniff', p);
    assert.equal(h('referrer-policy'), 'same-origin', p);
    assert.equal(h('x-powered-by'), null, p);
    assert.equal(h('server'), null, p);
    assert.match(h('permissions-policy'), /camera=\(\)/, p);
    assert.match(h('content-security-policy'), /default-src 'none'/, p);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(h('content-security-policy')), `${p}: no unsafe CSP`);
    // only the public catalogue is (briefly) cacheable; everything else must never be stored
    assert.equal(h('cache-control'), p === '/api/catalogue' ? 'public, max-age=10' : 'no-store', p);
  }
  const admin = await t.req('GET', '/admin', { headers: htmlAccept });
  assert.equal(admin.headers.get('x-frame-options'), 'DENY');
  assert.match(admin.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(admin.headers.get('x-robots-tag'), /noindex/);
  const api = await t.req('GET', '/api/catalogue');
  assert.equal(api.headers.get('x-frame-options'), 'DENY');
});

test('[A05/API8] CORS is open only on the public credential-less API; never on admin or webhook', async () => {
  const pre = await t.req('OPTIONS', '/api/requests');
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal(pre.headers.get('access-control-allow-credentials'), null);
  for (const p of ['/admin', '/webhooks/stock']) {
    const r = await t.req('GET', p);
    assert.equal(r.headers.get('access-control-allow-origin'), null, p);
  }
});

test('[A05] HSTS + __Host- cookie prefix + Secure flag when served over https', async () => {
  const s = await boot(cluster, { env: { PUBLIC_URL: 'https://alerts.example.com' } });
  try {
    const home = await s.req('GET', '/embed');
    assert.match(home.headers.get('strict-transport-security'), /max-age=31536000/);
    const { r } = await login(s);
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /^__Host-encore_admin=/);
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /Secure/);
    assert.match(sc, /SameSite=Strict/);
    assert.match(sc, /Path=\//);
    assert.ok(!/Domain=/i.test(sc));
  } finally {
    await s.closeAll();
  }
});

/* ===================== A07 Auth failures / API2 broken authentication: webhook ===================== */
test('[A07/API2] webhook authentication: missing, wrong, near-miss, and query-string secrets are all rejected before any work', async () => {
  const base = await eventCount();
  const good = { event_id: 'auth-evt', sku: 'SEC-1', quantity: 3 };
  const near = SECRET.slice(0, -1) + (SECRET.endsWith('x') ? 'y' : 'x');
  for (const secret of [null, '', 'wrong', near, SECRET + 'x', SECRET.slice(0, -1), SECRET.toUpperCase()]) {
    const r = await t.webhook(good, { secret });
    assert.equal(r.status, 401, `secret=${JSON.stringify(secret)}`);
    assert.equal(r.data.error.code, 'unauthorized');
  }
  const q = await t.req('POST', `/webhooks/stock?secret=${SECRET}&x_webhook_secret=${SECRET}`, { body: good });
  assert.equal(q.status, 401, 'secret in the URL is not accepted');
  const bad = await t.req('POST', '/webhooks/stock', { body: '{not json', json: false, headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 401, 'auth is checked before the body is even parsed');
  assert.equal(await eventCount(), base, 'nothing stored for unauthenticated callers');
});

/* ===================== A03 Injection / API3 property validation ===================== */
test('[A03/API3] webhook payload validation: strict types and ranges, nothing malformed is stored', async () => {
  const base = await eventCount();
  const bad = [
    {}, { sku: 'SEC-1', quantity: 1 }, { event_id: 'a b', sku: 'SEC-1', quantity: 1 }, { event_id: 'x\ny', sku: 'SEC-1', quantity: 1 },
    { event_id: 'e'.repeat(129), sku: 'SEC-1', quantity: 1 }, { event_id: 'e1', quantity: 1 }, { event_id: 'e1', sku: "x';DROP TABLE requests;--", quantity: 1 },
    { event_id: 'e1', sku: '../etc/passwd', quantity: 1 }, { event_id: 'e1', sku: 'SEC-1' }, { event_id: 'e1', sku: 'SEC-1', quantity: -1 },
    { event_id: 'e1', sku: 'SEC-1', quantity: 1.5 }, { event_id: 'e1', sku: 'SEC-1', quantity: '5' }, { event_id: 'e1', sku: 'SEC-1', quantity: null },
    { event_id: 'e1', sku: 'SEC-1', quantity: true }, { event_id: 'e1', sku: 'SEC-1', quantity: 1e9 }, { event_id: 'e1', sku: ['SEC-1'], quantity: 1 },
    { event_id: { $ne: 1 }, sku: 'SEC-1', quantity: 1 }, [], 'a string', 42, null,
  ];
  for (const body of bad) {
    const raw = JSON.stringify(body);
    const r = await t.req('POST', '/webhooks/stock', { body: raw, json: false, headers: { 'x-webhook-secret': SECRET, 'content-type': 'application/json' } });
    assert.equal(r.status, 400, raw);
  }
  const wrongType = await t.req('POST', '/webhooks/stock', { body: JSON.stringify({ event_id: 'e9', sku: 'SEC-1', quantity: 1 }), json: false, headers: { 'x-webhook-secret': SECRET, 'content-type': 'text/plain' } });
  assert.equal(wrongType.status, 400, 'JSON sent as text/plain is not parsed');
  const huge = await t.req('POST', '/webhooks/stock', { body: JSON.stringify({ event_id: 'big', sku: 'SEC-1', quantity: 1, pad: 'x'.repeat(20000) }), json: false, headers: { 'x-webhook-secret': SECRET, 'content-type': 'application/json' } });
  assert.equal(huge.status, 413);
  assert.equal(await eventCount(), base, 'no malformed event reached the database');
});

test('[A03] SQL injection attempts everywhere are inert (parameterised queries + allow-lists)', async () => {
  const inj = ["' OR '1'='1", "'; DROP TABLE requests;--", '" OR ""="', "1; SELECT pg_sleep(5)--", "x' UNION SELECT * FROM webhook_events--"];
  for (const p of inj) {
    assert.equal((await t.subscribe(p + '@example.com', 'SEC-1')).status, 400);
    assert.equal((await t.subscribe('inj@example.com', p)).status, 400);
    assert.equal((await t.req('GET', `/api/products/${encodeURIComponent(p)}`)).status, 400);
    const a = await t.req('GET', `/admin?q=${encodeURIComponent(p)}&status=${encodeURIComponent(p)}&page=${encodeURIComponent(p)}`, { headers: { ...basic(), ...htmlAccept } });
    assert.equal(a.status, 200, 'admin filters survive injection strings');
  }
  const ok = await t.pool.query(`SELECT to_regclass('public.requests') AS t`);
  assert.ok(ok.rows[0].t, 'tables still exist');
});

test('[A03] LIKE wildcards in admin search are escaped (no unintended match-all)', async () => {
  t.stock.set('LIKE-1', { name: 'Like Thing', quantity: 0 });
  await t.subscribe('pct%sign@example.com', 'LIKE-1');
  await t.subscribe('plain1@example.com', 'LIKE-1');
  await t.subscribe('plain2@example.com', 'LIKE-1');
  const r = await t.req('GET', '/admin?q=%25', { headers: { ...basic(), ...htmlAccept } });
  assert.match(r.text, /pct%sign@example\.com/);
  assert.ok(!/plain1@example\.com/.test(r.text), '% matched literally, not as a wildcard');
  const u = await t.req('GET', '/admin?q=_', { headers: { ...basic(), ...htmlAccept } });
  assert.ok(!/plain1@example\.com/.test(u.text), '_ matched literally');
});

/* ===================== A03 XSS / output encoding ===================== */
test('[A03] XSS: hostile product names from upstream are escaped in admin and in the email', async () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  t.stock.set('XSS-1', { name: evil, quantity: 0 });
  await t.subscribe('xss@example.com', 'XSS-1');
  const a = await t.req('GET', '/admin', { headers: { ...basic(), ...htmlAccept } });
  assert.ok(!a.text.includes('<img src=x'), 'no raw tag in admin');
  assert.ok(!a.text.includes('<script>alert'), 'no raw script in admin');
  assert.ok(a.text.includes('&lt;img src=x'), 'escaped form present');
  t.stock.set('XSS-1', { quantity: 2 });
  await t.webhook({ event_id: 'xss-evt', sku: 'XSS-1', quantity: 2 });
  await waitFor(() => t.resend.inbox.some((m) => m.to[0] === 'xss@example.com'));
  const m = t.resend.inbox.find((x) => x.to[0] === 'xss@example.com');
  assert.ok(!m.html.includes('<img src=x onerror'), 'email html escaped');
  assert.ok(!m.html.includes('<script>alert'));
  assert.ok(!/[\r\n]/.test(m.subject));
});

test('[A03] static guard: no unsafe DOM sinks or inline handlers in shipped front-end code', () => {
  const embed = fs.readFileSync(path.join(__dirname, '..', 'public', 'embed.js'), 'utf8');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setTimeout("', "setTimeout('"]) assert.ok(!embed.includes(sink), `embed.js uses ${sink}`);
  const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
  assert.equal((admin.match(/innerHTML/g) || []).length, 1, 'admin.js only swaps in server-rendered fragments');
  for (const f of ['pages.js', 'email.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'templates', f), 'utf8');
    assert.ok(!/\bon(click|load|error|submit)\s*=/i.test(src.replace(/onerror=alert/g, '')), `${f} has inline handlers`);
  }
});

/* ===================== A01 Broken access control / API1 BOLA / API5 ===================== */
test('[A01/API5] admin requires auth on every route; no credentials means no data', async () => {
  for (const [m, p] of [['GET', '/admin'], ['GET', '/admin/export.csv'], ['POST', '/admin/requests/1/cancel'], ['POST', '/admin/requests/1/retry']]) {
    const r = await t.req(m, p);
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.ok(!r.text.includes('@example.com'));
    assert.match(r.headers.get('www-authenticate') || '', /Basic/);
  }
  const html = await t.req('GET', '/admin', { headers: htmlAccept });
  assert.equal(html.status, 401);
  assert.match(html.text, /type="password"/);
  assert.equal(html.headers.get('www-authenticate'), null, 'browsers get the login page, not a native dialog');
});

test('[A07] admin: wrong password variants rejected; correct Basic and Bearer accepted', async () => {
  const s = await boot(cluster);
  try {
    for (const pw of ['', 'wrong', ADMIN + 'x', ADMIN.slice(1), ADMIN.toUpperCase()]) assert.equal((await s.req('GET', '/admin', { headers: basic(pw) })).status, 401, pw);
    assert.equal((await s.req('GET', '/admin', { headers: basic() })).status, 200);
    assert.equal((await s.req('GET', '/admin', { headers: { authorization: `Bearer ${ADMIN}` } })).status, 200);
    assert.equal((await s.req('GET', '/admin', { headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await s.req('GET', '/admin?password=' + ADMIN)).status, 401, 'password in query string never works');
  } finally {
    await s.closeAll();
  }
});

test('[A07] admin sessions: login sets a hardened cookie; tampered/expired/forged cookies fail', async () => {
  const { r, cookie } = await login(t);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/admin');
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.equal((await t.req('GET', '/admin', { headers: { cookie } })).status, 200);
  const tampered = cookie.slice(0, -3) + (cookie.endsWith('AAA') ? 'BBB' : 'AAA');
  assert.equal((await t.req('GET', '/admin', { headers: { cookie: tampered } })).status, 401);
  const expired = session.issue(t.config.sessionSecret, -10).token;
  assert.equal((await t.req('GET', '/admin', { headers: { cookie: `encore_admin=${expired}` } })).status, 401);
  const forged = session.issue(Buffer.from('attacker-secret-attacker-secret-00'), 3600).token;
  assert.equal((await t.req('GET', '/admin', { headers: { cookie: `encore_admin=${forged}` } })).status, 401);
  const bad = await t.req('POST', '/admin/login', { body: form({ password: 'nope' }), json: false, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
});

test('[A01] regression: a real browser form POST (Origin "null" + Sec-Fetch-Site same-origin) can log in; forged variants cannot', async () => {
  const post = (headers) => t.req('POST', '/admin/login', { body: form({ password: ADMIN }), json: false, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  assert.equal((await post({ origin: 'null', 'sec-fetch-site': 'same-origin' })).status, 303, 'what Chrome/Firefox actually send');
  assert.equal((await post({ origin: 'null' })).status, 403, 'opaque origin without browser proof is refused');
  assert.equal((await post({ origin: 'null', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({ 'sec-fetch-site': 'same-site' })).status, 403, 'a sibling subdomain is not us');
  assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await t.req('GET', '/admin', { headers: { accept: 'text/html' } })).headers.get('referrer-policy'), 'same-origin');
});

test('[A07] brute force: lockout after repeated failures, even for the right password afterwards', async () => {
  const s = await boot(cluster);
  try {
    const ip = s.newIp();
    for (let i = 0; i < 8; i++) assert.equal((await s.req('GET', '/admin', { ip, headers: basic('guess' + i) })).status, 401);
    const locked = await s.req('GET', '/admin', { ip, headers: basic() });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    const viaForm = await login(s, ip);
    assert.equal(viaForm.r.status, 429);
    assert.equal((await s.req('GET', '/admin', { headers: basic() })).status, 200, 'other clients unaffected');
  } finally {
    await s.closeAll();
  }
});

test('[A01] CSRF: state-changing admin actions need session + token + same origin', async () => {
  t.stock.set('CSRF-1', { name: 'Csrf Thing', quantity: 0 });
  await t.subscribe('csrf@example.com', 'CSRF-1');
  const [row] = await t.rows(`email='csrf@example.com'`);
  const { cookie } = await login(t);
  const page = await t.req('GET', '/admin?q=csrf%40example.com', { headers: { cookie, ...htmlAccept } });
  const token = csrfFrom(page.text);
  assert.ok(token, 'form carries a CSRF token');
  const action = `/admin/requests/${row.id}/cancel`;
  const post = (extra, bodyObj) => t.req('POST', action, { body: form(bodyObj), json: false, headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra } });

  assert.equal((await post({ cookie }, {})).status, 403, 'cookie alone is not enough');
  assert.equal((await post({ cookie }, { _csrf: 'forged' })).status, 403);
  assert.equal((await post({ cookie, origin: 'https://evil.example' }, { _csrf: token })).status, 403, 'cross-origin refused');
  assert.equal((await post({ cookie, 'sec-fetch-site': 'cross-site' }, { _csrf: token })).status, 403);
  assert.equal((await post({ ...basic() }, { _csrf: token })).status, 403, 'Basic auth cannot perform actions (no ambient-credential CSRF)');
  assert.equal((await t.rows(`id=$1`, [row.id]))[0].status, 'open', 'nothing changed so far');
  assert.equal((await post({ cookie, origin: `http://127.0.0.1:${t.app.port}` }, { _csrf: token })).status, 303);
  assert.equal((await t.rows(`id=$1`, [row.id]))[0].status, 'cancelled');
  assert.equal((await t.req('POST', '/admin/requests/abc/cancel', { body: form({ _csrf: token }), json: false, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } })).status, 400, 'ids are validated');
});

test('[A01/API1] no public read access to individual requests; no listing; no verb tampering', async () => {
  await t.subscribe('private@example.com', 'SEC-2');
  for (const [m, p] of [['GET', '/api/requests'], ['GET', '/api/requests/1'], ['PUT', '/api/requests'], ['DELETE', '/api/requests/1'], ['PATCH', '/api/requests/1'], ['GET', '/admin/requests/1'], ['DELETE', '/webhooks/stock'], ['GET', '/webhooks/stock']]) {
    const r = await t.req(m, p);
    assert.ok([401, 404, 405].includes(r.status), `${m} ${p} -> ${r.status}`);
    assert.ok(!r.text.includes('private@example.com'));
  }
});

test('[API3] mass assignment: client cannot set status, id, timestamps or provider fields', async () => {
  const r = await t.req('POST', '/api/requests', { body: { email: 'mass@example.com', sku: 'SEC-2', status: 'notified', id: 99999, notified_at: '2020-01-01', provider_id: 'x', attempts: 50, is_admin: true } });
  assert.equal(r.status, 200);
  const [row] = await t.rows(`email='mass@example.com'`);
  assert.equal(row.status, 'open');
  assert.equal(row.notified_at, null);
  assert.equal(row.provider_id, null);
  assert.equal(row.attempts, 0);
  assert.notEqual(Number(row.id), 99999);
});

test('[A04/API6] no account/waitlist enumeration: new and repeat requests are indistinguishable', async () => {
  const a = await t.subscribe('enum@example.com', 'SEC-2');
  const b = await t.subscribe('enum@example.com', 'SEC-2');
  assert.equal(a.status, b.status);
  assert.deepEqual(Object.keys(a.data), Object.keys(b.data));
  assert.equal(a.data.status, b.data.status);
  assert.equal(a.data.ticket, b.data.ticket);
});

/* ===================== API4 Unrestricted resource consumption / abuse ===================== */
test('[API4] sign-up endpoint is rate limited per client', async () => {
  const ip = t.newIp();
  const codes = [];
  for (let i = 0; i < 14; i++) codes.push((await t.req('POST', '/api/requests', { ip, body: { email: 'nope', sku: 'SEC-1' } })).status);
  assert.ok(codes.slice(0, 10).every((c) => c === 400));
  assert.ok(codes.slice(10).every((c) => c === 429), codes.join());
  assert.equal((await t.subscribe('someone@example.com', 'SEC-1', t.newIp())).status, 200, 'other clients unaffected');
});

test('[API4/A04] email-bombing defence: per-address caps on active alerts and daily volume', async () => {
  const s = await boot(cluster, { env: { MAX_OPEN_PER_EMAIL: '3', MAX_PER_EMAIL_PER_DAY: '5' } });
  try {
    for (let i = 0; i < 6; i++) s.stock.set(`BOMB-${i}`, { name: `B${i}`, quantity: 0 });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await s.subscribe('victim@example.com', `BOMB-${i}`)).status);
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
    assert.ok(codes.slice(3).every((c) => c === 429), codes.join());
    assert.equal((await s.rows(`email='victim@example.com'`)).length, 3);
  } finally {
    await s.closeAll();
  }
});

test('[A04] a notified customer cannot be re-emailed for the same in-stock item within 24h', async () => {
  t.stock.set('BOMB2', { name: 'Always In Stock', quantity: 5 });
  const mine = () => t.resend.inbox.filter((m) => m.to[0] === 'target@example.com').length;
  for (let i = 0; i < 4; i++) await t.subscribe('target@example.com', 'BOMB2');
  await waitFor(() => mine() >= 1, { msg: 'first email' });
  await settle(700);
  assert.equal(mine(), 1, 'three more asks produced no further email');
  assert.equal((await t.rows(`email='target@example.com'`)).length, 1);
});

/* ===================== A06/A10 SSRF + upstream trust ===================== */
test('[A10] upstream redirects are never followed (bearer token cannot be bounced elsewhere)', async () => {
  const evil = http.createServer((req, res) => {
    evil.hits = (evil.hits || 0) + 1;
    res.end('{}');
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const redirector = http.createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${evil.address().port}/steal` }).end();
  });
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  const { StockClient } = require('../src/stock');
  const c = new StockClient({ apiUrl: `http://127.0.0.1:${redirector.address().port}`, apiKey: 'secret-key', timeoutMs: 800 });
  await assert.rejects(() => c.getProduct('A-1'), /unreachable|stock api/);
  assert.equal(evil.hits || 0, 0);
  evil.close();
  redirector.close();
});

test('[A10] upstream sends garbage / oversized / wrong-shaped data => handled, never crashes or poisons data', async () => {
  const { StockClient, StockError } = require('../src/stock');
  const mk = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
  const big = await mk((req, res) => res.end('x'.repeat(2_000_000)));
  const arr = await mk((req, res) => res.end('[1,2,3]'));
  const nul = await mk((req, res) => res.end('null'));
  for (const s of [big, arr, nul]) {
    const c = new StockClient({ apiUrl: `http://127.0.0.1:${s.address().port}`, apiKey: 'k', timeoutMs: 800 });
    await assert.rejects(() => c.getProduct('A-1'), StockError);
    s.close();
  }
});

/* ===================== A05/A09 info leakage + logging ===================== */
test('[A05] errors never leak stack traces, paths, SQL or versions', async () => {
  const probes = [
    await t.req('POST', '/api/requests', { body: '{bad', json: false, headers: { 'content-type': 'application/json' } }),
    await t.req('POST', '/webhooks/stock', { body: '{bad', json: false, headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET } }),
    await t.req('GET', '/nonexistent/path'),
    await t.req('GET', '/api/products/' + 'a'.repeat(500)),
  ];
  for (const r of probes) {
    assert.ok(!/node_modules|\.js:\d+|at \w+ \(|SELECT |pg_|express|postgres|ECONN/i.test(r.text), r.text.slice(0, 120));
    assert.ok(r.data?.error?.code, 'uniform JSON error envelope');
  }
});

test('[A05] path traversal out of /public is impossible', async () => {
  for (const p of ['/assets/..%2f..%2fpackage.json', '/assets/%2e%2e/%2e%2e/package.json', '/assets/..\\..\\package.json', '/assets/%00.js', '/assets/.env']) {
    const r = await rawRequest(t.app.port, { path: p }).catch(() => ({ status: 0, text: '' }));
    assert.ok(r.status !== 200, `${p} -> ${r.status}`);
    assert.ok(!r.text.includes('back-in-stock'), `${p} leaked package.json`);
  }
});

test('[A05] Host-header injection cannot influence links in emails', async () => {
  t.stock.set('HOST-1', { name: 'Host Thing', quantity: 0 });
  await rawRequest(t.app.port, { method: 'POST', path: '/api/requests', headers: { host: 'evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'host@example.com', sku: 'HOST-1' }) });
  t.stock.set('HOST-1', { quantity: 1 });
  await t.webhook({ event_id: 'host-evt', sku: 'HOST-1', quantity: 1 });
  await waitFor(() => t.resend.inbox.some((m) => m.to[0] === 'host@example.com'));
  const m = t.resend.inbox.find((x) => x.to[0] === 'host@example.com');
  assert.ok(!m.html.includes('evil.example') && !m.text.includes('evil.example'));
});

/* ===================== Recon / scanner defence (the "block nmap" requirement) ===================== */
test('[recon] nmap / sqlmap / nikto user agents are banned and silently dropped', async () => {
  const ip = t.newIp();
  const ua = 'Mozilla/5.0 (compatible; Nmap Scripting Engine; https://nmap.org/book/nse.html)';
  await assert.rejects(() => t.req('GET', '/', { ip, headers: { 'user-agent': ua } }), /fetch failed/, 'connection is dropped with no response');
  await assert.rejects(() => t.req('GET', '/embed', { ip, headers: { 'user-agent': 'curl/8' } }), /fetch failed/, 'the whole client is now banned');
  assert.equal((await t.req('GET', '/embed', { ip: t.newIp() })).status, 200, 'everyone else is unaffected');
  for (const agent of ['sqlmap/1.7.2#stable', 'Nikto/2.5.0', 'masscan/1.3']) {
    await assert.rejects(() => t.req('GET', '/embed', { headers: { 'user-agent': agent } }), /fetch failed/, agent);
  }
});

test('[recon] path-probing (.env, wp-login, ../) earns a ban within two requests', async () => {
  const ip = t.newIp();
  assert.equal((await t.req('GET', '/.env', { ip })).status, 404);
  assert.equal((await t.req('GET', '/wp-login.php', { ip })).status, 404);
  await assert.rejects(() => t.req('GET', '/embed', { ip }), /fetch failed/);
});

test('[recon] ordinary 404 noise accumulates strikes too (dir brute-forcing)', async () => {
  const ip = t.newIp();
  let dropped = false;
  for (let i = 0; i < 40 && !dropped; i++) {
    try { await t.req('GET', `/guess-${i}`, { ip }); } catch { dropped = true; }
  }
  assert.ok(dropped, 'banned before 40 consecutive misses');
});

test('[recon] webhook route is exempt from bans, so a hostile client can never lock out the real sender', async () => {
  const ip = t.newIp();
  for (let i = 0; i < 3; i++) await t.req('GET', '/.env', { ip }).catch(() => {});
  await assert.rejects(() => t.req('GET', '/embed', { ip }), /fetch failed/, 'banned for the web surface');
  const r = await t.webhook({ event_id: 'exempt-evt', sku: 'SEC-1', quantity: 1 }, { ip });
  assert.equal(r.status, 200);
  for (let i = 0; i < 30; i++) assert.equal((await t.webhook({ nope: 1 }, { ip: t.newIp() })).status, 400);
  assert.equal((await t.webhook({ event_id: 'after-bad', sku: 'SEC-1', quantity: 1 }, { ip: t.newIp() })).status, 200);
});

test('[recon] non-HTTP garbage on the port (nmap -sV probes) is answered with 400/close and counted', async () => {
  const probes = [Buffer.from([0x16, 0x03, 0x01, 0x00, 0xa5, 0x01, 0x00, 0x00]), Buffer.from('\x00\x00\x00\x00\r\n\r\n'), Buffer.from('HELP\r\n'), Buffer.from('GET / HTTP/9.9\r\n\r\n'), Buffer.from('OPTIONS * RTSP/1.0\r\nCSeq: 1\r\n\r\n')];
  for (const p of probes) {
    const reply = await new Promise((resolve) => {
      const s = net.connect(t.app.port, '127.0.0.1');
      let data = '';
      s.on('data', (d) => (data += d));
      s.on('close', () => resolve(data));
      s.on('error', () => resolve(data));
      s.setTimeout(3000, () => { s.destroy(); });
      s.write(p);
    });
    assert.ok(reply === '' || /^HTTP\/1\.1 4\d\d/.test(reply), `unexpected reply: ${JSON.stringify(reply.slice(0, 60))}`);
    assert.ok(!/express|node|server:/i.test(reply), 'no banner leaked');
  }
  assert.equal((await t.req('GET', '/healthz')).status, 200, 'service unaffected');
});

test('[recon] slow-loris style stalled requests are cut off by server timeouts', () => {
  const s = t.app.server;
  assert.ok(s.headersTimeout > 0 && s.headersTimeout <= 15000);
  assert.ok(s.requestTimeout > 0 && s.requestTimeout <= 30000);
  assert.ok(s.keepAliveTimeout <= 5000);
  assert.ok(s.maxHeadersCount <= 50);
});

test('[recon] oversized headers are rejected (431) rather than buffered', async () => {
  const r = await rawRequest(t.app.port, { path: '/embed', headers: { 'x-big': 'a'.repeat(20000) } }).catch(() => ({ status: 431 }));
  assert.ok([431, 400].includes(r.status) || r.status === 0, String(r.status));
});
