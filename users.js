'use strict';
/* Employee accounts, sign-in tokens and permissions. */
const express = require('express');
const crypto = require('node:crypto');
const { q } = require('./db');

const TOKEN_DAYS = 30; // stay signed in through crashes / closed tabs
class HttpError extends Error { constructor(status, m) { super(m); this.status = status; } }

/* ── Passwords ── */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 32);
  return `s1$${salt.toString('base64')}$${h.toString('base64')}`;
}
function checkPassword(pw, stored) {
  const [, s, h] = String(stored).split('$');
  if (!s || !h) return false;
  const calc = crypto.scryptSync(String(pw ?? ''), Buffer.from(s, 'base64'), 32);
  const want = Buffer.from(h, 'base64');
  return want.length === calc.length && crypto.timingSafeEqual(calc, want);
}
const DUMMY_HASH = hashPassword('not-a-real-password'); // keeps timing equal for unknown users

/* ── Tokens ── */
const sign = p => crypto.createHmac('sha256', process.env.SESSION_SECRET).update(p).digest('base64url');
function issueToken(user) {
  const exp = Date.now() + TOKEN_DAYS * 864e5;
  const payload = Buffer.from(JSON.stringify({ u: user.id, v: user.token_version, exp })).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, expiresAt: exp };
}
function readToken(tok) {
  if (typeof tok !== 'string') return null;
  const [payload, sig] = tok.split('.');
  if (!payload || !sig) return null;
  const good = Buffer.from(sign(payload)), given = Buffer.from(sig);
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}

/* ── User lookup with a short cache ── */
const cache = new Map(); // id -> {at, user}
async function getUser(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 30e3) return hit.user;
  const { rows } = await q('SELECT * FROM users WHERE id=$1', [id]);
  cache.set(id, { at: Date.now(), user: rows[0] || null });
  return rows[0] || null;
}
const forget = id => cache.delete(id);
const publicUser = u => ({ id: u.id, username: u.username, name: u.display_name, role: u.role, active: u.active,
  stores: u.role === 'admin' ? null : (u.stores || null),   // null = every store
  createdAt: u.created_at, lastLoginAt: u.last_login_at });

/* Store access: admins see every store; employees see their list (or all if none set). */
let STORE_IDS = [];
const setStoreIds = ids => { STORE_IDS = ids; };
const canUseStore = (user, storeId) => user.role === 'admin' || !user.stores || user.stores.includes(storeId);
function cleanStores(v) {
  if (v === null) return null;
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, 'Pick at least one store');
  const ids = [...new Set(v)];
  if (ids.some(id => !STORE_IDS.includes(id))) throw new HttpError(400, 'Unknown store');
  return ids.length === STORE_IDS.length ? null : ids;
}

/* First run: turn the old shared password into an "admin" account. */
async function bootstrap() {
  const { rows } = await q('SELECT count(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    await q(`INSERT INTO users (username, display_name, role, pw_hash) VALUES ('admin','Owner','admin',$1)`,
      [hashPassword(process.env.INVENTORY_PASSWORD)]);
    console.log('[users] created admin account (username "admin", password = INVENTORY_PASSWORD)');
  }
}

/* ── Middleware ── */
async function authenticate(req, res, next) {
  try {
    const d = readToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const user = d && await getUser(d.u);
    if (!user || !user.active || user.token_version !== d.v) throw new HttpError(401, 'Please sign in again');
    req.user = user;
    next();
  } catch (e) { next(e); }
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return next(new HttpError(403, 'Only an admin can do that'));
  next();
}

/* ── Validation ── */
function cleanUsername(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(s)) throw new HttpError(400, 'Username: 2–32 letters, numbers, dots, dashes or underscores (no spaces)');
  return s;
}
function cleanName(v) {
  const s = String(v ?? '').trim();
  if (!s || s.length > 60) throw new HttpError(400, 'Name is required (max 60 characters)');
  return s;
}
function cleanPassword(v) {
  const s = String(v ?? '');
  if (s.length < 6 || s.length > 100) throw new HttpError(400, 'Password must be at least 6 characters');
  return s;
}
function cleanRole(v) {
  if (v !== 'admin' && v !== 'employee') throw new HttpError(400, 'Role must be admin or employee');
  return v;
}

