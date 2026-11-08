'use strict';

const LIVE = `('open','queued','sending')`;
const STATUSES = ['open', 'queued', 'sending', 'notified', 'failed', 'cancelled'];

/**
 * Data-access layer. All SQL that serves HTTP routes lives here (the worker owns
 * its own queue SQL). Every statement is parameterised: no string-built SQL
 * except for the fixed constants above.
 */
class Repo {
  constructor(pool) {
    this.pool = pool;
  }

  async ping() {
    await this.pool.query('SELECT 1');
  }

  /** Abuse signals for one address: active alerts, and requests created in the last 24h. */
  async emailLoad(email) {
    const { rows } = await this.pool.query(
      `SELECT count(*) FILTER (WHERE status IN ${LIVE})::int AS live,
              count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS day
         FROM requests WHERE email = $1`,
      [email]
    );
    return rows[0];
  }

  /**
   * Idempotent create. The partial unique index is the final arbiter of "no duplicate open
   * requests"; the transaction closes the check-then-insert race around the re-notify cooldown:
   * locking the live row (if any) stops the worker flipping it to `notified` between our
   * cooldown check and our insert, which would otherwise let a second email through.
   *
   * @param cooldown true when the item is in stock right now: a customer already emailed about
   *   this SKU in the last 24h is not given a new request (and therefore not emailed again).
   */
  async createRequest({ email, sku, productName, cooldown = false }) {
    const client = await this.pool.connect();
    const findLive = (q) =>
      q.query(`SELECT id FROM requests WHERE email=$1 AND sku=$2 AND status IN ${LIVE} ORDER BY id DESC LIMIT 1 FOR UPDATE`, [email, sku]);
    try {
      await client.query('BEGIN');
      const live = await findLive(client);
      if (live.rowCount) {
        await client.query('COMMIT');
        return { id: Number(live.rows[0].id), created: false, suppressed: false };
      }
      if (cooldown) {
        const recent = await client.query(
          `SELECT 1 FROM requests WHERE email=$1 AND sku=$2 AND status='notified' AND notified_at > now() - interval '24 hours' LIMIT 1`,
          [email, sku]
        );
        if (recent.rowCount) {
          await client.query('COMMIT');
          return { id: null, created: false, suppressed: true };
        }
      }
      const ins = await client.query(
        `INSERT INTO requests (email, sku, product_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
        [email, sku, productName]
      );
      if (ins.rowCount) {
        await client.query('COMMIT');
        return { id: Number(ins.rows[0].id), created: true, suppressed: false };
      }
      const raced = await findLive(client); // a concurrent identical sign-up won the unique index
      await client.query('COMMIT');
      return { id: raced.rowCount ? Number(raced.rows[0].id) : null, created: false, suppressed: false };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async queuePosition(sku, id) {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM requests WHERE sku=$1 AND status IN ${LIVE} AND id <= $2`,
      [sku, id ?? 9e15]
    );
    return Math.max(1, rows[0].n);
  }

  async waitingCount(sku) {
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM requests WHERE sku=$1 AND status IN ${LIVE}`, [sku]);
    return rows[0].n;
  }

  /** @returns true if newly stored, false if event_id was seen before. */
  async insertEvent({ eventId, sku, quantity, payload }) {
    const r = await this.pool.query(
      `INSERT INTO webhook_events (event_id, sku, quantity, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, sku, quantity, JSON.stringify(payload)]
    );
    return r.rowCount === 1;
  }

  async list({ status, q, limit, offset }) {
    const where = [];
    const args = [];
    if (status && STATUSES.includes(status)) {
      args.push(status);
      where.push(`status = $${args.length}`);
    }
    if (q) {
      args.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
      where.push(`(email ILIKE $${args.length} OR sku ILIKE $${args.length} OR product_name ILIKE $${args.length})`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await this.pool.query(`SELECT count(*)::int AS n FROM requests ${w}`, args)).rows[0].n;
    args.push(limit, offset);
    const { rows } = await this.pool.query(
      `SELECT id, email, sku, product_name, status, created_at, notified_at, attempts, last_error, trigger_qty
         FROM requests ${w} ORDER BY created_at DESC, id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args
    );
    return { rows, total };
  }

  async exportAll(limit = 50000) {
    const { rows } = await this.pool.query(
      `SELECT id, email, sku, product_name, status, created_at, notified_at, attempts, last_error FROM requests ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    return rows;
  }

  async stats() {
    const { rows } = await this.pool.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status='open')::int AS waiting,
             count(*) FILTER (WHERE status IN ('queued','sending'))::int AS sending,
             count(*) FILTER (WHERE status='notified')::int AS notified,
             count(*) FILTER (WHERE status='notified' AND notified_at > now() - interval '24 hours')::int AS notified_24h,
             count(*) FILTER (WHERE status='failed')::int AS failed,
             count(*) FILTER (WHERE status='cancelled')::int AS cancelled,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM notified_at - created_at))
               FILTER (WHERE status='notified' AND notified_at IS NOT NULL) AS median_wait_s
        FROM requests`);
    return rows[0];
  }

  async topDemand(n = 6) {
    const { rows } = await this.pool.query(
      `SELECT sku, max(product_name) AS name, count(*)::int AS waiting
         FROM requests WHERE status IN ${LIVE} GROUP BY sku ORDER BY waiting DESC, sku LIMIT $1`,
      [n]
    );
    return rows;
  }

  async recentReleases(n = 10) {
    const { rows } = await this.pool.query(
      `SELECT sku, max(product_name) AS name, count(*)::int AS n, max(notified_at) AS at
         FROM requests WHERE status='notified' AND notified_at IS NOT NULL
        GROUP BY trigger_event, sku ORDER BY max(notified_at) DESC LIMIT $1`,
      [n]
    );
    return rows;
  }

  async cancel(id) {
    const r = await this.pool.query(`UPDATE requests SET status='cancelled' WHERE id=$1 AND status IN ('open','queued')`, [id]);
    return r.rowCount === 1;
  }

  async retry(id) {
    const r = await this.pool.query(
      `UPDATE requests SET status='queued', attempts=0, next_attempt_at=now(), last_error=NULL
        WHERE id=$1 AND status='failed'
          AND NOT EXISTS (SELECT 1 FROM requests o WHERE o.email=requests.email AND o.sku=requests.sku AND o.status IN ${LIVE})`,
      [id]
    );
    return r.rowCount === 1;
  }
}

module.exports = { Repo, STATUSES };
