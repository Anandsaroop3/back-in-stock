'use strict';
const { clampStr } = require('./util');

const MAX_BODY = 1_000_000;

class StockError extends Error {
  constructor(msg, status) {
    super(msg);
    this.name = 'StockError';
    this.status = status;
  }
}

function httpsUrl(v) {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? u.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
}

function toInt(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) && n >= 0 && n <= 1e9 ? n : null;
}

function formatPrice(p) {
  try {
    if (typeof p.price_cents === 'number') {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: clampStr(p.currency, 3) || 'USD' }).format(p.price_cents / 100);
    }
    if (typeof p.price === 'number') {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: clampStr(p.currency, 3) || 'USD' }).format(p.price);
    }
  } catch {
    /* bad currency code */
  }
  return typeof p.price === 'string' ? clampStr(p.price, 24) || null : null;
}

/**
 * Normalise whatever the upstream returns into one trusted shape. Upstream
 * data is treated as untrusted: strings are length-capped and stripped of
 * control characters, URLs must be https.
 */
function normalize(p, fallbackSku) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  // An object with no stock information at all (`{}`, `{"error":"..."}` with a 200) is not a product.
  if (!['quantity', 'in_stock', 'stock', 'available'].some((k) => k in p)) return null;
  const sku = clampStr(typeof p.sku === 'string' ? p.sku : '', 64) || fallbackSku;
  if (!sku) return null;
  const qty = toInt(p.quantity ?? p.stock ?? p.available);
  const flag = typeof p.in_stock === 'boolean' ? p.in_stock : null;
  const inStock = flag === null ? qty !== null && qty > 0 : flag && (qty === null || qty > 0);
  return {
    sku,
    name: clampStr(typeof p.name === 'string' ? p.name : p.title, 140) || sku,
    quantity: qty,
    inStock: Boolean(inStock),
    image: httpsUrl(p.image ?? p.image_url ?? p.thumbnail),
    url: httpsUrl(p.url ?? p.product_url ?? p.link),
    price: formatPrice(p),
  };
}

async function readCapped(res, cap) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) {
      await reader.cancel();
      throw new StockError('stock api response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class StockClient {
  constructor({ apiUrl, apiKey, timeoutMs = 5000, fetchImpl = fetch }) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this._cat = { at: 0, data: null };
  }

  async _get(urlPath) {
    let res;
    try {
      res = await this.fetch(this.apiUrl + urlPath, {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error', // never follow redirects with our bearer token attached
      });
    } catch (e) {
      throw new StockError(`stock api unreachable (${e.name})`);
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return { status: 404 };
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new StockError(`stock api returned ${res.status}`, res.status);
    }
    const text = await readCapped(res, MAX_BODY);
    try {
      return { status: 200, body: JSON.parse(text) };
    } catch {
      throw new StockError('stock api returned invalid JSON');
    }
  }

  /** @returns normalised product, or null if the SKU does not exist. Throws StockError when unreachable. */
  async getProduct(sku) {
    const r = await this._get(`/${encodeURIComponent(sku)}`);
    if (r.status === 404) return null;
    const p = normalize(r.body, sku);
    if (!p) throw new StockError('stock api returned unexpected shape');
    return p;
  }

  async getCatalogue({ maxAgeMs = 0 } = {}) {
    if (maxAgeMs && this._cat.data && Date.now() - this._cat.at < maxAgeMs) return this._cat.data;
    const r = await this._get('');
    if (r.status === 404) throw new StockError('catalogue not found', 404);
    const b = r.body;
    const arr = Array.isArray(b) ? b : b && (b.products || b.items || b.data || b.catalogue || b.catalog);
    if (!Array.isArray(arr)) throw new StockError('stock api returned unexpected catalogue shape');
    const out = arr.map((p) => normalize(p)).filter(Boolean).slice(0, 2000);
    this._cat = { at: Date.now(), data: out };
    return out;
  }
}

module.exports = { StockClient, StockError, normalize };
