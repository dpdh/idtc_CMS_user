// Fitur konten tambahan app: Kisah Nabi & Rasul, Kuis NAS, Buku digital, dan Grup Ibadah.
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { pool } from '../db.js';
import { notFound, sendData } from '../http.js';
import { RESOURCES, serializeResource, validateId } from '../resources.js';

const STORY_CATEGORIES = RESOURCES.stories.fields.category.enum;

async function loadWorshipGroups(userId, groupId = null) {
  const values = [userId];
  let where = 'g.is_active';
  if (groupId) {
    values.push(groupId);
    where += ' AND g.id = $2';
  }
  const result = await pool.query(
    `SELECT g.*,
       (SELECT count(*)::int FROM worship_group_members m WHERE m.group_id = g.id) AS member_count,
       EXISTS (SELECT 1 FROM worship_group_members m WHERE m.group_id = g.id AND m.user_id = $1) AS joined
     FROM worship_groups g WHERE ${where} ORDER BY g.sort_order, g.id`,
    values
  );
  return result.rows;
}

function serializeGroup(request, row) {
  return { ...serializeResource(request, RESOURCES['worship-groups'], row), memberCount: row.member_count, joined: row.joined };
}

export function featureRoutes() {
  const router = Router();

  // Daftar kisah tanpa isi lengkap (hemat data); isi diambil per kisah.
  router.get('/stories', async (request, response) => {
    const category = STORY_CATEGORIES.includes(request.query.category) ? request.query.category : null;
    const result = await pool.query(
      `SELECT id, category, title, person, summary, sort_order, is_active FROM stories
       WHERE is_active AND ($1::varchar IS NULL OR category = $1) ORDER BY category, sort_order, id`,
      [category]
    );
    return sendData(response, result.rows.map((row) => ({
      id: row.id, category: row.category, title: row.title, person: row.person, summary: row.summary, sortOrder: row.sort_order
    })));
  });

  router.get('/stories/:id', async (request, response) => {
    validateId(RESOURCES.stories, request.params.id);
    const result = await pool.query('SELECT * FROM stories WHERE id = $1 AND is_active', [request.params.id]);
    if (!result.rows[0]) throw notFound('Kisah tidak ditemukan.');
    return sendData(response, serializeResource(request, RESOURCES.stories, result.rows[0]));
  });

  router.get('/quiz-questions', async (request, response) => {
    const category = typeof request.query.category === 'string' && request.query.category ? request.query.category : null;
    const result = await pool.query(
      `SELECT * FROM quiz_questions WHERE is_active AND ($1::varchar IS NULL OR category = $1)
       ORDER BY sort_order, id`,
      [category]
    );
    return sendData(response, result.rows.map((row) => serializeResource(request, RESOURCES['quiz-questions'], row)));
  });

  router.get('/books', async (request, response) => {
    const result = await pool.query('SELECT * FROM books WHERE is_active ORDER BY sort_order, id');
    return sendData(response, result.rows.map((row) => serializeResource(request, RESOURCES.books, row)));
  });

  router.get('/worship-groups', async (request, response) => {
    const rows = await loadWorshipGroups(request.user?.id ?? null);
    return sendData(response, rows.map((row) => serializeGroup(request, row)));
  });

  const findGroup = async (request) => {
    validateId(RESOURCES['worship-groups'], request.params.id);
    const [row] = await loadWorshipGroups(request.user.id, request.params.id);
    if (!row) throw notFound('Grup ibadah tidak ditemukan.');
    return row;
  };

  router.post('/worship-groups/:id/join', requireAuth, async (request, response) => {
    const group = await findGroup(request);
    await pool.query(
      'INSERT INTO worship_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [group.id, request.user.id]
    );
    const [updated] = await loadWorshipGroups(request.user.id, group.id);
    return sendData(response, serializeGroup(request, updated));
  });

  router.delete('/worship-groups/:id/join', requireAuth, async (request, response) => {
    const group = await findGroup(request);
    await pool.query('DELETE FROM worship_group_members WHERE group_id = $1 AND user_id = $2', [group.id, request.user.id]);
    const [updated] = await loadWorshipGroups(request.user.id, group.id);
    return sendData(response, serializeGroup(request, updated));
  });

  return router;
}
