'use strict';
/*
 * Nutrishop Inventory API
 * -----------------------
 * Mounted at /api by server.js. Clover tokens live ONLY in environment
 * variables on this server; the browser never sees them.
 *
 * Required env vars:
 *   FRANKLIN_MERCHANT_ID, FRANKLIN_TOKEN
 *   GULCH_MERCHANT_ID,    GULCH_TOKEN
 *   HENDERSON_MERCHANT_ID, HENDERSON_TOKEN
 *   INVENTORY_PASSWORD   – password staff type into the dashboard
 *   SESSION_SECRET       – long random string used to sign logins
 * Optional:
 *   ALLOWED_ORIGINS      – comma list of sites allowed to call the API
 *   CLOVER_BASE          – defaults to https://api.clover.com
 *   CACHE_SECONDS        – how long a sync is reused (default 30)
 */
const express = require('express');
const crypto = require('node:crypto');

const CLOVER_BASE = (process.env.CLOVER_BASE || 'https://api.clover.com').replace(/\/+$/, '');
const CACHE_MS = (Number(process.env.CACHE_SECONDS) || 30) * 1000;
const SESSION_HOURS = 12;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://nstninventory.web.app,https://nstninventory.firebaseapp.com')
  .split(',').map(s => s.trim()).filter(Boolean);

const STORES = [
  { id: 'franklin', name: 'Franklin', env: 'FRANKLIN' },
  { id: 'gulch', name: 'Gulch', env: 'GULCH' },
  { id: 'henderson', name: 'Hendersonville', env: 'HENDERSON' },
].map(s => ({
  ...s,
  merchant: process.env[`${s.env}_MERCHANT_ID`],
  token: process.env[`${s.env}_TOKEN`],
  limit: makeLimiter(4, 70), // Clover allows ~16 req/s per token; stay under it
}));
const STORE_BY_ID = Object.fromEntries(STORES.map(s => [s.id, s]));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/* ── Concurrency + rate limiter (one per Clover token) ── */
function makeLimiter(maxActive, minGapMs) {
  let active = 0, last = 0, timer = null;
  const queue = [];
  const pump = () => {
    timer = null;
    while (active < maxActive && queue.length) {
      const wait = last + minGapMs - Date.now();
      if (wait > 0) { timer = setTimeout(pump, wait); return; }
      last = Date.now();
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(resolve, reject).finally(() => { active--; if (!timer) pump(); });
    }
  };
  return fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    if (!timer) pump();
  });
}

/* ── Clover request with retry on rate-limit ── */
async function clover(store, method, path, { query, body } = {}) {
  const url = new URL(CLOVER_BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await store.limit(() => fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${store.token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(25000),
    }));
    // 429 is always safe to retry; 5xx only for reads (a write may have landed)
    const retryable = res.status === 429 || (method === 'GET' && res.status >= 500);
    if (retryable && attempt < 4) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(ra > 0 ? ra * 1000 : 400 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 200) }; }
    if (!res.ok) {
      const err = new Error(data.message || data.error || `Clover HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
}

async function fetchPaged(store, path, query) {
  const pageSize = 1000;
  let offset = 0, out = [];
  for (;;) {
    const d = await clover(store, 'GET', path, { query: { ...query, limit: pageSize, offset } });
    const els = d.elements || [];
    out = out.concat(els);
    if (els.length < pageSize) return out;
    offset += pageSize;
  }
}

/* ── Inventory snapshot (cached, de-duplicated) ── */
let cache = null;      // { at, data }
let inflight = null;   // Promise while a sync runs

async function loadStore(store) {
  const [items, categories] = await Promise.all([
    fetchPaged(store, `/v3/merchants/${store.merchant}/items`, { expand: 'itemStock,categories' }),
    fetchPaged(store, `/v3/merchants/${store.merchant}/categories`, {}),
  ]);
  return { items, categories };
}

function slimItem(i) {
  return {
    id: i.id,
    name: i.name,
    sku: i.sku || '',
    code: i.code || '',
    price: i.price || 0,       // cents
    cost: i.cost || 0,         // cents
    priceType: i.priceType,
    qty: i.itemStock ? (i.itemStock.quantity ?? 0) : null,
    category: (i.categories?.elements?.[0]?.name || '').trim(),
    hidden: !!i.hidden,
  };
}

/*
 * Products are matched across stores by name (case/space-insensitive).
 * In this account SKUs are reused between different flavours, so they
 * can't be the key. A name that appears twice in ONE store becomes a
 * second product row rather than overwriting the first.
 */
function mergeStores(perStore) {
  const products = [];
  const byName = new Map(); // norm name -> [product,...]
  for (const store of STORES) {
    const items = perStore[store.id]?.items || [];
    for (const raw of items) {
      const it = slimItem(raw);
      const key = norm(it.name);
      const list = byName.get(key) || [];
      let p = list.find(x => !x.stores[store.id]);
      if (!p) {
        p = { key: `${key}#${list.length}`, name: it.name.trim(), stores: {} };
        list.push(p);
        byName.set(key, list);
        products.push(p);
      }
      p.stores[store.id] = it;
    }
  }
  for (const p of products) {
    const first = STORES.map(s => p.stores[s.id]).find(Boolean);
    p.category = first.category || 'Uncategorized';
    p.sku = first.sku;
    p.code = first.code;
  }
  products.sort((a, b) => a.name.localeCompare(b.name));
  return products;
}

