'use strict';
const express = require('express');
const { Limiter } = require('../guard');
const session = require('../session');
const { safeEqual, csvCell, clampStr, first, sleep } = require('../util');
const { STATUSES } = require('../repo');
const { loginPage, dashboardPage } = require('../templates/pages');
const logger = require('../log');

const PAGE_SIZE = 40;

module.exports = function adminRoutes({ config, repo }) {
  const r = express.Router();
  const secret = config.sessionSecret;
  const cookieName = config.secureCookies ? '__Host-encore_admin' : 'encore_admin';
  // Brute-force defence: per-IP and a global ceiling against distributed guessing. Only FAILURES count.
  const ipFails = new Limiter({ windowMs: 15 * 60000, max: 8 });
  const globalFails = new Limiter({ windowMs: 15 * 60000, max: 60 });

  const setCookie = (res, token, maxAge) =>
    res.append('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`);

  const wantsHtml = (req) => (req.get('accept') || '').includes('text/html');
  const locked = (req) => !ipFails.peek(req.clientKey).ok || !globalFails.peek('g').ok;
  const recordFailure = (req) => {
    ipFails.consume(req.clientKey);
    globalFails.consume('g');
    logger.warn('admin auth failed', { ip: req.clientKey });
  };

  /**
   * Browsers: same-origin only. Sec-Fetch-Site is set by the browser itself and cannot be forged by
   * page script, so it is the primary signal (and it stays correct when Origin is "null", which
   * browsers send under some referrer policies). Origin is the fallback for older browsers.
   * Non-browser clients send neither and carry no ambient cookies, so they pass.
   */
  function sameOrigin(req) {
    const site = req.get('sec-fetch-site');
    if (site) return site === 'same-origin' || site === 'none';
    const origin = req.get('origin');
    if (origin) {
      try {
        return new URL(origin).host === req.get('host');
      } catch {
        return false;
      }
    }
    return true;
  }

  function authenticate(req) {
    const token = session.parseCookies(req.headers.cookie)[cookieName];
    if (token) {
      const s = session.verify(secret, token);
      if (s) return { ok: true, via: 'cookie', nonce: s.nonce };
    }
    const h = req.get('authorization');
    if (h) {
      let pw = null;
      if (/^basic /i.test(h)) {
        const dec = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
        pw = dec.slice(dec.indexOf(':') + 1);
      } else if (/^bearer /i.test(h)) {
        pw = h.slice(7).trim();
      }
      if (pw !== null) return safeEqual(pw, config.adminPassword) ? { ok: true, via: 'header' } : { ok: false, attempted: true };
    }
    return { ok: false, attempted: false };
  }

  function requireAuth(req, res, next) {
    if (locked(req)) {
      res.set('Retry-After', '900');
      return res.status(429).type('html').send(loginPage({ config, error: 'Too many failed attempts. Try again in 15 minutes.' }).value);
    }
    const a = authenticate(req);
    if (a.ok) {
      req.admin = a;
      return next();
    }
    if (a.attempted) recordFailure(req);
    if (wantsHtml(req)) return res.status(401).type('html').send(loginPage({ config, error: a.attempted ? 'Incorrect password.' : null }).value);
    res.set('WWW-Authenticate', 'Basic realm="Encore admin", charset="UTF-8"');
    return res.status(401).json({ error: { code: 'unauthorized', message: 'Admin password required.' } });
  }

  function requireCsrf(req, res, next) {
    const ok =
      req.admin?.via === 'cookie' &&
      sameOrigin(req) &&
      typeof req.body?._csrf === 'string' &&
      safeEqual(req.body._csrf, session.csrfToken(secret, req.admin.nonce));
    if (!ok) return res.status(403).json({ error: { code: 'forbidden', message: 'Invalid or missing CSRF token.' } });
    return next();
  }

  const form = express.urlencoded({ extended: false, limit: '2kb', parameterLimit: 10 });

  r.post('/login', form, async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: { code: 'forbidden', message: 'Cross-origin request refused.' } });
    if (locked(req)) {
      res.set('Retry-After', '900');
      return res.status(429).type('html').send(loginPage({ config, error: 'Too many failed attempts. Try again in 15 minutes.' }).value);
    }
    const pw = typeof req.body?.password === 'string' ? req.body.password : '';
    if (pw && safeEqual(pw, config.adminPassword)) {
      const { token } = session.issue(secret, config.sessionTtlSec);
      setCookie(res, token, config.sessionTtlSec);
      logger.info('admin login', { ip: req.clientKey });
      return res.redirect(303, '/admin');
    }
    recordFailure(req);
    await sleep(350); // blunt online guessing
    return res.status(401).type('html').send(loginPage({ config, error: 'Incorrect password.' }).value);
  });

  r.post('/logout', form, (req, res) => {
    setCookie(res, '', 0);
    res.redirect(303, '/admin');
  });

  r.get('/export.csv', requireAuth, async (req, res, next) => {
    try {
      const rows = await repo.exportAll();
      const head = ['id', 'email', 'sku', 'product', 'status', 'requested_at', 'notified_at', 'attempts', 'last_error'];
      const lines = [head.join(',')].concat(
        rows.map((x) =>
          [x.id, x.email, x.sku, x.product_name, x.status, x.created_at?.toISOString(), x.notified_at?.toISOString(), x.attempts, x.last_error].map(csvCell).join(',')
        )
      );
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="encore-requests.csv"' });
      res.send(lines.join('\r\n') + '\r\n');
    } catch (e) {
      next(e);
    }
  });

  for (const action of ['cancel', 'retry']) {
    r.post(`/requests/:id/${action}`, requireAuth, form, requireCsrf, async (req, res, next) => {
      try {
        if (!/^\d{1,15}$/.test(req.params.id)) return res.status(400).json({ error: { code: 'invalid_id', message: 'Bad id.' } });
        const ok = await repo[action](Number(req.params.id));
        logger.info(`admin ${action}`, { request: req.params.id, ok });
        const back = typeof req.body.back === 'string' && /^\?[A-Za-z0-9=&%._+-]{0,200}$/.test(req.body.back) ? req.body.back : '';
        return res.redirect(303, `/admin${back}`);
      } catch (e) {
        return next(e);
      }
    });
  }

  r.get('/', requireAuth, async (req, res, next) => {
    try {
      const q0 = first(req.query.status);
      const status = STATUSES.includes(q0) ? q0 : '';
      const q = clampStr(String(first(req.query.q) ?? ''), 100);
      const page = Math.min(1000, Math.max(1, parseInt(first(req.query.page), 10) || 1));
      const view = first(req.query.view) === 'wall' ? 'wall' : 'list';
      const [list, stats, top, releases] = await Promise.all([
        repo.list({ status, q, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
        repo.stats(),
        repo.topDemand(6),
        repo.recentReleases(10),
      ]);
      const csrf = req.admin.via === 'cookie' ? session.csrfToken(secret, req.admin.nonce) : null;
      res.type('html').send(
        dashboardPage({
          config, csrf, stats, top, releases, list,
          query: { status, q, page, view },
          pages: Math.max(1, Math.ceil(list.total / PAGE_SIZE)),
          fragment: first(req.query.fragment) === '1',
        }).value
      );
    } catch (e) {
      next(e);
    }
  });

  return r;
};
