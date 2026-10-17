import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { loadUserById, requireAuth, serializeUser } from '../auth.js';
import { pool, withTransaction } from '../db.js';
import {
  DATE_PATTERN, badRequest, conflict, fileUrl, isValidPhone, normalizePhone, oneOf, pageMeta, paging,
  sendData, str, todayWib
} from '../http.js';
import { UPLOAD_PURPOSES, imageUpload, removeStoredFile, storeImage } from '../uploads.js';
import { computeStreak } from './riyadhoh.js';

const PROFILE_FIELDS = {
  name: { column: 'full_name', max: 150 },
  bio: { column: 'bio', max: 200 },
  city: { column: 'city', max: 120 },
  address: { column: 'address', max: 500 },
  occupation: { column: 'occupation', max: 150 }
};

// birthDate menerima YYYY-MM-DD atau DD/MM/YYYY (format input lama di app).
function parseBirthDate(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw badRequest('Tanggal lahir tidak valid.', 'birthDate');
  let iso = value.trim();
  const local = iso.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (local) iso = `${local[3]}-${local[2].padStart(2, '0')}-${local[1].padStart(2, '0')}`;
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  if (!DATE_PATTERN.test(iso) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== iso) {
    throw badRequest('Tanggal lahir harus berformat DD/MM/YYYY.', 'birthDate');
  }
  if (iso >= todayWib()) throw badRequest('Tanggal lahir harus di masa lalu.', 'birthDate');
  return iso;
}

