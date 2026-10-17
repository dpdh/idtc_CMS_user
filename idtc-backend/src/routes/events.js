import { Router } from 'express';
import { requireAuth, requireFeature } from '../auth.js';
import { pool, withTransaction } from '../db.js';
import {
  EMAIL_PATTERN, HttpError, assertUuid, badRequest, conflict, fileUrl, forbidden, isValidPhone, likePattern,
  normalizePhone, notFound, pageMeta, paging, sendData, str, todayWib
} from '../http.js';

export const EVENT_SELECT = `
  SELECT e.*,
    (SELECT count(*)::int FROM event_registrations r WHERE r.event_id = e.id AND r.status <> 'cancelled') AS registered_count`;

export function serializeEvent(request, row, myRegistration) {
  const registered = row.registered_count ?? 0;
  const event = {
    id: row.id,
    title: row.title,
    type: row.type,
    date: row.event_date,
    time: typeof row.event_time === 'string' ? row.event_time.slice(0, 5) : row.event_time,
    location: row.location,
    description: row.description,
    image: fileUrl(request, row.image_path),
    quota: row.quota,
    registered,
    remaining: Math.max(0, row.quota - registered),
    isFull: registered >= row.quota,
    status: row.status,
    contactWhatsapp: row.contact_whatsapp,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (myRegistration !== undefined) event.myRegistration = myRegistration;
  return event;
}

export function serializeRegistration(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    event: row.event_title ? {
      id: row.event_id, title: row.event_title, type: row.event_type, date: row.event_date,
      time: row.event_time?.slice(0, 5), location: row.event_location, status: row.event_status
    } : undefined,
    userId: row.user_id,
    userName: row.name,
    userEmail: row.email,
    userPhone: row.phone,
    userCity: row.city,
    korda: row.korda_id,
    notes: row.notes,
    status: row.status,
    attended: row.attended,
    createdAt: row.created_at
  };
}

export const REGISTRATION_SELECT = `
  SELECT r.*, e.title AS event_title, e.type AS event_type, e.event_date, e.event_time::text AS event_time,
         e.location AS event_location, e.status AS event_status, k.label AS korda_label
  FROM event_registrations r JOIN events e ON e.id = r.event_id
  LEFT JOIN kordas k ON k.id = r.korda_id`;

async function myRegistrations(userId, eventIds) {
  if (!userId || !eventIds.length) return new Map();
  const result = await pool.query(
    `SELECT id, event_id, status FROM event_registrations
     WHERE user_id = $1 AND event_id = ANY($2::uuid[]) AND status <> 'cancelled'`,
    [userId, eventIds]
  );
  return new Map(result.rows.map((row) => [row.event_id, { id: row.id, status: row.status }]));
}

