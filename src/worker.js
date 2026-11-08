'use strict';
const logger = require('./log');
const { sendEmail } = require('./mailer');
const { renderEmail } = require('./templates/email');
const { ticketCode, maskEmail, sleep } = require('./util');

/**
 * The delivery engine. Three cooperating loops over Postgres state, so
 * correctness never depends on in-memory state or on timing:
 *
 *   webhook_events (pending) --verify against stock API--> requests: open -> queued
 *   requests (queued)        --claim, send w/ idempotency key--> notified | queued(retry) | failed
 *   reconcile sweep          --catalogue says in stock but we never heard--> requests: open -> queued
 *
 * Claiming uses UPDATE ... FOR UPDATE SKIP LOCKED, so any number of instances (or
 * 20 simultaneous identical webhooks) can run concurrently and a row is still
 * processed by exactly one of them. A claim older than staleLockSec is treated as a
 * crashed worker and re-claimed.
 */
class Worker {
  constructor({ pool, stock, config }) {
    this.pool = pool;
    this.stock = stock;
    this.config = config;
    this.cfg = config.worker;
    this.running = false;
    this._wake = null;
    this._loop = null;
    this._lastReconcile = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loop = this._run();
  }

  async stop() {
    this.running = false;
    this.kick();
    await this._loop;
  }

  /** Wake the loop immediately (called after a webhook is stored). */
  kick() {
    if (this._wake) this._wake();
  }