async function buildSnapshot() {
  const perStore = {};
  const errors = [];
  await Promise.all(STORES.map(async s => {
    try { perStore[s.id] = await loadStore(s); }
    catch (e) { errors.push({ store: s.id, message: e.message }); }
  }));
  const categories = [...new Set(STORES.flatMap(s =>
    (perStore[s.id]?.categories || []).map(c => c.name.trim())))].filter(Boolean).sort();
  return {
    syncedAt: new Date().toISOString(),
    stores: STORES.map(s => ({ id: s.id, name: s.name, ok: !!perStore[s.id] })),
    categories,
    products: mergeStores(perStore),
    errors,
    _categoryIds: Object.fromEntries(STORES.map(s => [s.id,
      Object.fromEntries((perStore[s.id]?.categories || []).map(c => [norm(c.name), c.id]))])),
  };
}

async function getSnapshot(fresh) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  if (!inflight) {
    inflight = buildSnapshot()
      .then(data => { if (!data.errors.length) cache = { at: Date.now(), data }; return data; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}
const invalidate = () => { cache = null; };

/* ── Auth (password -> signed, expiring token) ── */
function sign(payload) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
}
function issueToken() {
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, expiresAt: exp };
}
function verifyToken(tok) {
  if (typeof tok !== 'string') return false;
  const [payload, sig] = tok.split('.');
  if (!payload || !sig) return false;
  const good = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); }
  catch { return false; }
}
function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(process.env.INVENTORY_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
const loginAttempts = new Map(); // ip -> {count, resetAt}
function loginAllowed(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || rec.resetAt < now) { loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60e3 }); return true; }
  rec.count++;
  return rec.count <= 10;
}

/* ── Validation helpers ── */
class BadRequest extends Error { constructor(m) { super(m); this.status = 400; } }
function toCents(v, field) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n) || n < 0 || n > 100000) throw new BadRequest(`${field} must be a dollar amount`);
  return Math.round(n * 100);
}
function toQty(v) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v === null || v === '' || !Number.isInteger(n) || Math.abs(n) > 1e6) throw new BadRequest('quantity must be a whole number');
  return n;
}
function cleanText(v, field, max, required) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new BadRequest(`${field} is required`);
  if (s.length > max) throw new BadRequest(`${field} is too long (max ${max})`);
  return s;
}
function storeFor(id) {
  const s = STORE_BY_ID[id];
  if (!s) throw new BadRequest(`unknown store: ${id}`);
  return s;
}

/* ── Write operations ── */
async function setStock(store, itemId, qty) {
  await clover(store, 'POST', `/v3/merchants/${store.merchant}/item_stocks/${itemId}`,
    { body: { item: { id: itemId }, quantity: qty } });
}

async function ensureCategory(store, name, snapshot) {
  if (!name) return null;
  const ids = snapshot?._categoryIds?.[store.id] || {};
  if (ids[norm(name)]) return ids[norm(name)];
  // Not in the snapshot: look it up fresh, then create if truly missing.
  const cats = await fetchPaged(store, `/v3/merchants/${store.merchant}/categories`, {});
  const hit = cats.find(c => norm(c.name) === norm(name));
  const id = hit ? hit.id : (await clover(store, 'POST', `/v3/merchants/${store.merchant}/categories`, { body: { name } })).id;
  ids[norm(name)] = id;
  return id;
}

async function createInStore(store, spec, snapshot) {
  const item = await clover(store, 'POST', `/v3/merchants/${store.merchant}/items`, {
    body: {
      name: spec.name, price: spec.price, cost: spec.cost, priceType: 'FIXED',
      ...(spec.sku ? { sku: spec.sku } : {}), ...(spec.code ? { code: spec.code } : {}),
    },
  });
  const warnings = [];
  try { await setStock(store, item.id, spec.qty); }
  catch (e) { warnings.push(`stock not set: ${e.message}`); }
  if (spec.category) {
    try {
      const catId = await ensureCategory(store, spec.category, snapshot);
      await clover(store, 'POST', `/v3/merchants/${store.merchant}/category_items`,
        { body: { elems: [{ category: { id: catId }, item: { id: item.id } }] } });
    } catch (e) { warnings.push(`category not set: ${e.message}`); }
  }
  return {
    item: { id: item.id, name: spec.name, sku: spec.sku, code: spec.code, price: spec.price, cost: spec.cost,
      priceType: 'FIXED', qty: warnings.some(w => w.startsWith('stock')) ? null : spec.qty,
      category: spec.category, hidden: false },
    warnings,
  };
}