export function eventRoutes() {
  const router = Router();

  router.get('/events', async (request, response) => {
    const page = paging(request.query);
    const filters = ["e.status = 'published'"];
    const values = [];
    const add = (sql, value) => {
      values.push(value);
      filters.push(sql.replace('?', `$${values.length}`));
    };
    if (request.query.type) add('e.type = ?', String(request.query.type));
    const from = request.query.from === undefined ? todayWib() : String(request.query.from);
    if (from) add('e.event_date >= ?', from);
    if (request.query.to) add('e.event_date <= ?', String(request.query.to));
    if (request.query.q) {
      values.push(likePattern(String(request.query.q)));
      const index = values.length;
      filters.push(`(e.title ILIKE $${index} OR e.description ILIKE $${index} OR e.location ILIKE $${index})`);
    }
    const order = request.query.sort === '-date' ? 'e.event_date DESC, e.event_time DESC' : 'e.event_date, e.event_time';
    const where = filters.join(' AND ');
    const [rows, count] = await Promise.all([
      pool.query(`${EVENT_SELECT} FROM events e WHERE ${where} ORDER BY ${order} LIMIT ${page.perPage} OFFSET ${page.offset}`, values),
      pool.query(`SELECT count(*)::int AS total FROM events e WHERE ${where}`, values)
    ]);
    const mine = await myRegistrations(request.user?.id, rows.rows.map((row) => row.id));
    return sendData(
      response,
      rows.rows.map((row) => serializeEvent(request, row, request.user ? mine.get(row.id) || null : undefined)),
      pageMeta(page, count.rows[0].total)
    );
  });

  router.get('/events/:id', async (request, response) => {
    const id = assertUuid(request.params.id, 'Event tidak ditemukan.');
    const result = await pool.query(`${EVENT_SELECT} FROM events e WHERE e.id = $1`, [id]);
    const row = result.rows[0];
    const isStaff = request.user?.role_codes?.some((role) => ['admin', 'super_admin'].includes(role));
    const mine = await myRegistrations(request.user?.id, row ? [row.id] : []);
    if (!row || (row.status === 'draft' && !isStaff) || (row.status === 'cancelled' && !isStaff && !mine.has(row.id))) {
      throw notFound('Event tidak ditemukan.');
    }
    return sendData(response, serializeEvent(request, row, request.user ? mine.get(row.id) || null : undefined));
  });

  router.post('/events/:id/registrations', requireFeature('event'), async (request, response) => {
    const eventId = assertUuid(request.params.id, 'Event tidak ditemukan.');
    const body = request.body || {};
    const name = str(body, 'name', { required: true, max: 150, label: 'Nama' });
    const email = str(body, 'email', { required: true, max: 254, label: 'Email' }).toLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw badRequest('Format email tidak valid.', 'email');
    const phone = normalizePhone(str(body, 'phone', { required: true, max: 20, label: 'No. HP' }));
    if (!isValidPhone(phone)) throw badRequest('Format No. HP tidak valid.', 'phone');
    const city = str(body, 'city', { max: 120 }) || null;
    const notes = str(body, 'notes', { max: 500 }) || null;
    const korda = str(body, 'korda', { max: 60 }) || null;

    const registration = await withTransaction(async (client) => {
      const eventResult = await client.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [eventId]);
      const event = eventResult.rows[0];
      if (!event || event.status === 'draft') throw notFound('Event tidak ditemukan.');
      if (event.status !== 'published' || event.event_date < todayWib()) {
        throw badRequest('Pendaftaran event ini sudah ditutup.');
      }
      let kordaId = null;
      if (korda) {
        const kordaResult = await client.query('SELECT id FROM kordas WHERE id = $1 OR label = $1 LIMIT 1', [korda]);
        if (!kordaResult.rowCount) throw badRequest('Korda tidak ditemukan.', 'korda');
        kordaId = kordaResult.rows[0].id;
      }
      const existing = await client.query(
        `SELECT 1 FROM event_registrations WHERE event_id = $1 AND user_id = $2 AND status <> 'cancelled'`,
        [eventId, request.user.id]
      );
      if (existing.rowCount) throw conflict('Anda sudah terdaftar di event ini.');
      const count = await client.query(
        `SELECT count(*)::int AS total FROM event_registrations WHERE event_id = $1 AND status <> 'cancelled'`,
        [eventId]
      );
      if (count.rows[0].total >= event.quota) throw badRequest('Kuota sudah penuh.');
      const inserted = await client.query(
        `INSERT INTO event_registrations (event_id, user_id, name, email, phone, city, korda_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [eventId, request.user.id, name, email, phone, city, kordaId, notes]
      );
      return inserted.rows[0].id;
    });
    const result = await pool.query(`${REGISTRATION_SELECT} WHERE r.id = $1`, [registration]);
    return sendData(response, serializeRegistration(result.rows[0]), undefined, 201);
  });

  router.get('/me/event-registrations', requireAuth, async (request, response) => {
    const statuses = typeof request.query.status === 'string' && request.query.status
      ? request.query.status.split(',') : ['registered', 'confirmed', 'cancelled'];
    const upcoming = request.query.upcoming === 'true';
    const result = await pool.query(
      `${REGISTRATION_SELECT}
       WHERE r.user_id = $1 AND r.status = ANY($2::varchar[]) AND (NOT $3::boolean OR e.event_date >= $4)
       ORDER BY e.event_date DESC, r.created_at DESC`,
      [request.user.id, statuses, upcoming, todayWib()]
    );
    return sendData(response, result.rows.map(serializeRegistration));
  });

  router.post('/event-registrations/:id/cancel', requireAuth, async (request, response) => {
    const id = assertUuid(request.params.id, 'Pendaftaran tidak ditemukan.');
    const current = await pool.query(`${REGISTRATION_SELECT} WHERE r.id = $1`, [id]);
    const row = current.rows[0];
    if (!row || row.user_id !== request.user.id) throw notFound('Pendaftaran tidak ditemukan.');
    if (row.status === 'cancelled') throw new HttpError(409, 'Pendaftaran sudah dibatalkan.');
    if (row.event_date < todayWib()) throw forbidden('Event sudah lewat, pendaftaran tidak dapat dibatalkan.');
    await pool.query(`UPDATE event_registrations SET status = 'cancelled' WHERE id = $1`, [id]);
    const result = await pool.query(`${REGISTRATION_SELECT} WHERE r.id = $1`, [id]);
    return sendData(response, serializeRegistration(result.rows[0]));
  });

  return router;
}
