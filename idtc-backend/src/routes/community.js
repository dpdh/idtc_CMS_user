import { Router } from 'express';
import { OFFICIAL_ANSWER_ROLES, hasRole, isStaff, primaryRole, requireAuth, requireFeature } from '../auth.js';
import { pool } from '../db.js';
import {
  assertUuid, badRequest, bool, fileUrl, int, likePattern, notFound, pageMeta, paging, sendData, str,
  toStoragePath
} from '../http.js';
import { notifyStaff, notifyUsers } from '../notify.js';
import { assertUploads } from '../uploads.js';

// ---------------------------------------------------------------------------
// Testimoni
// ---------------------------------------------------------------------------
export const TESTIMONIAL_SELECT = `
  SELECT t.*, u.full_name AS author_name, u.photo_path AS author_photo, k.label AS korda_name
  FROM testimonials t
  LEFT JOIN users u ON u.id = t.user_id
  LEFT JOIN kordas k ON k.id = t.korda_id`;

export function serializeTestimonial(request, row) {
  return {
    id: row.id,
    user: row.user_id ? { id: row.user_id, name: row.author_name, avatar: fileUrl(request, row.author_photo) } : null,
    userId: row.user_id,
    name: row.display_name,
    avatar: fileUrl(request, row.author_photo),
    korda: row.korda_id,
    kordaLabel: row.korda_name || row.korda_label,
    program: row.program,
    rating: row.rating,
    text: row.text,
    photo: fileUrl(request, row.photo_path),
    status: row.status,
    rejectionReason: row.rejection_reason,
    date: row.testimony_date,
    createdAt: row.created_at
  };
}

// ---------------------------------------------------------------------------
// Tanya Praktisi
// ---------------------------------------------------------------------------
const QUESTION_SELECT = `
  SELECT q.*, u.full_name AS author_name, u.photo_path AS author_photo,
    (SELECT count(*)::int FROM answers a WHERE a.question_id = q.id) AS answers_count,
    EXISTS (SELECT 1 FROM answers a WHERE a.question_id = q.id AND a.is_official) AS has_official
  FROM questions q LEFT JOIN users u ON u.id = q.user_id`;

function serializeQuestion(request, row, answers) {
  const anonymous = row.is_anonymous;
  const question = {
    id: row.id,
    user: row.user_id && !anonymous
      ? { id: row.user_id, name: row.author_name, avatar: fileUrl(request, row.author_photo) }
      : { id: null, name: 'Hamba Allah', avatar: null },
    userId: anonymous ? null : row.user_id,
    userName: anonymous ? 'Hamba Allah' : (row.author_name || 'Pengguna'),
    userAvatar: anonymous ? null : fileUrl(request, row.author_photo),
    isMine: Boolean(request.user && row.user_id === request.user.id),
    category: row.category,
    title: row.title,
    body: row.body,
    isAnonymous: anonymous,
    status: row.status,
    answersCount: row.answers_count,
    hasOfficialAnswer: row.has_official,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (answers) question.answers = answers;
  return question;
}

async function loadAnswers(request, questionId) {
  const result = await pool.query(
    `SELECT a.*, u.full_name AS author_name, u.photo_path AS author_photo,
       (SELECT array_agg(r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = a.user_id) AS author_roles
     FROM answers a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.question_id = $1 ORDER BY a.is_official DESC, a.created_at`,
    [questionId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    questionId: row.question_id,
    user: row.user_id ? {
      id: row.user_id, name: row.author_name, avatar: fileUrl(request, row.author_photo), role: primaryRole(row.author_roles || [])
    } : null,
    userId: row.user_id,
    userName: row.author_name || 'Pengguna',
    userAvatar: fileUrl(request, row.author_photo),
    isOfficial: row.is_official,
    body: row.body,
    createdAt: row.created_at
  }));
}

async function validCategory(kind, value, field) {
  const result = await pool.query(
    'SELECT 1 FROM reference_items WHERE kind = $1 AND code = $2 AND is_active',
    [kind, value]
  );
  if (!result.rowCount) throw badRequest('Kategori tidak valid.', field);
  return value;
}

