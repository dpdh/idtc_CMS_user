import { Router } from 'express';
import { requireFeature } from '../auth.js';
import { pool, withTransaction } from '../db.js';
import { DATE_PATTERN, addDays, badRequest, notFound, sendData, todayWib } from '../http.js';

const MAX_RANGE_DAYS = 92;
const MAX_BACKFILL_DAYS = 7;

// Streak = jumlah hari berturut-turut (berakhir hari ini atau kemarin) dengan minimal 1 amalan.
export function computeStreak(dates, today = todayWib()) {
  const set = new Set(dates);
  let current = 0;
  let cursor = set.has(today) ? today : addDays(today, -1);
  while (set.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  const sorted = [...set].sort();
  let longest = 0;
  let run = 0;
  let previous = null;
  for (const value of sorted) {
    run = previous && addDays(previous, 1) === value ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = value;
  }
  return { current, longest };
}

async function streakFor(userId) {
  const result = await pool.query(
    `SELECT DISTINCT log_date FROM riyadhoh_logs WHERE user_id = $1 AND completed ORDER BY log_date DESC LIMIT 400`,
    [userId]
  );
  return computeStreak(result.rows.map((row) => row.log_date));
}

function validateLogDate(value, field = 'date') {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) throw badRequest('Tanggal harus berformat YYYY-MM-DD.', field);
  const today = todayWib();
  if (value > today) throw badRequest('Tidak dapat mencatat amalan untuk tanggal yang akan datang.', field);
  return value;
}

