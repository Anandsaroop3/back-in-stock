'use strict';
const express = require('express');
const { rateLimit } = require('../guard');
const { normalizeEmail, normalizeSku, ticketCode, maskEmail } = require('../util');
const { embedPage } = require('../templates/pages');
const logger = require('../log');

const apiError = (res, status, code, message) => res.status(status).json({ error: { code, message } });

module.exports = function publicRoutes({ config, repo, stock, worker }) {
  const r = express.Router();

  // The API is public and credential-less (no cookies), so it can safely be callable from any
  // origin, including a sandboxed iframe on a customer's store.
  r.use('/api', (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    });
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  });

  r.get('/', (req, res) => res.redirect(302, '/embed'));
  r.get('/healthz', async (req, res) => {
    try {
      await repo.ping();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  r.get(['/embed', '/embed/'], (req, res) => {
    res.type('html').send(embedPage(config).value);
  });

  const readLimit = rateLimit({ name: 'read', windowMs: 60000, max: 90 });
  const writeLimit = rateLimit({ name: 'write', windowMs: 60000, max: 10 });

  r.get('/api/catalogue', readLimit, async (req, res, next) => {
    try {
      const cat = await stock.getCatalogue({ maxAgeMs: 15000 });
      res.set('Cache-Control', 'public, max-age=10');
      res.json({
        products: cat
          .slice(0, 300)
          .map((p) => ({ sku: p.sku, name: p.name, inStock: p.inStock, image: p.image }))
          .sort((a, b) => Number(a.inStock) - Number(b.inStock) || a.name.localeCompare(b.name)),
      });
    } catch (e) {
      if (e.name === 'StockError') return apiError(res, 503, 'stock_unavailable', 'Catalogue is temporarily unavailable.');
      return next(e);
    }
  });

  r.get('/api/products/:sku', readLimit, async (req, res, next) => {
    const sku = normalizeSku(req.params.sku);
    if (!sku) return apiError(res, 400, 'invalid_sku', 'That does not look like a valid SKU.');
    try {
      const p = await stock.getProduct(sku);
      if (!p) return apiError(res, 404, 'unknown_sku', 'We could not find that item.');
      const waiting = await repo.waitingCount(p.sku);
      return res.json({ sku: p.sku, name: p.name, image: p.image, price: p.price, url: p.url, inStock: p.inStock, waiting });
    } catch (e) {
      if (e.name === 'StockError') return apiError(res, 503, 'stock_unavailable', 'Stock lookup is temporarily unavailable.');
      return next(e);
    }
  });

  r.post('/api/requests', writeLimit, express.json({ limit: '4kb', strict: true }), async (req, res, next) => {
    try {
      if (!req.is('application/json')) return apiError(res, 415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json.');
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(res, 400, 'invalid_body', 'Expected a JSON object.');

      const email = normalizeEmail(body.email);
      if (!email) return apiError(res, 400, 'invalid_email', 'Please enter a valid email address.');
      const rawSku = normalizeSku(body.sku);
      if (!rawSku) return apiError(res, 400, 'invalid_sku', 'Please enter a valid SKU.');

      // Validate against the source of truth: we never store requests for items that do not exist.
      let product;
      try {
        product = await stock.getProduct(rawSku);
      } catch (e) {
        if (e.name === 'StockError') return apiError(res, 503, 'stock_unavailable', 'We cannot check that item right now. Please try again in a moment.');
        throw e;
      }
      if (!product) return apiError(res, 404, 'unknown_sku', 'We could not find an item with that SKU.');
      const sku = product.sku.toLowerCase() === rawSku.toLowerCase() ? product.sku : rawSku;

      // Anti-abuse: this endpoint makes us send mail to an address the caller merely typed, so it
      // is capped per address (active alerts and 24h volume), on top of the per-IP rate limit.
      const load = await repo.emailLoad(email);
      if (load.live >= config.limits.maxOpenPerEmail || load.day >= config.limits.maxPerEmailPerDay) {
        return apiError(res, 429, 'too_many_requests', 'That email has reached its limit of alerts for now.');
      }

      // If it is in stock and this address was already emailed about it in the last 24h, no new
      // request is created (so no second email). The response is identical either way.
      const { id, suppressed } = await repo.createRequest({ email, sku, productName: product.name, cooldown: product.inStock });
      // Close the check-then-insert race: if the item is in stock right now, the customer must
      // not wait for a restock event that already happened.
      if (product.inStock && !suppressed) await worker.release(product, 'signup');

      const position = await repo.queuePosition(sku, id);
      logger.info('request accepted', { sku, to: maskEmail(email), position });
      // Same response whether new or duplicate: the form must not reveal who is on which list.
      return res.status(200).json({
        ok: true,
        status: 'waiting',
        ticket: ticketCode(config.sessionSecret, email, sku),
        position,
        inStockNow: product.inStock,
        product: { sku, name: product.name, image: product.image, url: product.url },
      });
    } catch (e) {
      return next(e);
    }
  });

  return r;
};