export function communityRoutes() {
  const router = Router();

  router.get('/testimonials', async (request, response) => {
    const page = paging(request.query);
    const filters = ["t.status = 'approved'"];
    const values = [];
    if (request.query.korda) {
      values.push(String(request.query.korda));
      filters.push(`t.korda_id = $${values.length}`);
    }
    if (request.query.program) {
      values.push(String(request.query.program));
      filters.push(`t.program = $${values.length}`);
    }
    const where = filters.join(' AND ');
    const [rows, count, kordaCounts] = await Promise.all([
      pool.query(`${TESTIMONIAL_SELECT} WHERE ${where} ORDER BY t.testimony_date DESC, t.created_at DESC
                  LIMIT ${page.perPage} OFFSET ${page.offset}`, values),
      pool.query(`SELECT count(*)::int AS total FROM testimonials t WHERE ${where}`, values),
      pool.query(`SELECT korda_id, count(*)::int AS total FROM testimonials
                  WHERE status = 'approved' AND korda_id IS NOT NULL GROUP BY korda_id`)
    ]);
    return sendData(response, rows.rows.map((row) => serializeTestimonial(request, row)), pageMeta(page, count.rows[0].total, {
      kordaCounts: Object.fromEntries(kordaCounts.rows.map((row) => [row.korda_id, row.total]))
    }));
  });

  router.post('/testimonials', requireAuth, async (request, response) => {
    const body = request.body || {};
    const program = await validCategory('testimonial_program', str(body, 'program', { required: true, label: 'Program' }), 'program');
    const rating = int(body, 'rating', { required: true, min: 1, max: 5, label: 'Rating' });
    const text = str(body, 'text', { required: true, min: 20, max: 2000, label: 'Testimoni' });
    let kordaId = str(body, 'korda', { max: 60 }) || request.user.korda_id || null;
    if (kordaId) {
      const korda = await pool.query('SELECT id FROM kordas WHERE id = $1', [kordaId]);
      if (!korda.rowCount) throw badRequest('Korda tidak ditemukan.', 'korda');
    }
    let photoPath = null;
    if (body.photo) {
      photoPath = toStoragePath(body.photo);
      if (!photoPath) throw badRequest('Foto tidak valid.', 'photo');
      await assertUploads(pool, [photoPath], request.user.id, { field: 'photo' });
    }
    const status = isStaff(request.user) ? 'approved' : 'pending';
    const inserted = await pool.query(
      `INSERT INTO testimonials (user_id, display_name, korda_id, program, rating, text, photo_path, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [request.user.id, request.user.full_name, kordaId, program, rating, text, photoPath, status]
    );
    if (status === 'pending') {
      await notifyStaff({ type: 'info', title: 'Testimoni baru menunggu review', body: text.slice(0, 120), icon: 'chatbubbles' });
    }
    const result = await pool.query(`${TESTIMONIAL_SELECT} WHERE t.id = $1`, [inserted.rows[0].id]);
    return sendData(response, serializeTestimonial(request, result.rows[0]), undefined, 201);
  });

  router.get('/me/testimonials', requireAuth, async (request, response) => {
    const result = await pool.query(`${TESTIMONIAL_SELECT} WHERE t.user_id = $1 ORDER BY t.created_at DESC`, [request.user.id]);
    return sendData(response, result.rows.map((row) => serializeTestimonial(request, row)));
  });

  router.delete('/testimonials/:id', requireAuth, async (request, response) => {
    const id = assertUuid(request.params.id, 'Testimoni tidak ditemukan.');
    const result = await pool.query('DELETE FROM testimonials WHERE id = $1 AND user_id = $2', [id, request.user.id]);
    if (!result.rowCount) throw notFound('Testimoni tidak ditemukan.');
    return response.status(204).end();
  });

  // ---- Questions ----
  router.get('/questions', async (request, response) => {
    const page = paging(request.query);
    const filters = ['TRUE'];
    const values = [];
    if (request.query.category && request.query.category !== 'Semua') {
      values.push(String(request.query.category));
      filters.push(`q.category = $${values.length}`);
    }
    if (request.query.mine === 'true') {
      if (!request.user) throw badRequest('Login untuk melihat pertanyaan Anda.');
      values.push(request.user.id);
      filters.push(`q.user_id = $${values.length}`);
    }
    if (request.query.q) {
      values.push(likePattern(String(request.query.q)));
      filters.push(`(q.title ILIKE $${values.length} OR q.body ILIKE $${values.length})`);
    }
    const where = filters.join(' AND ');
    const [rows, count] = await Promise.all([
      pool.query(`${QUESTION_SELECT} WHERE ${where} ORDER BY q.created_at DESC LIMIT ${page.perPage} OFFSET ${page.offset}`, values),
      pool.query(`SELECT count(*)::int AS total FROM questions q WHERE ${where}`, values)
    ]);
    return sendData(response, rows.rows.map((row) => serializeQuestion(request, row)), pageMeta(page, count.rows[0].total));
  });

  router.get('/questions/:id', async (request, response) => {
    const id = assertUuid(request.params.id, 'Pertanyaan tidak ditemukan.');
    const result = await pool.query(`${QUESTION_SELECT} WHERE q.id = $1`, [id]);
    if (!result.rowCount) throw notFound('Pertanyaan tidak ditemukan.');
    return sendData(response, serializeQuestion(request, result.rows[0], await loadAnswers(request, id)));
  });

  router.post('/questions', requireFeature('tanya'), async (request, response) => {
    const body = request.body || {};
    const category = await validCategory('question_category', str(body, 'category', { required: true, label: 'Kategori' }), 'category');
    const title = str(body, 'title', { required: true, max: 150, label: 'Judul' });
    const text = str(body, 'body', { required: true, max: 2000, label: 'Pertanyaan' });
    const isAnonymous = bool(body, 'isAnonymous') || false;
    const inserted = await pool.query(
      `INSERT INTO questions (user_id, category, title, body, is_anonymous) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [request.user.id, category, title, text, isAnonymous]
    );
    const result = await pool.query(`${QUESTION_SELECT} WHERE q.id = $1`, [inserted.rows[0].id]);
    return sendData(response, serializeQuestion(request, result.rows[0], []), undefined, 201);
  });

  router.patch('/questions/:id', requireAuth, async (request, response) => {
    const id = assertUuid(request.params.id, 'Pertanyaan tidak ditemukan.');
    const current = await pool.query(`${QUESTION_SELECT} WHERE q.id = $1`, [id]);
    const row = current.rows[0];
    if (!row || row.user_id !== request.user.id) throw notFound('Pertanyaan tidak ditemukan.');
    if (row.has_official) throw badRequest('Pertanyaan yang sudah dijawab praktisi tidak dapat diubah.');
    const body = request.body || {};
    const category = body.category !== undefined
      ? await validCategory('question_category', str(body, 'category', { required: true }), 'category') : row.category;
    const title = body.title !== undefined ? str(body, 'title', { required: true, max: 150, label: 'Judul' }) : row.title;
    const text = body.body !== undefined ? str(body, 'body', { required: true, max: 2000, label: 'Pertanyaan' }) : row.body;
    await pool.query('UPDATE questions SET category = $2, title = $3, body = $4 WHERE id = $1', [id, category, title, text]);
    const result = await pool.query(`${QUESTION_SELECT} WHERE q.id = $1`, [id]);
    return sendData(response, serializeQuestion(request, result.rows[0], await loadAnswers(request, id)));
  });

  router.delete('/questions/:id', requireAuth, async (request, response) => {
    const id = assertUuid(request.params.id, 'Pertanyaan tidak ditemukan.');
    const current = await pool.query(`${QUESTION_SELECT} WHERE q.id = $1`, [id]);
    const row = current.rows[0];
    if (!row || row.user_id !== request.user.id) throw notFound('Pertanyaan tidak ditemukan.');
    if (row.has_official) throw badRequest('Pertanyaan yang sudah dijawab praktisi tidak dapat dihapus.');
    await pool.query('DELETE FROM questions WHERE id = $1', [id]);
    return response.status(204).end();
  });

  router.post('/questions/:id/answers', requireFeature('tanya', { bypassRoles: OFFICIAL_ANSWER_ROLES }), async (request, response) => {
    const id = assertUuid(request.params.id, 'Pertanyaan tidak ditemukan.');
    const question = await pool.query('SELECT id, user_id, title, status FROM questions WHERE id = $1', [id]);
    if (!question.rowCount) throw notFound('Pertanyaan tidak ditemukan.');
    if (question.rows[0].status === 'closed') throw badRequest('Pertanyaan ini sudah ditutup.');
    const body = str(request.body || {}, 'body', { required: true, max: 4000, label: 'Jawaban' });
    const isOfficial = hasRole(request.user, ...OFFICIAL_ANSWER_ROLES);
    const inserted = await pool.query(
      'INSERT INTO answers (question_id, user_id, body, is_official) VALUES ($1, $2, $3, $4) RETURNING id',
      [id, request.user.id, body, isOfficial]
    );
    if (question.rows[0].user_id && question.rows[0].user_id !== request.user.id) {
      await notifyUsers([question.rows[0].user_id], {
        type: 'tanya',
        title: isOfficial ? 'Pertanyaan Anda dijawab praktisi' : 'Ada jawaban baru',
        body: question.rows[0].title,
        icon: 'chatbubble-ellipses',
        data: { route: `/tanya/${id}` }
      });
    }
    const answers = await loadAnswers(request, id);
    return sendData(response, answers.find((answer) => answer.id === inserted.rows[0].id), undefined, 201);
  });

  router.delete('/answers/:id', requireAuth, async (request, response) => {
    const id = assertUuid(request.params.id, 'Jawaban tidak ditemukan.');
    const result = await pool.query(
      'DELETE FROM answers WHERE id = $1 AND (user_id = $2 OR $3::boolean)',
      [id, request.user.id, isStaff(request.user)]
    );
    if (!result.rowCount) throw notFound('Jawaban tidak ditemukan.');
    return response.status(204).end();
  });

  return router;
}