export async function riyadhohToday(userId) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM riyadhoh_logs l JOIN riyadhoh_items i ON i.id = l.item_id
        WHERE l.user_id = $1 AND l.completed AND l.log_date = $2 AND i.is_active) AS completed,
       (SELECT count(*)::int FROM riyadhoh_items WHERE is_active) AS total`,
    [userId, todayWib()]
  );
  const streak = await streakFor(userId);
  return { ...result.rows[0], streak: streak.current };
}

export function riyadhohRoutes() {
  const router = Router();

  router.get('/riyadhoh/items', async (_request, response) => {
    const [items, docs] = await Promise.all([
      pool.query('SELECT id, name, category, icon, rakaat, sort_order FROM riyadhoh_items WHERE is_active ORDER BY sort_order, id'),
      pool.query('SELECT id, title, body FROM riyadhoh_docs ORDER BY sort_order, id')
    ]);
    const categories = [];
    for (const item of items.rows) {
      if (!categories.some((category) => category.label === item.category)) {
        categories.push({ label: item.category, sortOrder: categories.length + 1 });
      }
    }
    return sendData(response, {
      categories,
      items: items.rows.map((item) => ({
        id: item.id, name: item.name, category: item.category, icon: item.icon, rakaat: item.rakaat, sortOrder: item.sort_order
      })),
      docs: docs.rows
    });
  });

  const guard = requireFeature('riyadhoh');

  router.get('/me/riyadhoh/logs', guard, async (request, response) => {
    const to = request.query.to ? validateLogDate(String(request.query.to), 'to') : todayWib();
    const from = request.query.from ? String(request.query.from) : addDays(to, -6);
    if (!DATE_PATTERN.test(from) || from > to) throw badRequest('Rentang tanggal tidak valid.', 'from');
    if (addDays(from, MAX_RANGE_DAYS) < to) throw badRequest(`Rentang maksimal ${MAX_RANGE_DAYS} hari.`, 'from');
    const result = await pool.query(
      `SELECT log_date, array_agg(item_id ORDER BY item_id) AS items FROM riyadhoh_logs
       WHERE user_id = $1 AND completed AND log_date BETWEEN $2 AND $3
       GROUP BY log_date ORDER BY log_date`,
      [request.user.id, from, to]
    );
    return sendData(response, Object.fromEntries(result.rows.map((row) => [row.log_date, row.items])), { from, to });
  });

  router.put('/me/riyadhoh/logs/:date/:itemId', guard, async (request, response) => {
    const date = validateLogDate(request.params.date);
    if (date < addDays(todayWib(), -MAX_BACKFILL_DAYS)) {
      throw badRequest(`Amalan hanya bisa dicatat sampai ${MAX_BACKFILL_DAYS} hari ke belakang.`, 'date');
    }
    if (typeof request.body?.completed !== 'boolean') throw badRequest('completed harus true/false.', 'completed');
    const item = await pool.query('SELECT 1 FROM riyadhoh_items WHERE id = $1', [request.params.itemId]);
    if (!item.rowCount) throw notFound('Amalan tidak ditemukan.');
    await pool.query(
      `INSERT INTO riyadhoh_logs (user_id, item_id, log_date, completed) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, log_date, item_id) DO UPDATE SET completed = EXCLUDED.completed, updated_at = CURRENT_TIMESTAMP`,
      [request.user.id, request.params.itemId, date, request.body.completed]
    );
    const streak = await streakFor(request.user.id);
    return sendData(response, { date, itemId: request.params.itemId, completed: request.body.completed, streak: streak.current });
  });

  router.post('/me/riyadhoh/logs/sync', guard, async (request, response) => {
    const entries = request.body?.entries;
    if (!Array.isArray(entries)) throw badRequest('entries wajib berupa array.', 'entries');
    if (entries.length > 2000) throw badRequest('Maksimal 2000 entri per sinkronisasi.', 'entries');
    const items = new Set((await pool.query('SELECT id FROM riyadhoh_items')).rows.map((row) => row.id));
    const today = todayWib();
    const valid = entries.filter((entry) =>
      entry && typeof entry.itemId === 'string' && items.has(entry.itemId) &&
      typeof entry.date === 'string' && DATE_PATTERN.test(entry.date) && entry.date <= today &&
      typeof entry.completed === 'boolean');
    await withTransaction(async (client) => {
      for (const entry of valid) {
        const updatedAt = entry.updatedAt && !Number.isNaN(Date.parse(entry.updatedAt)) ? entry.updatedAt : new Date().toISOString();
        await client.query(
          `INSERT INTO riyadhoh_logs (user_id, item_id, log_date, completed, updated_at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, log_date, item_id) DO UPDATE
           SET completed = EXCLUDED.completed, updated_at = EXCLUDED.updated_at
           WHERE riyadhoh_logs.updated_at < EXCLUDED.updated_at`,
          [request.user.id, entry.itemId, entry.date, entry.completed, updatedAt]
        );
      }
    });
    return sendData(response, { applied: valid.length, skipped: entries.length - valid.length });
  });

  router.get('/me/riyadhoh/summary', guard, async (request, response) => {
    const today = todayWib();
    const from = addDays(today, -6);
    const [counts, total, streak] = await Promise.all([
      pool.query(
        `SELECT l.log_date, count(*)::int AS completed FROM riyadhoh_logs l
         JOIN riyadhoh_items i ON i.id = l.item_id AND i.is_active
         WHERE l.user_id = $1 AND l.completed AND l.log_date BETWEEN $2 AND $3
         GROUP BY l.log_date`,
        [request.user.id, from, today]
      ),
      pool.query('SELECT count(*)::int AS total FROM riyadhoh_items WHERE is_active'),
      streakFor(request.user.id)
    ]);
    const byDate = Object.fromEntries(counts.rows.map((row) => [row.log_date, row.completed]));
    const totalItems = total.rows[0].total;
    const week = Array.from({ length: 7 }, (_, index) => {
      const date = addDays(from, index);
      return { date, completed: byDate[date] || 0, total: totalItems };
    });
    const todayCompleted = byDate[today] || 0;
    return sendData(response, {
      today: {
        date: today,
        completed: todayCompleted,
        total: totalItems,
        percent: totalItems ? Math.round((todayCompleted / totalItems) * 100) : 0
      },
      streak: { ...streak, rule: 'minimal 1 amalan per hari' },
      week
    });
  });

  return router;
}
