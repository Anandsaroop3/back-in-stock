'use strict';
const path = require('node:path');
const express = require('express');
const { Guard } = require('./guard');
const logger = require('./log');
const { errorPage } = require('./templates/pages');

function csp(directives) {
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v}`)
    .join('; ');
}

/** Defence in depth headers (OWASP A05). CSP forbids inline script/style: all JS/CSS are same-origin files. */
function securityHeaders(config) {
  const base = { 'default-src': "'none'", 'base-uri': "'none'", 'form-action': "'self'" };
  const embedCsp = csp({
    ...base,
    'script-src': "'self'",
    'style-src': "'self'",
    'img-src': "'self' https: data:",
    'connect-src': "'self'",
    'frame-ancestors': config.embedAncestors,
  });
  const adminCsp = csp({
    ...base,
    'script-src': "'self'",
    'style-src': "'self'",
    'img-src': "'self' data:",
    'connect-src': "'self'",
    'frame-ancestors': "'none'",
  });
  const apiCsp = csp({ ...base, 'frame-ancestors': "'none'" });

  return (req, res, next) => {
    const p = req.path;
    res.set({
      'X-Content-Type-Options': 'nosniff',
      // not "no-referrer": that makes browsers send `Origin: null` on same-origin form POSTs
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'X-Permitted-Cross-Domain-Policies': 'none',
    });
    if (config.secureCookies) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (p === '/embed' || p === '/embed/') {
      res.set('Content-Security-Policy', embedCsp); // framing intentionally allowed here only
    } else if (p.startsWith('/api') || p.startsWith('/webhooks')) {
      res.set({ 'Content-Security-Policy': apiCsp, 'X-Frame-Options': 'DENY' });
    } else {
      res.set({ 'Content-Security-Policy': adminCsp, 'X-Frame-Options': 'DENY' });
    }
    if (!p.startsWith('/assets')) res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    if (p.startsWith('/admin')) res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  };
}

function createApp({ config, repo, stock, worker }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('trust proxy', config.trustProxy);
  app.set('query parser', 'simple'); // no nested-object query parsing (mass-assignment / pollution surface)

  const guard = new Guard(config.guard);
  app.guard = guard;
  app.use(guard.middleware());
  app.use(securityHeaders(config));
  app.use(
    '/assets',
    express.static(path.join(__dirname, '..', 'public'), { index: false, dotfiles: 'ignore', maxAge: '1h', fallthrough: true, redirect: false })
  );

  const deps = { config, repo, stock, worker };
  app.use(require('./routes/public')(deps));
  app.use(require('./routes/webhook')(deps));
  app.use('/admin', require('./routes/admin')(deps));

  app.use((req, res) => {
    // One uniform 404 for everything: no hints about what exists.
    if (/^\/(api|webhooks)\b/.test(req.path) || !(req.get('accept') || '').includes('text/html')) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
    }
    return res.status(404).type('html').send(errorPage(404, 'Not found').value);
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const map = { 'entity.too.large': 413, 'entity.parse.failed': 400, 'encoding.unsupported': 415, 'charset.unsupported': 415, 'request.aborted': 400 };
    const status = map[err.type] || (err.status >= 400 && err.status < 500 ? err.status : 500);
    if (status >= 500) logger.error('unhandled error', { path: req.path, err: err.message });
    const messages = { 400: 'Malformed request.', 413: 'Request body too large.', 415: 'Unsupported media type.' };
    res.status(status).json({ error: { code: status >= 500 ? 'internal_error' : 'bad_request', message: status >= 500 ? 'Something went wrong. Please retry.' : messages[status] || 'Bad request.' } });
  });

  return app;
}

module.exports = { createApp };