/* ── Router ── */
function inventoryRouter() {
  const missing = [
    ...STORES.flatMap(s => [`${s.env}_MERCHANT_ID`, `${s.env}_TOKEN`]),
    'INVENTORY_PASSWORD', 'SESSION_SECRET',
  ].filter(k => !process.env[k]);
  const router = express.Router();

  router.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(express.json({ limit: '200kb' }));

  router.get('/health', (req, res) => res.json({ ok: true, configured: !missing.length }));

  if (missing.length) {
    console.warn(`[inventory] disabled – missing env vars: ${missing.join(', ')}`);
    router.use((req, res) => res.status(503).json({ error: `Server not configured. Missing: ${missing.join(', ')}` }));
    return router;
  }

  router.post('/login', (req, res) => {
    if (!loginAllowed(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    if (!passwordMatches(req.body?.password)) return res.status(401).json({ error: 'Wrong password' });
    loginAttempts.delete(req.ip);
    res.json(issueToken());
  });

  router.use((req, res, next) => {
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!verifyToken(tok)) return res.status(401).json({ error: 'Please sign in again' });
    next();
  });

  router.get('/inventory', async (req, res, next) => {
    try {
      const { _categoryIds, ...data } = await getSnapshot(req.query.fresh === '1');
      res.json(data);
    } catch (e) { next(e); }
  });

  /*
   * POST /api/items/update
   * { changes: [{ store, itemId, price?, cost?, qty?, name? }] }  (dollars)
   * Only fields present are sent to Clover.
   */
  router.post('/items/update', async (req, res, next) => {
    try {
      const changes = req.body?.changes;
      if (!Array.isArray(changes) || !changes.length || changes.length > 50) throw new BadRequest('changes must be a list of 1–50 edits');
      const plan = changes.map(c => {
        const store = storeFor(c.store);
        if (typeof c.itemId !== 'string' || !/^[A-Z0-9]{8,20}$/.test(c.itemId)) throw new BadRequest('bad itemId');
        const fields = {};
        const price = toCents(c.price, 'price'); if (price !== undefined) fields.price = price;
        const cost = toCents(c.cost, 'cost'); if (cost !== undefined) fields.cost = cost;
        if (c.name !== undefined) fields.name = cleanText(c.name, 'name', 127, true);
        return { store, itemId: c.itemId, fields, qty: toQty(c.qty) };
      });
      const results = await Promise.all(plan.map(async p => {
        const out = { store: p.store.id, itemId: p.itemId, ok: true, errors: [], saved: {} };
        if (Object.keys(p.fields).length) {
          try {
            await clover(p.store, 'POST', `/v3/merchants/${p.store.merchant}/items/${p.itemId}`, { body: p.fields });
            Object.assign(out.saved, p.fields);
          } catch (e) { out.ok = false; out.errors.push(`price/cost: ${e.message}`); }
        }
        if (p.qty !== undefined) {
          try { await setStock(p.store, p.itemId, p.qty); out.saved.qty = p.qty; }
          catch (e) { out.ok = false; out.errors.push(`quantity: ${e.message}`); }
        }
        return out;
      }));
      invalidate();
      res.json({ results });
    } catch (e) { next(e); }
  });

  /*
   * POST /api/items/create
   * { name, sku?, code?, category?, price, cost,
   *   stores: { franklin: { qty, price?, cost? }, gulch: {...}, ... } }
   * Creates the product in every store listed. Skips stores that
   * already carry an item with the same name.
   */
  router.post('/items/create', async (req, res, next) => {
    try {
      const b = req.body || {};
      const base = {
        name: cleanText(b.name, 'name', 127, true),
        sku: cleanText(b.sku, 'SKU', 64),
        code: cleanText(b.code, 'UPC', 64),
        category: cleanText(b.category, 'category', 64),
        price: toCents(b.price ?? 0, 'price'),
        cost: toCents(b.cost ?? 0, 'cost'),
      };
      const storeIds = Object.keys(b.stores || {});
      if (!storeIds.length) throw new BadRequest('pick at least one store');
      const specs = storeIds.map(id => {
        const o = b.stores[id] || {};
        return {
          store: storeFor(id),
          spec: { ...base,
            qty: toQty(o.qty ?? 0),
            ...(o.price !== undefined ? { price: toCents(o.price, 'price') } : {}),
            ...(o.cost !== undefined ? { cost: toCents(o.cost, 'cost') } : {}) },
        };
      });
      const snapshot = await getSnapshot(true); // fresh check for duplicates
      const results = await Promise.all(specs.map(async ({ store, spec }) => {
        const dupe = snapshot.products.find(p => norm(p.name) === norm(spec.name) && p.stores[store.id]);
        if (dupe) return { store: store.id, ok: false, errors: [`${store.name} already has "${dupe.name}"`] };
        try {
          const r = await createInStore(store, spec, snapshot);
          return { store: store.id, ok: true, item: r.item, errors: r.warnings };
        } catch (e) { return { store: store.id, ok: false, errors: [e.message] }; }
      }));
      invalidate();
      res.json({ results });
    } catch (e) { next(e); }
  });

  router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status && err.status < 500 ? err.status : 502;
    if (status >= 500) console.error('[inventory]', err);
    res.status(status).json({ error: err.message || 'Something went wrong' });
  });

  return router;
}

module.exports = { inventoryRouter, _test: { mergeStores, makeLimiter, norm } };
