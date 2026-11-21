'use strict';
/* Postgres connection + schema. Needs DATABASE_URL. */
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    // Render's internal URL has no SSL; external URLs need it.
    const ssl = /sslmode=require/.test(url) || process.env.DATABASE_SSL === '1' ? { rejectUnauthorized: false } : false;
    pool = new Pool({ connectionString: url, ssl, max: 5 });
    pool.on('error', e => console.error('[db]', e.message));
  }
  return pool;
}

const q = (text, params) => getPool().query(text, params);

async function tx(fn) {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id            serial PRIMARY KEY,
      username      text UNIQUE NOT NULL,
      display_name  text NOT NULL,
      role          text NOT NULL CHECK (role IN ('admin','employee')),
      pw_hash       text NOT NULL,
      active        boolean NOT NULL DEFAULT true,
      token_version int NOT NULL DEFAULT 0,
      created_at    timestamptz NOT NULL DEFAULT now(),
      last_login_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS counts (
      id           serial PRIMARY KEY,
      store        text NOT NULL,
      status       text NOT NULL CHECK (status IN ('open','submitting','submitted','discarded')),
      started_by   int REFERENCES users(id),
      started_at   timestamptz NOT NULL DEFAULT now(),
      submitted_by int REFERENCES users(id),
      submitted_at timestamptz,
      summary      jsonb
    );
    CREATE UNIQUE INDEX IF NOT EXISTS counts_one_open ON counts(store) WHERE status IN ('open','submitting');
    CREATE INDEX IF NOT EXISTS counts_store_started ON counts(store, started_at DESC);
    CREATE TABLE IF NOT EXISTS count_lines (
      count_id   int NOT NULL REFERENCES counts(id) ON DELETE CASCADE,
      item_id    text NOT NULL,
      item_name  text,
      counted    int NOT NULL,
      counted_by int REFERENCES users(id),
      counted_at timestamptz NOT NULL DEFAULT now(),
      before_qty int,
      unit_cost  int,
      unit_price int,
      applied    boolean NOT NULL DEFAULT false,
      error      text,
      PRIMARY KEY (count_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS audit (
      id         bigserial PRIMARY KEY,
      at         timestamptz NOT NULL DEFAULT now(),
      user_id    int REFERENCES users(id),
      store      text NOT NULL,
      item_id    text,
      item_name  text,
      field      text NOT NULL,
      before_val bigint,
      after_val  bigint,
      unit_cost  int,
      unit_price int,
      source     text NOT NULL,
      count_id   int
    );
    CREATE INDEX IF NOT EXISTS audit_store_at ON audit(store, at DESC);
  `);
}

module.exports = { q, tx, migrate, getPool };
