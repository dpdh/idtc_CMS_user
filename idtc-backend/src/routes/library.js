import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { pool, withTransaction } from '../db.js';
import { badRequest, int, oneOf, sendData, str } from '../http.js';

// ref ayat: "surahId:ayah" (1-114); ref hadis: "slug:nomor".
const REF_PATTERNS = {
  ayah: /^(\d{1,3}):(\d{1,3})$/,
  hadith: /^[a-z][a-z-]{1,30}:\d{1,5}$/
};

function validateRef(type, ref) {
  if (typeof ref !== 'string' || !REF_PATTERNS[type].test(ref)) {
    throw badRequest(type === 'ayah' ? 'ref ayat harus berformat surah:ayat, mis. 2:255.' : 'ref hadis harus berformat kitab:nomor, mis. bukhari:1.', 'ref');
  }
  if (type === 'ayah') {
    const surah = Number(ref.split(':')[0]);
    if (surah < 1 || surah > 114) throw badRequest('Nomor surah harus 1-114.', 'ref');
  }
  return ref;
}

function serializeBookmark(row) {
  return { id: row.id, type: row.type, ref: row.ref, label: row.label, note: row.note, createdAt: row.created_at };
}

export function libraryRoutes() {
  const router = Router();
  router.use('/me/bookmarks', requireAuth);
  router.use('/me/quran', requireAuth);

  router.get('/me/bookmarks', async (request, response) => {
    const type = request.query.type;
    if (type && !['ayah', 'hadith'].includes(type)) throw badRequest('type harus ayah atau hadith.', 'type');
    const result = await pool.query(
      `SELECT id, type, ref, label, note, created_at FROM bookmarks
       WHERE user_id = $1 AND ($2::varchar IS NULL OR type = $2) ORDER BY created_at DESC`,
      [request.user.id, type || null]
    );
    return sendData(response, result.rows.map(serializeBookmark));
  });

  router.post('/me/bookmarks', async (request, response) => {
    const body = request.body || {};
    const type = oneOf(body, 'type', ['ayah', 'hadith'], { required: true });
    const ref = validateRef(type, body.ref);
    const label = str(body, 'label', { max: 150 }) || null;
    const note = str(body, 'note', { max: 500 }) || null;
    const result = await pool.query(
      `INSERT INTO bookmarks (user_id, type, ref, label, note) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, type, ref) DO UPDATE SET label = COALESCE(EXCLUDED.label, bookmarks.label)
       RETURNING id, type, ref, label, note, created_at, (xmax = 0) AS inserted`,
      [request.user.id, type, ref, label, note]
    );
    return sendData(response, serializeBookmark(result.rows[0]), undefined, result.rows[0].inserted ? 201 : 200);
  });

  router.delete('/me/bookmarks/:type/:ref', async (request, response) => {
    const { type, ref } = request.params;
    if (!['ayah', 'hadith'].includes(type)) throw badRequest('type harus ayah atau hadith.', 'type');
    await pool.query('DELETE FROM bookmarks WHERE user_id = $1 AND type = $2 AND ref = $3', [request.user.id, type, ref]);
    return response.status(204).end();
  });

  router.post('/me/bookmarks/sync', async (request, response) => {
    const body = request.body || {};
    const ayahs = Array.isArray(body.ayahs) ? body.ayahs : [];
    const hadiths = Array.isArray(body.hadiths) ? body.hadiths : [];
    if (ayahs.length + hadiths.length > 2000) throw badRequest('Maksimal 2000 bookmark per sinkronisasi.');
    const entries = [
      ...ayahs.filter((ref) => typeof ref === 'string' && REF_PATTERNS.ayah.test(ref)).map((ref) => ['ayah', ref]),
      ...hadiths.filter((ref) => typeof ref === 'string' && REF_PATTERNS.hadith.test(ref)).map((ref) => ['hadith', ref])
    ];
    await withTransaction(async (client) => {
      for (const [type, ref] of entries) {
        await client.query(
          `INSERT INTO bookmarks (user_id, type, ref) VALUES ($1, $2, $3) ON CONFLICT (user_id, type, ref) DO NOTHING`,
          [request.user.id, type, ref]
        );
      }
    });
    const result = await pool.query(
      'SELECT id, type, ref, label, note, created_at FROM bookmarks WHERE user_id = $1 ORDER BY created_at DESC',
      [request.user.id]
    );
    return sendData(response, result.rows.map(serializeBookmark), {
      applied: entries.length,
      skipped: ayahs.length + hadiths.length - entries.length
    });
  });

  async function progress(userId) {
    const result = await pool.query(
      'SELECT surah_id, ayah, updated_at FROM quran_progress WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId]
    );
    const latest = result.rows[0];
    return {
      lastRead: latest ? { surahId: latest.surah_id, ayah: latest.ayah, updatedAt: latest.updated_at } : null,
      perSurah: Object.fromEntries(result.rows.map((row) => [String(row.surah_id), row.ayah]))
    };
  }

  router.get('/me/quran/progress', async (request, response) => sendData(response, await progress(request.user.id)));

  router.put('/me/quran/progress', async (request, response) => {
    const body = request.body || {};
    const surahId = int(body, 'surahId', { required: true, min: 1, max: 114, label: 'Surah' });
    const ayah = int(body, 'ayah', { required: true, min: 1, max: 286, label: 'Ayat' });
    await pool.query(
      `INSERT INTO quran_progress (user_id, surah_id, ayah) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, surah_id) DO UPDATE SET ayah = EXCLUDED.ayah, updated_at = CURRENT_TIMESTAMP`,
      [request.user.id, surahId, ayah]
    );
    return sendData(response, await progress(request.user.id));
  });

  // Migrasi lastReadAyahs lokal: { perSurah: { "2": 255 } }
  router.post('/me/quran/progress/sync', async (request, response) => {
    const perSurah = request.body?.perSurah;
    if (!perSurah || typeof perSurah !== 'object') throw badRequest('perSurah wajib berupa object.', 'perSurah');
    await withTransaction(async (client) => {
      for (const [surah, ayah] of Object.entries(perSurah).slice(0, 114)) {
        const surahId = Number(surah);
        const ayahNumber = Number(ayah);
        if (!Number.isInteger(surahId) || surahId < 1 || surahId > 114 || !Number.isInteger(ayahNumber) || ayahNumber < 1) continue;
        await client.query(
          // Progres hasil migrasi diberi waktu lama agar tidak menggeser "terakhir dibaca".
          `INSERT INTO quran_progress (user_id, surah_id, ayah, updated_at) VALUES ($1, $2, $3, 'epoch')
           ON CONFLICT (user_id, surah_id) DO NOTHING`,
          [request.user.id, surahId, ayahNumber]
        );
      }
    });
    return sendData(response, await progress(request.user.id));
  });

  return router;
}