export function meRoutes() {
  const router = Router();
  router.use('/me', requireAuth);

  router.get('/me', (request, response) => sendData(response, serializeUser(request, request.user)));

  router.patch('/me', async (request, response) => {
    const body = request.body || {};
    const updates = [];
    const values = [];
    const set = (column, value) => {
      values.push(value);
      updates.push(`${column} = $${values.length}`);
    };

    for (const [field, config] of Object.entries(PROFILE_FIELDS)) {
      if (!(field in body)) continue;
      const value = str(body, field, { max: config.max, label: field === 'name' ? 'Nama' : field });
      if (field === 'name' && !value) throw badRequest('Nama wajib diisi.', 'name');
      set(config.column, value ?? null);
    }
    if ('phone' in body) {
      const raw = str(body, 'phone', { max: 20, label: 'No. HP' });
      const phone = raw ? normalizePhone(raw) : null;
      if (phone && !isValidPhone(phone)) throw badRequest('Format No. HP tidak valid.', 'phone');
      set('phone', phone);
    }
    if ('gender' in body) {
      set('gender', body.gender ? oneOf(body, 'gender', ['laki-laki', 'perempuan'], { label: 'Jenis kelamin' }) : null);
    }
    if ('birthDate' in body) set('birth_date', parseBirthDate(body.birthDate));
    if ('nasuhaRegion' in body) {
      const kordaId = body.nasuhaRegion ? String(body.nasuhaRegion).trim() : null;
      if (kordaId) {
        const korda = await pool.query('SELECT 1 FROM kordas WHERE id = $1', [kordaId]);
        if (!korda.rowCount) throw badRequest('Korda tidak ditemukan.', 'nasuhaRegion');
      }
      set('korda_id', kordaId);
    }
    if (updates.length) {
      values.push(request.user.id);
      try {
        await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
      } catch (error) {
        if (error.code === '23505') throw conflict('No. HP sudah dipakai akun lain.', 'phone');
        throw error;
      }
    }
    const user = await loadUserById(request.user.id);
    return sendData(response, serializeUser(request, user));
  });

  router.post('/me/avatar', imageUpload.single('file'), async (request, response) => {
    const previous = request.user.photo_path;
    const stored = await withTransaction(async (client) => {
      const upload = await storeImage(client, request.file, 'avatar', request.user.id);
      await client.query('UPDATE users SET photo_path = $1 WHERE id = $2', [upload.storage_path, request.user.id]);
      return upload;
    });
    if (previous && previous !== stored.storage_path) await removeStoredFile(previous);
    return sendData(response, { avatar: fileUrl(request, stored.storage_path) });
  });

  router.delete('/me/avatar', async (request, response) => {
    const previous = request.user.photo_path;
    await pool.query('UPDATE users SET photo_path = NULL WHERE id = $1', [request.user.id]);
    await removeStoredFile(previous);
    return response.status(204).end();
  });

  router.get('/me/stats', async (request, response) => {
    const userId = request.user.id;
    const [riyadhoh, today, events, bookmarks, lapak, misc, dates] = await Promise.all([
      pool.query('SELECT count(*)::int AS total FROM riyadhoh_logs WHERE user_id = $1 AND completed', [userId]),
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM riyadhoh_logs WHERE user_id = $1 AND completed AND log_date = $2) AS completed,
           (SELECT count(*)::int FROM riyadhoh_items WHERE is_active) AS total`,
        [userId, todayWib()]
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE r.status <> 'cancelled')::int AS joined,
                count(*) FILTER (WHERE e.type = 'TSN' AND (r.attended OR r.status = 'confirmed'))::int AS tsn
         FROM event_registrations r JOIN events e ON e.id = r.event_id
         WHERE r.user_id = $1`,
        [userId]
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE type = 'ayah')::int AS ayah, count(*) FILTER (WHERE type = 'hadith')::int AS hadith
         FROM bookmarks WHERE user_id = $1`,
        [userId]
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE status = 'approved')::int AS approved,
                count(*) FILTER (WHERE status = 'pending')::int AS pending,
                count(*) FILTER (WHERE status = 'rejected')::int AS rejected
         FROM lapak_products WHERE seller_id = $1`,
        [userId]
      ),
      pool.query(
        `SELECT (SELECT count(*)::int FROM questions WHERE user_id = $1) AS questions,
                (SELECT count(*)::int FROM testimonials WHERE user_id = $1) AS testimonials`,
        [userId]
      ),
      pool.query(
        `SELECT DISTINCT log_date FROM riyadhoh_logs WHERE user_id = $1 AND completed ORDER BY log_date DESC LIMIT 400`,
        [userId]
      )
    ]);
    const streak = computeStreak(dates.rows.map((row) => row.log_date));
    return sendData(response, {
      riyadhoh: {
        currentStreak: streak.current,
        longestStreak: streak.longest,
        totalCompleted: riyadhoh.rows[0].total,
        todayCompleted: today.rows[0].completed,
        todayTotal: today.rows[0].total
      },
      tsnAttendance: events.rows[0].tsn,
      eventsJoined: events.rows[0].joined,
      bookmarks: bookmarks.rows[0],
      lapak: lapak.rows[0],
      questions: misc.rows[0].questions,
      testimonials: misc.rows[0].testimonials
    });
  });

  router.delete('/me', async (request, response) => {
    const current = await pool.query('SELECT password_hash FROM users WHERE id = $1', [request.user.id]);
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const passwordHash = current.rows[0].password_hash;
    if (passwordHash) {
      if (!(await bcrypt.compare(password, passwordHash))) throw badRequest('Password salah.', 'password');
    } else if (request.body?.confirmation !== 'HAPUS') {
      // Akun Google tanpa password: konfirmasi dengan mengetik HAPUS.
      throw badRequest('Ketik HAPUS untuk mengonfirmasi penghapusan akun.', 'confirmation');
    }
    if (request.user.role_codes.includes('super_admin')) {
      const others = await pool.query(
        `SELECT count(*)::int AS total FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         JOIN users u ON u.id = ur.user_id
         WHERE r.code = 'super_admin' AND u.status = 'active' AND ur.user_id <> $1`,
        [request.user.id]
      );
      if (!others.rows[0].total) throw badRequest('Super Admin terakhir tidak dapat menghapus akunnya.');
    }
    await pool.query('DELETE FROM users WHERE id = $1', [request.user.id]);
    await removeStoredFile(request.user.photo_path);
    return response.status(204).end();
  });

  // ---- Upload generik ----
  router.post('/uploads', requireAuth, imageUpload.single('file'), async (request, response) => {
    const purpose = typeof request.body?.purpose === 'string' ? request.body.purpose : '';
    if (!UPLOAD_PURPOSES.includes(purpose) || purpose === 'avatar') {
      throw badRequest('Tujuan upload tidak valid (product, testimonial, event, content).', 'purpose');
    }
    if (['event', 'content'].includes(purpose) && !request.user.role_codes.some((role) => ['admin', 'super_admin'].includes(role))) {
      throw badRequest('Upload untuk event/konten hanya untuk admin.', 'purpose');
    }
    const upload = await storeImage(pool, request.file, purpose, request.user.id);
    return sendData(response, {
      id: upload.id,
      url: fileUrl(request, upload.storage_path),
      path: upload.storage_path,
      purpose,
      mimeType: upload.mime_type,
      size: Number(upload.file_size)
    }, undefined, 201);
  });

  // ---- Preferensi ----
  router.get('/me/preferences', async (request, response) => {
    const result = await pool.query('SELECT data, updated_at FROM user_preferences WHERE user_id = $1', [request.user.id]);
    return sendData(response, { ...(result.rows[0]?.data || {}), updatedAt: result.rows[0]?.updated_at || null });
  });

  router.put('/me/preferences', async (request, response) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Format preferensi tidak valid.');
    const allowed = ['theme', 'colorScheme', 'quranFontSize', 'hadithFontSize', 'notificationSettings', 'prayerLocation'];
    const patch = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
    if (JSON.stringify(patch).length > 8000) throw badRequest('Preferensi terlalu besar.');
    const result = await pool.query(
      `INSERT INTO user_preferences (user_id, data) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET data = user_preferences.data || EXCLUDED.data, updated_at = CURRENT_TIMESTAMP
       RETURNING data, updated_at`,
      [request.user.id, patch]
    );
    return sendData(response, { ...result.rows[0].data, updatedAt: result.rows[0].updated_at });
  });

  // ---- Device push token ----
  router.post('/me/devices', async (request, response) => {
    const body = request.body || {};
    const token = str(body, 'expoPushToken', { required: true, max: 255, label: 'Push token' });
    const platform = oneOf(body, 'platform', ['android', 'ios', 'web']) || 'android';
    await pool.query(
      `INSERT INTO user_devices (expo_push_token, user_id, platform, device_name, app_version)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (expo_push_token) DO UPDATE
       SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, device_name = EXCLUDED.device_name,
           app_version = EXCLUDED.app_version, updated_at = CURRENT_TIMESTAMP`,
      [token, request.user.id, platform, str(body, 'deviceName', { max: 120 }) || null, str(body, 'appVersion', { max: 30 }) || null]
    );
    return response.status(204).end();
  });

  router.delete('/me/devices/:token', async (request, response) => {
    await pool.query('DELETE FROM user_devices WHERE expo_push_token = $1 AND user_id = $2', [request.params.token, request.user.id]);
    return response.status(204).end();
  });

  // ---- Notifikasi inbox ----
  router.get('/me/notifications', async (request, response) => {
    const page = paging(request.query);
    const unreadOnly = request.query.unread === 'true';
    const [rows, counts] = await Promise.all([
      pool.query(
        `SELECT id, type, title, body, icon, data, read_at, created_at FROM notifications
         WHERE user_id = $1 AND (NOT $2::boolean OR read_at IS NULL)
         ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [request.user.id, unreadOnly, page.perPage, page.offset]
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE NOT $2::boolean OR read_at IS NULL)::int AS total,
                count(*) FILTER (WHERE read_at IS NULL)::int AS unread
         FROM notifications WHERE user_id = $1`,
        [request.user.id, unreadOnly]
      )
    ]);
    return sendData(response, rows.rows.map((row) => ({
      id: row.id, type: row.type, title: row.title, body: row.body, icon: row.icon, data: row.data,
      read: Boolean(row.read_at), readAt: row.read_at, createdAt: row.created_at
    })), pageMeta(page, counts.rows[0].total, { unread: counts.rows[0].unread }));
  });

  router.post('/me/notifications/read-all', async (request, response) => {
    await pool.query('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND read_at IS NULL', [request.user.id]);
    return response.status(204).end();
  });

  router.post('/me/notifications/:id/read', async (request, response) => {
    await pool.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
       WHERE id::text = $1 AND user_id = $2`,
      [request.params.id, request.user.id]
    );
    return response.status(204).end();
  });

  return router;
}
