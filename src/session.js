'use strict';
const crypto = require('node:crypto');

/** Stateless signed admin sessions: v1.<expiry>.<nonce>.<hmac>. HttpOnly + SameSite=Strict cookie. */
const sign = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

function issue(secret, ttlSec) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const nonce = crypto.randomBytes(12).toString('base64url');
  const body = `v1.${exp}.${nonce}`;
  return { token: `${body}.${sign(secret, body)}`, nonce };
}

function verify(secret, token) {
  if (typeof token !== 'string' || token.length > 200) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const expected = Buffer.from(sign(secret, parts.slice(0, 3).join('.')));
  const given = Buffer.from(parts[3]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  if (!(Number(parts[1]) > Date.now() / 1000)) return null;
  return { nonce: parts[2] };
}

const csrfToken = (secret, nonce) => sign(secret, `csrf.${nonce}`);

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || header.length > 4096) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

module.exports = { issue, verify, csrfToken, parseCookies };
