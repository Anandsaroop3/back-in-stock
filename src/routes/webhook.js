'use strict';
const express = require('express');
const { safeEqual, isEventId, normalizeSku } = require('../util');
const logger = require('../log');

const MAX_QTY = 1_000_000;

module.exports = function webhookRoutes({ config, repo, worker }) {
  const r = express.Router();

  r.post(
    '/webhooks/stock',
    // 1. Authenticate BEFORE parsing anything: unauthenticated callers cost us almost nothing.
    (req, res, next) => {
      const given = req.get('x-webhook-secret');
      if (typeof given !== 'string' || !safeEqual(given, config.webhookSecret)) {
        logger.warn('webhook rejected: bad secret', { ip: req.clientKey });
        return res.status(401).json({ error: { code: 'unauthorized', message: 'Invalid webhook secret.' } });
      }
      return next();
    },
    express.json({ limit: '16kb', strict: true }),
    async (req, res, next) => {
      try {
        // 2. Validate shape strictly. A webhook is untrusted input even when correctly signed.
        const b = req.body;
        const bad = (msg) => res.status(400).json({ error: { code: 'invalid_payload', message: msg } });
        if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('Expected a JSON object.');
        if (!isEventId(b.event_id)) return bad('event_id is required (1-128 chars: letters, digits, . _ : -).');
        const sku = normalizeSku(b.sku);
        if (!sku) return bad('sku is invalid.');
        if (!Number.isInteger(b.quantity) || b.quantity < 0 || b.quantity > MAX_QTY) return bad('quantity must be an integer between 0 and 1000000.');

        // 3. Persist first, acknowledge second: a crash after the 200 can never lose the event.
        //    ON CONFLICT on event_id makes retries and simultaneous duplicates harmless.
        const isNew = await repo.insertEvent({
          eventId: b.event_id,
          sku,
          quantity: b.quantity,
          payload: { event_id: b.event_id, sku, quantity: b.quantity },
        });
        if (isNew) worker.kick();
        // 200 for duplicates too: the sender must stop retrying something we already hold.
        return res.status(200).json({ ok: true, status: isNew ? 'accepted' : 'duplicate' });
      } catch (e) {
        return next(e); // -> 5xx, so a correct sender retries
      }
    }
  );

  return r;
};
