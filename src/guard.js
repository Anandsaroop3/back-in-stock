'use strict';
const logger = require('./log');

/** Fixed-window counter with bounded memory. */
class Limiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }
  _entry(key, now) {
    let e = this.hits.get(key);
    if (!e || e.reset <= now) {
      if (this.hits.size >= 50000) this._purge(now);
      e = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, e);
    }
    return e;
  }
  _purge(now) {
    for (const [k, e] of this.hits) if (e.reset <= now) this.hits.delete(k);
    if (this.hits.size >= 50000) this.hits.clear(); // under a flood, fail open rather than OOM
  }
  consume(key, n = 1) {
    const now = Date.now();
    const e = this._entry(key, now);
    e.count += n;
    return { ok: e.count <= this.max, retryAfterMs: Math.max(0, e.reset - now) };
  }
  /** Check without consuming (used for login: only failures count). */
  peek(key) {
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e || e.reset <= now) return { ok: true, retryAfterMs: 0 };
    return { ok: e.count < this.max, retryAfterMs: Math.max(0, e.reset - now) };
  }
}

/** Normalise an IP into a rate-limit key. IPv6 is bucketed by /64 so rotating addresses doesn't evade limits. */
function ipKey(ip) {
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:') && ip.includes('.')) return ip.slice(7);
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::/64';
  return ip;
}

const SCANNER_UA = /(nmap|nikto|sqlmap|masscan|zgrab|nuclei|gobuster|dirbuster|dirb\b|wfuzz|ffuf|acunetix|nessus|openvas|hydra|metasploit|whatweb|wpscan|arachni|havij|w3af|netsparker|jaeles|xray)/i;
const PROBE_PATH =
  /(\.\.|%2e%2e|%00|\/\.(env|git|svn|ds_store|aws|ssh|htaccess)|wp-(admin|login|content|includes|json)|xmlrpc\.php|phpmyadmin|\.(php|asp|aspx|jsp|cgi|bak|sql|swp)(\?|$)|cgi-bin|etc\/passwd|boaform|actuator|vendor\/phpunit|\/solr|\/manager\/html)/i;

/**
 * Anti-recon. An app cannot block raw TCP port scans (that is the platform's
 * edge), but it can recognise scanner behaviour at the HTTP layer, and then
 * drop that client's connections without answering. Webhook and health routes
 * are exempt so a misbehaving sender can never lock out legitimate traffic.
 */
class Guard {
  constructor(cfg) {
    this.cfg = cfg;
    this.bans = new Map();
    this.strikes = new Map();
    this.global = new Limiter({ windowMs: 60000, max: cfg.globalPerMin });
    this.webhook = new Limiter({ windowMs: 60000, max: cfg.webhookPerMin });
  }

  isBanned(ip) {
    const until = this.bans.get(ip);
    if (!until) return false;
    if (until <= Date.now()) {
      this.bans.delete(ip);
      return false;
    }
    return true;
  }

  ban(ip, reason) {
    if (!this.cfg.enabled) return;
    if (this.bans.size > 20000) this.bans.clear();
    this.bans.set(ip, Date.now() + this.cfg.banMs);
    logger.warn('client banned', { ip, reason, minutes: Math.round(this.cfg.banMs / 60000) });
  }

  strike(ip, points, reason) {
    if (!this.cfg.enabled) return;
    const now = Date.now();
    if (this.strikes.size > 50000) this.strikes.clear();
    let s = this.strikes.get(ip);
    if (!s || now - s.start > 60000) s = { start: now, score: 0 };
    s.score += points;
    this.strikes.set(ip, s);
    if (s.score >= this.cfg.banThreshold) {
      this.strikes.delete(ip);
      this.ban(ip, reason);
    }
  }

  middleware() {
    return (req, res, next) => {
      const ip = ipKey(req.ip);
      req.clientKey = ip;
      const url = req.originalUrl || req.url;
      const exempt = url.startsWith('/webhooks/') || url === '/healthz';

      if (url.startsWith('/webhooks/')) {
        const r = this.webhook.consume(ip);
        if (!r.ok) {
          res.set('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
          return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
        }
      }
      if (exempt || !this.cfg.enabled) return next();

      if (this.isBanned(ip)) return req.socket.destroy();
      if (SCANNER_UA.test(req.get('user-agent') || '')) {
        this.ban(ip, 'scanner-user-agent');
        return req.socket.destroy();
      }
      if (PROBE_PATH.test(url)) this.strike(ip, 10, 'probing-paths');

      const g = this.global.consume(ip);
      if (!g.ok) {
        this.strike(ip, 2, 'flooding');
        res.set('Retry-After', String(Math.ceil(g.retryAfterMs / 1000)));
        return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
      }

      res.on('finish', () => {
        const s = res.statusCode;
        if (s === 404) this.strike(ip, 1, 'repeated-404');
        else if (s === 405) this.strike(ip, 2, 'bad-method');
        else if (s === 400) this.strike(ip, 1, 'malformed-requests');
        else if (s === 413 || s === 414 || s === 431) this.strike(ip, 5, 'oversized-requests');
      });
      return next();
    };
  }
}

/** Per-route rate limit middleware. */
function rateLimit({ windowMs, max, name, key = (req) => req.clientKey || ipKey(req.ip) }) {
  const limiter = new Limiter({ windowMs, max });
  const mw = (req, res, next) => {
    const r = limiter.consume(`${name}:${key(req)}`);
    if (r.ok) return next();
    res.set('Retry-After', String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
    return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests, slow down.' } });
  };
  mw.limiter = limiter;
  return mw;
}

module.exports = { Guard, Limiter, rateLimit, ipKey, SCANNER_UA, PROBE_PATH };