const loginAttempts = new Map(); // ip -> {count, resetAt}
function loginAllowed(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || rec.resetAt < now) { loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60e3 }); return true; }
  return ++rec.count <= 10;
}

/* Public routes (mounted before authenticate) */
function loginRouter() {
  const r = express.Router();
  r.post('/login', async (req, res, next) => {
    try {
      if (!loginAllowed(req.ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
      const username = String(req.body?.username ?? '').trim().toLowerCase();
      const { rows } = await q('SELECT * FROM users WHERE username=$1', [username]);
      const u = rows[0];
      const ok = checkPassword(req.body?.password, u ? u.pw_hash : DUMMY_HASH);
      if (!u || !ok || !u.active) throw new HttpError(401, 'Wrong username or password');
      loginAttempts.delete(req.ip);
      await q('UPDATE users SET last_login_at=now() WHERE id=$1', [u.id]);
      res.json({ ...issueToken(u), user: publicUser(u) });
    } catch (e) { next(e); }
  });
  return r;
}

/* Authenticated routes */
function userRouter() {
  const r = express.Router();
  r.get('/me', (req, res) => res.json({ user: publicUser(req.user) }));

  r.get('/users', requireAdmin, async (req, res, next) => {
    try {
      const { rows } = await q('SELECT * FROM users ORDER BY active DESC, lower(display_name)');
      res.json({ users: rows.map(publicUser) });
    } catch (e) { next(e); }
  });

  r.post('/users', requireAdmin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const vals = [cleanUsername(b.username), cleanName(b.name), cleanRole(b.role || 'employee'), hashPassword(cleanPassword(b.password)),
        b.stores === undefined ? null : cleanStores(b.stores)];
      const { rows } = await q(`INSERT INTO users (username, display_name, role, pw_hash, stores) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (username) DO NOTHING RETURNING *`, vals);
      if (!rows[0]) throw new HttpError(409, `Username "${vals[0]}" is already taken`);
      res.json({ user: publicUser(rows[0]) });
    } catch (e) { next(e); }
  });

  r.post('/users/:id', requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { rows: [u] } = await q('SELECT * FROM users WHERE id=$1', [id]);
      if (!u) throw new HttpError(404, 'User not found');
      const b = req.body || {};
      const sets = [], vals = [];
      const set = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
      let kick = false;
      if (b.name !== undefined) set('display_name', cleanName(b.name));
      if (b.username !== undefined) set('username', cleanUsername(b.username));
      if (b.password !== undefined) { set('pw_hash', hashPassword(cleanPassword(b.password))); kick = true; }
      if (b.role !== undefined) { set('role', cleanRole(b.role)); kick = true; }
      if (b.active !== undefined) { set('active', !!b.active); kick = true; }
      if (b.stores !== undefined) set('stores', cleanStores(b.stores));
      if (!sets.length) throw new HttpError(400, 'Nothing to change');
      // Never leave the shop without an active admin.
      const losingAdmin = u.role === 'admin' && u.active && (b.role === 'employee' || b.active === false);
      if (losingAdmin) {
        const { rows: [{ n }] } = await q(`SELECT count(*)::int n FROM users WHERE role='admin' AND active AND id<>$1`, [id]);
        if (n === 0) throw new HttpError(400, 'You need at least one active admin');
      }
      if (kick && id !== req.user.id) sets.push('token_version = token_version + 1'); // sign them out everywhere
      vals.push(id);
      const { rows: [nu] } = await q(`UPDATE users SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals)
        .catch(e => { if (e.code === '23505') throw new HttpError(409, 'That username is already taken'); throw e; });
      forget(id);
      res.json({ user: publicUser(nu) });
    } catch (e) { next(e); }
  });
  return r;
}

module.exports = { bootstrap, authenticate, requireAdmin, loginRouter, userRouter, HttpError, publicUser, setStoreIds, canUseStore, _test: { hashPassword, checkPassword } };