  async _run() {
    while (this.running) {
      try {
        await this.tick();
      } catch (e) {
        logger.error('worker tick failed', { err: e.message });
      }
      if (!this.running) break;
      await new Promise((resolve) => {
        const t = setTimeout(resolve, this.cfg.intervalMs);
        this._wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this._wake = null;
    }
  }

  async tick() {
    if (Date.now() - this._lastReconcile >= this.cfg.reconcileMs) {
      this._lastReconcile = Date.now();
      await this.reconcile().catch((e) => logger.warn('reconcile failed', { err: e.message }));
    }
    await this.processEvents();
    await this.sendQueued();
  }

  backoff(attempts) {
    const exp = Math.min(this.cfg.backoffMaxMs, this.cfg.backoffBaseMs * 2 ** Math.max(0, attempts - 1));
    return Math.round(exp * (0.75 + Math.random() * 0.5)); // jitter: avoid thundering herd
  }

  /* ---------------- stage 1: webhook events ---------------- */

  async processEvents() {
    for (;;) {
      const { rows } = await this.pool.query(
        `UPDATE webhook_events SET status='processing', locked_at=now(), attempts=attempts+1
          WHERE event_id IN (
            SELECT event_id FROM webhook_events
             WHERE (status='pending' AND next_attempt_at <= now())
                OR (status='processing' AND locked_at < now() - make_interval(secs => $2))
             ORDER BY received_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
        [20, this.cfg.staleLockSec]
      );
      if (!rows.length) return;
      for (const ev of rows) await this.processEvent(ev);
    }
  }

  async finishEvent(id, status, note) {
    await this.pool.query(`UPDATE webhook_events SET status=$2, note=$3, processed_at=now(), locked_at=NULL WHERE event_id=$1`, [
      id,
      status,
      String(note).slice(0, 200),
    ]);
  }

  async processEvent(ev) {
    // A webhook is only a hint. The stock API is the source of truth.
    if (ev.quantity <= 0) return this.finishEvent(ev.event_id, 'ignored', 'sold-out event');
    let product;
    try {
      product = await this.stock.getProduct(ev.sku);
    } catch (e) {
      if (ev.attempts >= this.cfg.maxAttempts) {
        logger.warn('event gave up', { event: ev.event_id, err: e.message });
        return this.finishEvent(ev.event_id, 'failed', `stock api: ${e.message}`);
      }
      await this.pool.query(
        `UPDATE webhook_events SET status='pending', locked_at=NULL, note=$2,
                next_attempt_at = now() + make_interval(secs => $3) WHERE event_id=$1`,
        [ev.event_id, e.message.slice(0, 200), this.backoff(ev.attempts) / 1000]
      );
      return undefined;
    }
    if (!product) return this.finishEvent(ev.event_id, 'ignored', 'unknown sku');
    if (!product.inStock) {
      return this.finishEvent(ev.event_id, 'ignored', `stock api disagrees (qty ${product.quantity ?? 0}); webhook not trusted`);
    }
    const n = await this.release(product, ev.event_id);
    return this.finishEvent(ev.event_id, 'done', `queued ${n}`);
  }

  /** open -> queued for every waiting customer of this SKU. Returns how many. */
  async release(product, trigger) {
    const { rowCount } = await this.pool.query(
      `UPDATE requests SET status='queued', queued_at=now(), next_attempt_at=now(),
              trigger_event=$2, trigger_qty=$3, product_name=$4, product=$5
        WHERE sku=$1 AND status='open'`,
      [
        product.sku,
        trigger,
        product.quantity,
        product.name,
        JSON.stringify({ name: product.name, image: product.image, url: product.url, price: product.price, quantity: product.quantity }),
      ]
    );
    if (rowCount) this.kick();
    return rowCount;
  }

  /* ---------------- stage 2: sending ---------------- */

  async sendQueued() {
    for (;;) {
      const { rows } = await this.pool.query(
        `UPDATE requests SET status='sending', locked_at=now(), attempts=attempts+1
          WHERE id IN (
            SELECT id FROM requests
             WHERE (status='queued'  AND next_attempt_at <= now())
                OR (status='sending' AND locked_at < now() - make_interval(secs => $2))
             ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
        [this.cfg.batch, this.cfg.staleLockSec]
      );
      if (!rows.length) return;
      const queue = rows.slice();
      await Promise.all(
        Array.from({ length: Math.min(this.cfg.concurrency, queue.length) }, async () => {
          while (queue.length) await this.sendOne(queue.shift());
        })
      );
    }
  }

  async sendOne(row) {
    const waitedMs = Date.now() - new Date(row.created_at).getTime();
    const p = row.product || {};
    const mail = renderEmail({
      storeName: this.config.brand.storeName,
      productName: row.product_name || row.sku,
      imageUrl: p.image,
      price: p.price,
      quantity: row.trigger_qty,
      ctaUrl: p.url || this.config.brand.storeUrl || this.config.publicUrl,
      waitedMs,
      ticket: ticketCode(this.config.sessionSecret, row.email, row.sku),
    });
    try {
      const r = await sendEmail({
        baseUrl: this.config.resend.baseUrl,
        apiKey: this.config.resend.apiKey,
        timeoutMs: this.config.resend.timeoutMs,
        from: this.config.brand.emailFrom,
        to: row.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        idempotencyKey: `encore-${row.idem_key}`,
      });
      await this.pool.query(
        `UPDATE requests SET status='notified', notified_at=now(), provider_id=$2, last_error=NULL, locked_at=NULL
          WHERE id=$1 AND status='sending'`,
        [row.id, r.id]
      );
      logger.info('notified', { request: row.id, sku: row.sku, to: maskEmail(row.email) });
    } catch (e) {
      const giveUp = e.permanent || row.attempts >= this.cfg.maxAttempts;
      await this.pool.query(
        `UPDATE requests SET status=$2, locked_at=NULL, last_error=$3,
                next_attempt_at = now() + make_interval(secs => $4)
          WHERE id=$1 AND status='sending'`,
        [row.id, giveUp ? 'failed' : 'queued', String(e.message).slice(0, 200), this.backoff(row.attempts) / 1000]
      );
      logger.warn(giveUp ? 'send gave up' : 'send will retry', { request: row.id, attempt: row.attempts, err: e.message });
    }
  }

  /* ---------------- stage 3: reconciliation ---------------- */

  /**
   * "Don't trust the network": a webhook can be dropped, delayed or arrive before
   * the stock API reflects it. Periodically compare what customers are waiting for
   * with what is actually in stock.
   */
  async reconcile() {
    const { rows } = await this.pool.query(`SELECT DISTINCT sku FROM requests WHERE status='open' LIMIT 500`);
    if (rows.length) {
      const waiting = new Set(rows.map((r) => r.sku));
      let released = 0;
      try {
        const cat = await this.stock.getCatalogue();
        for (const p of cat) if (p.inStock && waiting.has(p.sku)) released += await this.release(p, `reconcile:${new Date().toISOString().slice(0, 16)}`);
      } catch (e) {
        // Catalogue unavailable: fall back to per-SKU checks, bounded.
        for (const sku of [...waiting].slice(0, 50)) {
          try {
            const p = await this.stock.getProduct(sku);
            if (p && p.inStock) released += await this.release(p, `reconcile:${new Date().toISOString().slice(0, 16)}`);
          } catch {
            await sleep(0);
          }
        }
      }
      if (released) logger.info('reconcile released requests', { released });
    }
    await this.pool.query(`DELETE FROM webhook_events WHERE status IN ('done','ignored','failed') AND processed_at < now() - interval '14 days'`);
  }
}

module.exports = { Worker };
