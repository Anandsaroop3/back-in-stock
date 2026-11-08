'use strict';
const crypto = require('node:crypto');

/* ---------- HTML templating with escape-by-default ---------- */
class Raw {
  constructor(s) {
    this.value = String(s);
  }
  toString() {
    return this.value;
  }
}
const raw = (s) => new Raw(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

function esc(v) {
  if (v instanceof Raw) return v.value;
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(esc).join('');
  return String(v).replace(/[&<>"'`]/g, (c) => ESC[c]);
}

/** Tagged template: every interpolation is escaped unless wrapped in raw()/html``. */
function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += esc(vals[i]);
  });
  return new Raw(out);
}

/* ---------- crypto helpers ---------- */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Short, stable, non-guessable ticket code for (email, sku). Decorative but consistent everywhere. */
function ticketCode(secret, email, sku) {
  const h = crypto.createHmac('sha256', secret).update(`ticket\0${email}\0${sku}`).digest();
  let out = '';
  for (let i = 0; i < 6; i++) out += B32[h[i] % 32];
  return `E-${out}`;
}

/* ---------- validation ---------- */
const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function normalizeEmail(v) {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  if (e.length < 6 || e.length > 254) return null;
  const at = e.lastIndexOf('@');
  if (at < 1 || at > 64) return null;
  return EMAIL_RE.test(e) ? e : null;
}
const normalizeSku = (v) => (typeof v === 'string' && SKU_RE.test(v.trim()) ? v.trim() : null);
const isEventId = (v) => typeof v === 'string' && EVENT_ID_RE.test(v);

/* ---------- misc ---------- */
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection (CWE-1236).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function maskEmail(e) {
  if (!e) return '';
  const at = e.indexOf('@');
  if (at < 1) return '***';
  return `${e[0]}***${e.slice(at)}`;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clampStr = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '');
const first = (v) => (Array.isArray(v) ? v[0] : v);

module.exports = {
  raw, esc, html, Raw,
  safeEqual, ticketCode,
  normalizeEmail, normalizeSku, isEventId,
  csvCell, maskEmail, fmtDuration, sleep, clampStr, first,
};
