'use strict';
/*
 * Inventory counts
 * ----------------
 * open        – employees enter counts; every change is saved here, Clover untouched
 * submitting  – the final "Submit" was pressed; quantities are being written to Clover
 * submitted   – done; before/after for every counted item is kept for reports
 * discarded   – thrown away without touching Clover
 */
const express = require('express');
const { q, tx } = require('./db');
const { requireAdmin, HttpError, canUseStore, allowedStores, isAdminRole } = require('./users');

function countsRouter(ctx) {
  const { STORES, storeFor, getSnapshot, fetchStoreItems, setStock, invalidate } = ctx;
  const r = express.Router();
  const progress = new Map(); // count id -> {done,total}

  const intParam = v => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id'); return n; };
  const allowStore = (req, storeId) => { if (!canUseStore(req.user, storeId)) throw new HttpError(403, 'You don’t have access to that store'); };
  async function loadCountFor(req, id) { const c = await loadCount(id); allowStore(req, c.store); return c; }
  async function loadCount(id) {
    const { rows: [c] } = await q(`SELECT c.*, su.display_name AS started_name, sb.display_name AS submitted_name
      FROM counts c LEFT JOIN users su ON su.id=c.started_by LEFT JOIN users sb ON sb.id=c.submitted_by WHERE c.id=$1`, [id]);
    if (!c) throw new HttpError(404, 'Count not found');
    return c;
  }
  const countMeta = c => ({
    id: c.id, store: c.store, storeName: storeFor(c.store).name, status: c.status,
    startedBy: c.started_name, startedAt: c.started_at, submittedBy: c.submitted_name, submittedAt: c.submitted_at,
    summary: c.summary, progress: progress.get(c.id) || null,
  });
  /* Items a store can count: everything with a fixed price (skips gift cards etc.) */
  async function countableItems(storeId) {
    const snap = await getSnapshot(false);
    const out = [];
    for (const p of snap.products) {
      const it = p.stores[storeId];
      if (!it || it.priceType === 'VARIABLE') continue;
      out.push({ itemId: it.id, name: it.name.trim(), sku: it.sku, code: it.code, category: it.category || 'Uncategorized' });
    }
    return out;
  }

  /* Store picker: what's open / when each store was last counted */
  r.get('/counts/stores', async (req, res, next) => {
    try {
      const { rows: open } = await q(`SELECT c.id, c.store, c.status, c.started_at, u.display_name AS started_name,
          (SELECT count(*)::int FROM count_lines l WHERE l.count_id=c.id) AS counted
        FROM counts c LEFT JOIN users u ON u.id=c.started_by WHERE c.status IN ('open','submitting')`);
      const { rows: last } = await q(`SELECT DISTINCT ON (store) store, submitted_at, u.display_name AS submitted_name
        FROM counts c LEFT JOIN users u ON u.id=c.submitted_by WHERE status='submitted' ORDER BY store, submitted_at DESC`);
      res.json({ stores: STORES.filter(s => canUseStore(req.user, s.id)).map(s => {
        const o = open.find(x => x.store === s.id), l = last.find(x => x.store === s.id);
        return { id: s.id, name: s.name,
          open: o ? { id: o.id, status: o.status, startedBy: o.started_name, startedAt: o.started_at, counted: o.counted } : null,
          lastCount: l ? { at: l.submitted_at, by: l.submitted_name } : null };
      }) });
    } catch (e) { next(e); }
  });

  /* Start (or rejoin) the store's open count */
  r.post('/counts', async (req, res, next) => {
    try {
      const store = storeFor(req.body?.store);
      allowStore(req, store.id);
      const { rows: [ex] } = await q(`SELECT id FROM counts WHERE store=$1 AND status IN ('open','submitting')`, [store.id]);
      let id = ex?.id;
      if (!id) {
        const { rows } = await q(`INSERT INTO counts (store, status, started_by) VALUES ($1,'open',$2)
          ON CONFLICT DO NOTHING RETURNING id`, [store.id, req.user.id]);
        id = rows[0]?.id ?? (await q(`SELECT id FROM counts WHERE store=$1 AND status IN ('open','submitting')`, [store.id])).rows[0].id;
      }
      res.json({ count: countMeta(await loadCount(id)) });
    } catch (e) { next(e); }
  });

  /* Count sheet: items + what's been entered so far (no Clover quantities = blind count) */
  r.get('/counts/:id', async (req, res, next) => {
    try {
      const c = await loadCountFor(req, intParam(req.params.id));
      const { rows } = await q(`SELECT l.item_id, l.counted, l.counted_at, u.display_name AS by
        FROM count_lines l LEFT JOIN users u ON u.id=l.counted_by WHERE count_id=$1`, [c.id]);
      const items = c.status === 'open' ? await countableItems(c.store) : [];
      res.json({ count: countMeta(c), items,
        lines: Object.fromEntries(rows.map(l => [l.item_id, { counted: l.counted, by: l.by, at: l.counted_at }])) });
    } catch (e) { next(e); }
  });

  /* Autosave: [{itemId, counted}] — counted null clears the entry */
  r.put('/counts/:id/lines', async (req, res, next) => {
    try {
      const id = intParam(req.params.id);
      const lines = req.body?.lines;
      if (!Array.isArray(lines) || lines.length > 2000) throw new HttpError(400, 'lines must be a list');
      for (const l of lines) {
        if (typeof l.itemId !== 'string' || !/^[A-Za-z0-9]{6,20}$/.test(l.itemId)) throw new HttpError(400, 'bad itemId');
        if (l.counted !== null && (!Number.isInteger(l.counted) || l.counted < 0 || l.counted > 100000)) throw new HttpError(400, 'Counts must be whole numbers, 0 or more');
      }
      const total = await tx(async db => {
        const { rows: [c] } = await db.query('SELECT status, store FROM counts WHERE id=$1 FOR UPDATE', [id]);
        if (!c) throw new HttpError(404, 'Count not found');
        allowStore(req, c.store);
        if (c.status !== 'open') throw new HttpError(409, 'This count was already submitted or discarded');
        for (const l of lines) {
          if (l.counted === null) await db.query('DELETE FROM count_lines WHERE count_id=$1 AND item_id=$2', [id, l.itemId]);
          else await db.query(`INSERT INTO count_lines (count_id, item_id, counted, counted_by) VALUES ($1,$2,$3,$4)
            ON CONFLICT (count_id, item_id) DO UPDATE SET counted=EXCLUDED.counted, counted_by=EXCLUDED.counted_by, counted_at=now()`,
            [id, l.itemId, l.counted, req.user.id]);
        }
        const { rows: [{ n }] } = await db.query('SELECT count(*)::int n FROM count_lines WHERE count_id=$1', [id]);
        return n;
      });
      res.json({ ok: true, counted: total });
    } catch (e) { next(e); }
  });

  /* Review before submitting: compares counts with Clover right now */
  r.get('/counts/:id/review', async (req, res, next) => {
    try {
      const c = await loadCountFor(req, intParam(req.params.id));
      if (c.status !== 'open') throw new HttpError(409, 'This count is no longer open');
      const store = storeFor(c.store);
      const [fresh, items, { rows: lines }] = await Promise.all([
        fetchStoreItems(store), countableItems(c.store),
        q('SELECT item_id, counted FROM count_lines WHERE count_id=$1', [c.id]),
      ]);
      const byId = new Map(fresh.map(i => [i.id, i]));
      const admin = isAdminRole(req.user.role);
      const changes = [], missing = [];
      let unitsUp = 0, unitsDown = 0, costChange = 0, retailChange = 0;
      for (const l of lines) {
        const it = byId.get(l.item_id);
        if (!it) { missing.push(l.item_id); continue; }
        const before = it.qty ?? 0, diff = l.counted - before;
        if (!diff) continue;
        diff > 0 ? unitsUp += diff : unitsDown -= diff;
        costChange += diff * it.cost; retailChange += diff * it.price;
        changes.push({ itemId: it.id, name: it.name.trim(), category: it.category || 'Uncategorized', clover: before, counted: l.counted, diff,
          ...(admin ? { costChange: diff * it.cost } : {}) });
      }
      changes.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.name.localeCompare(b.name));
      res.json({ count: countMeta(c), totalItems: items.length, counted: lines.length, uncounted: items.length - lines.length,
        changes, missing: missing.length, unitsUp, unitsDown,
        ...(admin ? { costChange, retailChange } : {}) });
    } catch (e) { next(e); }
  });

  /* Final submit → write to Clover in the background */
  r.post('/counts/:id/submit', async (req, res, next) => {
    try {
      const id = intParam(req.params.id);
      await loadCountFor(req, id);
      const { rows: [c] } = await q(`UPDATE counts SET status='submitting', submitted_by=$2 WHERE id=$1 AND status='open'
        AND EXISTS (SELECT 1 FROM count_lines WHERE count_id=$1) RETURNING *`, [id, req.user.id]);
      if (!c) {
        const cur = await loadCount(id);
        if (cur.status === 'open') throw new HttpError(400, 'Count at least one item before submitting');
        throw new HttpError(409, cur.status === 'submitting' ? 'Already being submitted' : 'This count is no longer open');
      }
      runSubmit(id).catch(e => console.error('[counts] submit failed', id, e));
      res.json({ count: countMeta(await loadCount(id)) });
    } catch (e) { next(e); }
  });

  r.get('/counts/:id/status', async (req, res, next) => {
    try { res.json({ count: countMeta(await loadCountFor(req, intParam(req.params.id))) }); } catch (e) { next(e); }
  });

  /* Throw away an open count (admin, or the person who started it) */
  r.post('/counts/:id/discard', async (req, res, next) => {
    try {
      const c = await loadCountFor(req, intParam(req.params.id));
      if (!isAdminRole(req.user.role) && c.started_by !== req.user.id) throw new HttpError(403, 'Only an admin or the person who started this count can discard it');
      const { rowCount } = await q(`UPDATE counts SET status='discarded', submitted_by=$2, submitted_at=now() WHERE id=$1 AND status='open'`, [c.id, req.user.id]);
      if (!rowCount) throw new HttpError(409, 'This count is no longer open');
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* Admin: retry lines that failed to reach Clover */
  r.post('/counts/:id/retry', requireAdmin, async (req, res, next) => {
    try {
      const id = intParam(req.params.id);
      await loadCountFor(req, id);
      const { rowCount } = await q(`UPDATE counts SET status='submitting' WHERE id=$1 AND status='submitted'
        AND EXISTS (SELECT 1 FROM count_lines WHERE count_id=$1 AND error IS NOT NULL)`, [id]);
      if (!rowCount) throw new HttpError(409, 'Nothing to retry');
      await q('UPDATE count_lines SET error=NULL WHERE count_id=$1 AND error IS NOT NULL', [id]);
      runSubmit(id).catch(e => console.error('[counts] retry failed', id, e));
      res.json({ count: countMeta(await loadCount(id)) });
    } catch (e) { next(e); }
  });

  /*
   * Writes every counted quantity to Clover. Safe to re-run: it only
   * touches lines not yet applied, and sets absolute quantities.
   */
  async function runSubmit(id) {
    const c = await loadCount(id);
    const store = storeFor(c.store);
    const { rows: lines } = await q('SELECT * FROM count_lines WHERE count_id=$1 AND NOT applied AND error IS NULL', [id]);
    const p = { done: 0, total: lines.length };
    progress.set(id, p);
    let fresh = [];
    try { fresh = await fetchStoreItems(store); }
    catch (e) {
      await q(`UPDATE count_lines SET error=$2 WHERE count_id=$1 AND NOT applied`, [id, `Couldn't read Clover: ${e.message}`]);
      lines.length = 0;
    }
    const byId = new Map(fresh.map(i => [i.id, i]));
    await Promise.all(lines.map(async l => {
      const it = byId.get(l.item_id);
      try {
        if (!it) throw new Error('Item no longer exists in Clover');
        const before = it.qty ?? 0;
        if (l.counted !== before) await setStock(store, l.item_id, l.counted);
        await q(`UPDATE count_lines SET applied=true, error=NULL, before_qty=$3, unit_cost=$4, unit_price=$5, item_name=$6
          WHERE count_id=$1 AND item_id=$2`, [id, l.item_id, before, it.cost, it.price, it.name.trim()]);
        if (l.counted !== before) {
          await q(`INSERT INTO audit (user_id, store, item_id, item_name, field, before_val, after_val, unit_cost, unit_price, source, count_id)
            VALUES ($1,$2,$3,$4,'qty',$5,$6,$7,$8,'count',$9)`,
            [c.submitted_by, store.id, l.item_id, it.name.trim(), before, l.counted, it.cost, it.price, id]);
        }
      } catch (e) {
        await q('UPDATE count_lines SET error=$3, item_name=COALESCE(item_name,$4) WHERE count_id=$1 AND item_id=$2',
          [id, l.item_id, e.message.slice(0, 300), it?.name?.trim() || null]);
      }
      p.done++;
    }));
    const summary = await summarize(id);
    await q(`UPDATE counts SET status='submitted', submitted_at=COALESCE(submitted_at, now()), summary=$2 WHERE id=$1`, [id, summary]);
    progress.delete(id);
    invalidate();
  }

  async function summarize(id) {
    const { rows: [s] } = await q(`SELECT
        count(*)::int AS counted,
        count(*) FILTER (WHERE applied AND counted<>before_qty)::int AS changed,
        COALESCE(sum(GREATEST(counted-before_qty,0)) FILTER (WHERE applied),0)::int AS units_up,
        COALESCE(sum(GREATEST(before_qty-counted,0)) FILTER (WHERE applied),0)::int AS units_down,
        COALESCE(sum((counted-before_qty)*unit_cost) FILTER (WHERE applied),0)::bigint AS cost_change,
        COALESCE(sum((counted-before_qty)*unit_price) FILTER (WHERE applied),0)::bigint AS retail_change,
        count(*) FILTER (WHERE error IS NOT NULL)::int AS failed
      FROM count_lines WHERE count_id=$1`, [id]);
    const { rows: who } = await q(`SELECT DISTINCT u.display_name FROM count_lines l JOIN users u ON u.id=l.counted_by WHERE l.count_id=$1`, [id]);
    return { counted: s.counted, changed: s.changed, unitsUp: s.units_up, unitsDown: s.units_down,
      costChange: Number(s.cost_change), retailChange: Number(s.retail_change), failed: s.failed,
      countedBy: who.map(w => w.display_name) };
  }

  /* Pick up submits interrupted by a restart */
  async function resume() {
    const { rows } = await q(`SELECT id FROM counts WHERE status='submitting'`);
    for (const { id } of rows) runSubmit(id).catch(e => console.error('[counts] resume failed', id, e));
  }

  /* ── Admin reports ── */
  r.get('/reports/counts', requireAdmin, async (req, res, next) => {
    try {
      const store = req.query.store ? storeFor(req.query.store).id : null;
      if (store) allowStore(req, store);
      const { rows } = await q(`SELECT c.*, su.display_name AS started_name, sb.display_name AS submitted_name,
          (SELECT count(*)::int FROM count_lines l WHERE l.count_id=c.id) AS lines
        FROM counts c LEFT JOIN users su ON su.id=c.started_by LEFT JOIN users sb ON sb.id=c.submitted_by
        WHERE ($1::text IS NULL OR c.store=$1) AND c.store = ANY($2) ORDER BY c.started_at DESC LIMIT 200`, [store, allowedStores(req.user)]);
      res.json({ counts: rows.map(c => ({ ...countMeta(c), lines: c.lines })) });
    } catch (e) { next(e); }
  });

  r.get('/reports/counts/:id', requireAdmin, async (req, res, next) => {
    try {
      const c = await loadCountFor(req, intParam(req.params.id));
      const { rows } = await q(`SELECT l.*, u.display_name AS by FROM count_lines l LEFT JOIN users u ON u.id=l.counted_by
        WHERE count_id=$1 ORDER BY abs(l.counted - COALESCE(l.before_qty, l.counted)) DESC, l.item_name`, [c.id]);
      const nameOf = new Map();
      if (rows.some(l => !l.item_name)) (await countableItems(c.store)).forEach(i => nameOf.set(i.itemId, i.name));
      res.json({ count: countMeta(c), lines: rows.map(l => ({
        itemId: l.item_id, name: l.item_name || nameOf.get(l.item_id) || l.item_id, counted: l.counted, before: l.before_qty,
        diff: l.before_qty === null ? null : l.counted - l.before_qty,
        costChange: l.before_qty === null || l.unit_cost === null ? null : (l.counted - l.before_qty) * l.unit_cost,
        applied: l.applied, error: l.error, by: l.by, at: l.counted_at })) });
    } catch (e) { next(e); }
  });

  /* Manual changes made on the Inventory page (not counts) */
  r.get('/reports/edits', requireAdmin, async (req, res, next) => {
    try {
      const store = req.query.store ? storeFor(req.query.store).id : null;
      if (store) allowStore(req, store);
      const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 730);
      const { rows } = await q(`SELECT a.*, u.display_name AS by FROM audit a LEFT JOIN users u ON u.id=a.user_id
        WHERE a.source<>'count' AND ($1::text IS NULL OR a.store=$1) AND a.store = ANY($3) AND a.at > now() - ($2 || ' days')::interval
        ORDER BY a.at DESC LIMIT 1000`, [store, String(days), allowedStores(req.user)]);
      res.json({ edits: rows.map(a => ({ at: a.at, by: a.by, store: a.store, itemName: a.item_name, field: a.field,
        before: a.before_val === null ? null : Number(a.before_val), after: a.after_val === null ? null : Number(a.after_val),
        beforeText: a.before_text, afterText: a.after_text,
        source: a.source, costChange: a.unit_cost === null ? null
          : a.field === 'qty' ? (Number(a.after_val) - Number(a.before_val ?? 0)) * a.unit_cost
          : a.field === 'deleted' && a.before_val !== null ? -Math.max(Number(a.before_val), 0) * a.unit_cost : null })) });
    } catch (e) { next(e); }
  });

  return { router: r, resume };
}

module.exports = { countsRouter };
