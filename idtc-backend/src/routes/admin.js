import { randomBytes } from 'node:crypto';
import { readdir, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import {
  ROLE_CODES, STAFF_ROLES, hasRole, loadUserById, requireAdmin, requireSuperAdmin, revokeUserSessions, serializeUser,
  attachFeatures
} from '../auth.js';
import { audit, pool, withTransaction } from '../db.js';
import {
  DATE_PATTERN, EMAIL_PATTERN, TIME_PATTERN, assertUuid, badRequest, bool, conflict, csv, forbidden, int,
  isValidPhone, likePattern, normalizePhone, notFound, oneOf, pageMeta, paging, sendData, str, toStoragePath, todayWib
} from '../http.js';
import { notifyUsers } from '../notify.js';
import { RESOURCES, parseResourceBody, serializeResource, validateId } from '../resources.js';
import { serializeTestimonial, TESTIMONIAL_SELECT } from './community.js';
import { DEFAULT_SITE_CONTENT, loadMembershipPlans, loadSiteContent } from './content.js';
import { EVENT_SELECT, REGISTRATION_SELECT, serializeEvent, serializeRegistration } from './events.js';
import { PRODUCT_SELECT, parseProduct, serializeProduct } from './lapak.js';
import { UPLOAD_PURPOSES, assertUploads, uploadRoot } from '../uploads.js';
import { metricsSnapshot } from '../monitor.js';

const ADMIN_ASSIGNABLE_ROLES = ['calon_sahabat', 'sahabat', 'praktisi'];

const USER_LIST_SELECT = `
  SELECT u.*, COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), ARRAY[]::varchar[]) AS role_codes,
         EXISTS (SELECT 1 FROM oauth_identities oi WHERE oi.user_id = u.id) AS has_google
  FROM users u
  LEFT JOIN user_roles ur ON ur.user_id = u.id
  LEFT JOIN roles r ON r.id = ur.role_id`;

async function targetUser(id) {
  const user = await loadUserById(assertUuid(id, 'User tidak ditemukan.'));
  if (!user) throw notFound('User tidak ditemukan.');
  return user;
}

// Admin hanya boleh mengelola user non-staff; Super Admin boleh semua kecuali dirinya sendiri.
function assertCanManage(actor, target) {
  if (actor.id === target.id) throw forbidden('Anda tidak dapat mengubah akun Anda sendiri dari sini.');
  const targetIsStaff = target.role_codes.some((role) => STAFF_ROLES.includes(role));
  if (targetIsStaff && !hasRole(actor, 'super_admin')) throw forbidden('Hanya Super Admin yang dapat mengubah akun admin.');
}

async function ensureAnotherSuperAdmin(client, excludedUserId) {
  const result = await client.query(
    `SELECT count(*)::int AS total FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
     WHERE r.code = 'super_admin' AND u.status = 'active' AND u.id <> $1`,
    [excludedUserId]
  );
  if (!result.rows[0].total) throw badRequest('Harus selalu ada minimal satu Super Admin aktif.');
}

function parseEvent(body, { partial = false } = {}) {
  const output = {};
  const required = !partial;
  const title = str(body, 'title', { required, max: 200, label: 'Judul' });
  if (title !== undefined) output.title = title;
  const type = str(body, 'type', { required, max: 60, label: 'Tipe' });
  if (type !== undefined) output.type = type;
  const date = str(body, 'date', { required, max: 10, label: 'Tanggal' });
  if (date !== undefined) {
    if (!DATE_PATTERN.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw badRequest('Tanggal harus berformat YYYY-MM-DD.', 'date');
    output.event_date = date;
  }
  const time = str(body, 'time', { required, max: 5, label: 'Jam' });
  if (time !== undefined) {
    if (!TIME_PATTERN.test(time)) throw badRequest('Jam harus berformat HH:MM.', 'time');
    output.event_time = time;
  }
  const location = str(body, 'location', { required, max: 300, label: 'Lokasi' });
  if (location !== undefined) output.location = location;
  if ('description' in body) output.description = str(body, 'description', { max: 5000 }) || '';
  const quota = int(body, 'quota', { required, min: 1, label: 'Kuota' });
  if (quota !== undefined) output.quota = quota;
  if ('status' in body) output.status = oneOf(body, 'status', ['draft', 'published', 'cancelled'], { required: true });
  if ('contactWhatsapp' in body) {
    const raw = str(body, 'contactWhatsapp', { max: 20 });
    const phone = raw ? normalizePhone(raw) : null;
    if (phone && !isValidPhone(phone)) throw badRequest('Format No. WhatsApp tidak valid.', 'contactWhatsapp');
    output.contact_whatsapp = phone;
  }
  if ('image' in body) {
    output.image_path = body.image ? toStoragePath(body.image) : null;
    if (body.image && !output.image_path) throw badRequest('Gambar event tidak valid.', 'image');
  }
  return output;
}

async function validEventType(type) {
  if (!type) return;
  const result = await pool.query(`SELECT 1 FROM reference_items WHERE kind = 'event_type' AND code = $1`, [type]);
  if (!result.rowCount) throw badRequest('Tipe event tidak valid.', 'type');
}

function updateSql(table, data, idColumn = 'id') {
  const columns = Object.keys(data);
  const sets = columns.map((column, index) => `${column} = $${index + 2}`);
  return { sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE ${idColumn} = $1`, values: columns.map((column) => data[column]) };
}

export function adminRoutes() {
  const router = Router();
  router.use('/admin', requireAdmin, (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });

  // ---- Dashboard ----
  router.get('/admin/dashboard', async (_request, response) => {
    const result = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM users) AS users_total,
        (SELECT count(*)::int FROM users WHERE status = 'active') AS users_active,
        (SELECT count(DISTINCT ur.user_id)::int FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code IN ('admin','super_admin')) AS admins,
        (SELECT json_object_agg(membership_type, total) FROM (SELECT membership_type, count(*)::int AS total FROM users GROUP BY membership_type) m) AS by_membership,
        (SELECT count(*)::int FROM lapak_products WHERE status = 'pending') AS lapak_pending,
        (SELECT count(*)::int FROM lapak_products WHERE status = 'approved') AS lapak_approved,
        (SELECT count(*)::int FROM events WHERE status = 'published' AND event_date >= $1) AS events_upcoming,
        (SELECT count(*)::int FROM event_registrations WHERE status = 'registered') AS registrations_pending,
        (SELECT count(*)::int FROM testimonials WHERE status = 'pending') AS testimonials_pending,
        (SELECT count(*)::int FROM questions q WHERE NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id = q.id AND a.is_official)) AS questions_unanswered
    `, [todayWib()]);
    const row = result.rows[0];
    return sendData(response, {
      users: { total: row.users_total, active: row.users_active, admins: row.admins, byMembership: row.by_membership || {} },
      lapak: { pending: row.lapak_pending, approved: row.lapak_approved },
      events: { upcoming: row.events_upcoming },
      registrations: { pending: row.registrations_pending },
      testimonials: { pending: row.testimonials_pending },
      questions: { unanswered: row.questions_unanswered }
    });
  });

  // ---- Statistik tren (grafik dashboard) ----
  router.get('/admin/stats/trends', async (request, response) => {
    const days = int(request.query, 'days', { min: 7, max: 180, label: 'Rentang hari' }) ?? 30;
    const today = todayWib();
    const from = todayWib(-(days - 1));
    const previousFrom = todayWib(-(days * 2 - 1));
    const wib = (column) => `(${column} AT TIME ZONE 'Asia/Jakarta')::date`;
    const daily = (table, column = 'created_at', expression = 'count(*)') => `
      SELECT ${wib(column)} AS day, ${expression}::int AS total FROM ${table}
      WHERE ${wib(column)} BETWEEN $1 AND $2 GROUP BY 1`;
    const [series, summary, byKorda, topEvents] = await Promise.all([
      pool.query(`
        WITH days AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day),
        new_users AS (${daily('users')}),
        active_users AS (
          SELECT activity_date AS day, count(*)::int AS total FROM user_activity_days
          WHERE activity_date BETWEEN $1 AND $2 GROUP BY 1),
        riyadhoh_users AS (
          SELECT log_date AS day, count(DISTINCT user_id)::int AS total FROM riyadhoh_logs
          WHERE completed AND log_date BETWEEN $1 AND $2 GROUP BY 1),
        registrations AS (${daily('event_registrations')}),
        products AS (${daily('lapak_products')}),
        questions AS (${daily('questions')}),
        testimonials AS (${daily('testimonials')})
        SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
               COALESCE(nu.total, 0) AS new_users, COALESCE(au.total, 0) AS active_users,
               COALESCE(ru.total, 0) AS riyadhoh_users, COALESCE(er.total, 0) AS registrations,
               COALESCE(lp.total, 0) AS products, COALESCE(q.total, 0) AS questions, COALESCE(t.total, 0) AS testimonials
        FROM days d
        LEFT JOIN new_users nu ON nu.day = d.day
        LEFT JOIN active_users au ON au.day = d.day
        LEFT JOIN riyadhoh_users ru ON ru.day = d.day
        LEFT JOIN registrations er ON er.day = d.day
        LEFT JOIN products lp ON lp.day = d.day
        LEFT JOIN questions q ON q.day = d.day
        LEFT JOIN testimonials t ON t.day = d.day
        ORDER BY d.day`, [from, today]),
      pool.query(`
        SELECT
          (SELECT count(*)::int FROM user_activity_days WHERE activity_date = $1) AS dau,
          (SELECT count(DISTINCT user_id)::int FROM user_activity_days WHERE activity_date > $1::date - 7) AS wau,
          (SELECT count(DISTINCT user_id)::int FROM user_activity_days WHERE activity_date > $1::date - 30) AS mau,
          (SELECT count(*)::int FROM users WHERE ${wib('created_at')} BETWEEN $2 AND $1) AS new_users,
          (SELECT count(*)::int FROM users WHERE ${wib('created_at')} >= $3 AND ${wib('created_at')} < $2) AS new_users_previous,
          (SELECT count(*)::int FROM users) AS total_users`, [today, from, previousFrom]),
      pool.query(`
        SELECT COALESCE(k.label, 'Belum memilih korda') AS label, count(*)::int AS total
        FROM users u LEFT JOIN kordas k ON k.id = u.korda_id
        GROUP BY 1 ORDER BY total DESC, label LIMIT 10`),
      pool.query(`
        SELECT e.id, e.title, to_char(e.event_date, 'YYYY-MM-DD') AS date, e.quota,
               count(r.id) FILTER (WHERE r.status <> 'cancelled')::int AS registrations
        FROM events e LEFT JOIN event_registrations r ON r.event_id = e.id
        WHERE e.status = 'published' AND e.event_date >= $1
        GROUP BY e.id ORDER BY registrations DESC, e.event_date LIMIT 5`, [today])
    ]);
    const row = summary.rows[0];
    return sendData(response, {
      days,
      from,
      to: today,
      summary: {
        dau: row.dau,
        wau: row.wau,
        mau: row.mau,
        totalUsers: row.total_users,
        newUsers: row.new_users,
        newUsersPrevious: row.new_users_previous
      },
      series: series.rows.map((item) => ({
        date: item.date,
        newUsers: item.new_users,
        activeUsers: item.active_users,
        riyadhohUsers: item.riyadhoh_users,
        registrations: item.registrations,
        products: item.products,
        questions: item.questions,
        testimonials: item.testimonials
      })),
      usersByKorda: byKorda.rows,
      topEvents: topEvents.rows
    });
  });

  // ---- Kesehatan sistem ----
  router.get('/admin/system/health', async (_request, response) => {
    let database;
    const started = Date.now();
    try {
      await pool.query('SELECT 1');
      const latencyMs = Date.now() - started;
      const [info, tables] = await Promise.all([
        pool.query(`SELECT pg_database_size(current_database())::bigint AS size, current_setting('server_version') AS version`),
        pool.query(`SELECT relname AS name, n_live_tup::bigint AS rows FROM pg_stat_user_tables ORDER BY n_live_tup DESC, relname LIMIT 12`)
      ]);
      database = {
        ok: true,
        latencyMs,
        sizeBytes: info.rows[0].size,
        version: info.rows[0].version,
        pool: { max: pool.options.max, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
        tables: tables.rows
      };
    } catch (error) {
      database = { ok: false, latencyMs: Date.now() - started, error: error.message };
    }

    const storage = { directory: uploadRoot, purposes: [], files: 0, bytes: 0, disk: null };
    for (const purpose of UPLOAD_PURPOSES) {
      const directory = path.join(uploadRoot, purpose);
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      let bytes = 0;
      let files = 0;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const info = await stat(path.join(directory, entry.name)).catch(() => null);
        if (!info) continue;
        files += 1;
        bytes += info.size;
      }
      storage.purposes.push({ purpose, files, bytes });
      storage.files += files;
      storage.bytes += bytes;
    }
    const disk = await statfs(uploadRoot).catch(() => null);
    if (disk) storage.disk = { freeBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize };

    let app = null;
    if (database.ok) {
      const counts = await pool.query(`
        SELECT
          (SELECT count(*)::int FROM user_sessions WHERE revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP AND client = 'mobile') AS mobile_sessions,
          (SELECT count(*)::int FROM user_sessions WHERE revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP AND client = 'admin') AS admin_sessions,
          (SELECT COALESCE(json_object_agg(platform, total), '{}'::json) FROM (SELECT platform, count(*)::int AS total FROM user_devices GROUP BY platform) d) AS devices`);
      app = {
        mobileSessions: counts.rows[0].mobile_sessions,
        adminSessions: counts.rows[0].admin_sessions,
        pushDevices: counts.rows[0].devices
      };
    }

    const memory = process.memoryUsage();
    return sendData(response, {
      status: database.ok ? 'ok' : 'degraded',
      checkedAt: new Date().toISOString(),
      server: {
        nodeVersion: process.version,
        platform: `${process.platform}/${process.arch}`,
        uptimeSeconds: Math.round(process.uptime()),
        memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
        env: {
          nodeEnv: process.env.NODE_ENV || 'development',
          trustProxy: process.env.TRUST_PROXY === 'true',
          publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() || null,
          pushEnabled: process.env.PUSH_DISABLED !== 'true'
        }
      },
      database,
      storage,
      app,
      requests: metricsSnapshot()
    });
  });

  // ---- Users ----
  router.get('/admin/users', async (request, response) => {
    const page = paging(request.query, { defaultPerPage: 25 });
    const filters = ['TRUE'];
    const values = [];
    if (request.query.q) {
      values.push(likePattern(String(request.query.q)));
      filters.push(`(u.full_name ILIKE $${values.length} OR u.email ILIKE $${values.length} OR u.phone ILIKE $${values.length})`);
    }
    if (request.query.membershipType) {
      values.push(String(request.query.membershipType));
      filters.push(`u.membership_type = $${values.length}`);
    }
    if (request.query.status) {
      values.push(String(request.query.status));
      filters.push(`u.status = $${values.length}`);
    }
    if (request.query.role) {
      values.push(String(request.query.role));
      filters.push(`EXISTS (SELECT 1 FROM user_roles x JOIN roles y ON y.id = x.role_id WHERE x.user_id = u.id AND y.code = $${values.length})`);
    }
    const where = filters.join(' AND ');
    const [rows, count] = await Promise.all([
      pool.query(`${USER_LIST_SELECT} WHERE ${where} GROUP BY u.id ORDER BY u.created_at DESC LIMIT ${page.perPage} OFFSET ${page.offset}`, values),
      pool.query(`SELECT count(*)::int AS total FROM users u WHERE ${where}`, values)
    ]);
    const users = await Promise.all(rows.rows.map((row) => attachFeatures(row)));
    return sendData(response, users.map((row) => serializeUser(request, row, { includeAdminFields: true })), pageMeta(page, count.rows[0].total));
  });

  router.get('/admin/users/:id', async (request, response) => {
    const user = await targetUser(request.params.id);
    return sendData(response, serializeUser(request, user, { includeAdminFields: true }));
  });

  router.post('/admin/users', async (request, response) => {
    const body = request.body || {};
    const name = str(body, 'name', { required: true, max: 150, label: 'Nama' });
    const email = str(body, 'email', { required: true, max: 254, label: 'Email' }).toLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw badRequest('Format email tidak valid.', 'email');
    const rawPhone = str(body, 'phone', { max: 20 });
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    if (phone && !isValidPhone(phone)) throw badRequest('Format No. HP tidak valid.', 'phone');
    const role = oneOf(body, 'role', ROLE_CODES) || 'calon_sahabat';
    if (!hasRole(request.user, 'super_admin') && !ADMIN_ASSIGNABLE_ROLES.includes(role)) {
      throw forbidden('Hanya Super Admin yang dapat membuat akun admin.');
    }
    const membershipType = oneOf(body, 'membershipType', ['free', 'membership', 'sahabat']) || 'free';
    const temporaryPassword = randomBytes(6).toString('base64url');
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    try {
      const userId = await withTransaction(async (client) => {
        const inserted = await client.query(
          `INSERT INTO users (full_name, email, phone, password_hash, membership_type, must_change_password)
           VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id`,
          [name, email, phone, passwordHash, membershipType]
        );
        await client.query(
          'INSERT INTO user_roles (user_id, role_id, assigned_by) SELECT $1, id, $3 FROM roles WHERE code = $2',
          [inserted.rows[0].id, role, request.user.id]
        );
        await audit(client, request.user.id, 'user.create', 'user', inserted.rows[0].id, { email, role });
        return inserted.rows[0].id;
      });
      const user = await loadUserById(userId);
      return sendData(response, { user: serializeUser(request, user, { includeAdminFields: true }), temporaryPassword }, undefined, 201);
    } catch (error) {
      if (error.code === '23505') throw conflict('Email atau No. HP sudah terdaftar.', 'email');
      throw error;
    }
  });

  router.patch('/admin/users/:id/role', async (request, response) => {
    const target = await targetUser(request.params.id);
    assertCanManage(request.user, target);
    const role = oneOf(request.body || {}, 'role', ROLE_CODES, { required: true, label: 'Role' });
    if (!hasRole(request.user, 'super_admin') && !ADMIN_ASSIGNABLE_ROLES.includes(role)) {
      throw forbidden('Admin hanya dapat memberi role calon_sahabat, sahabat, atau praktisi.');
    }
    await withTransaction(async (client) => {
      if (target.role_codes.includes('super_admin') && role !== 'super_admin') await ensureAnotherSuperAdmin(client, target.id);
      await client.query('DELETE FROM user_roles WHERE user_id = $1', [target.id]);
      await client.query(
        'INSERT INTO user_roles (user_id, role_id, assigned_by) SELECT $1, id, $3 FROM roles WHERE code = $2',
        [target.id, role, request.user.id]
      );
      await audit(client, request.user.id, 'user.role', 'user', target.id, { from: target.role_codes, to: role });
    });
    return sendData(response, serializeUser(request, await loadUserById(target.id), { includeAdminFields: true }));
  });

  router.patch('/admin/users/:id/status', async (request, response) => {
    const target = await targetUser(request.params.id);
    assertCanManage(request.user, target);
    const isActive = bool(request.body || {}, 'isActive');
    if (isActive === undefined) throw badRequest('isActive wajib diisi.', 'isActive');
    await withTransaction(async (client) => {
      if (!isActive && target.role_codes.includes('super_admin')) await ensureAnotherSuperAdmin(client, target.id);
      await client.query('UPDATE users SET status = $2 WHERE id = $1', [target.id, isActive ? 'active' : 'suspended']);
      if (!isActive) await revokeUserSessions(client, target.id);
      await audit(client, request.user.id, isActive ? 'user.activate' : 'user.suspend', 'user', target.id);
    });
    return sendData(response, serializeUser(request, await loadUserById(target.id), { includeAdminFields: true }));
  });

  router.patch('/admin/users/:id/membership', async (request, response) => {
    const target = await targetUser(request.params.id);
    const body = request.body || {};
    const membershipType = oneOf(body, 'membershipType', ['free', 'membership', 'sahabat'], { required: true });
    const lbuBatch = int(body, 'lbuBatch', { min: 1, label: 'Angkatan LBU' });
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE users SET membership_type = $2, lbu_batch = CASE WHEN $3::boolean THEN $4 ELSE lbu_batch END WHERE id = $1`,
        [target.id, membershipType, lbuBatch !== undefined, lbuBatch ?? null]
      );
      await audit(client, request.user.id, 'user.membership', 'user', target.id, { from: target.membership_type, to: membershipType });
    });
    if (membershipType !== target.membership_type) {
      const plan = await pool.query('SELECT label FROM membership_plans WHERE type = $1', [membershipType]);
      const label = plan.rows[0]?.label || membershipType;
      await notifyUsers([target.id], {
        type: 'info', title: 'Membership diperbarui', body: `Membership Anda sekarang: ${label}.`, icon: 'ribbon'
      });
    }
    return sendData(response, serializeUser(request, await loadUserById(target.id), { includeAdminFields: true }));
  });

  router.patch('/admin/users/:id/features', async (request, response) => {
    const target = await targetUser(request.params.id);
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Format fitur tidak valid.');
    const features = (await pool.query('SELECT id FROM membership_features')).rows.map((row) => row.id);
    await withTransaction(async (client) => {
      for (const [featureId, enabled] of Object.entries(body)) {
        if (!features.includes(featureId)) throw badRequest(`Fitur ${featureId} tidak dikenal.`, featureId);
        if (enabled === null) {
          await client.query('DELETE FROM user_feature_overrides WHERE user_id = $1 AND feature_id = $2', [target.id, featureId]);
        } else if (typeof enabled === 'boolean') {
          await client.query(
            `INSERT INTO user_feature_overrides (user_id, feature_id, enabled, updated_by) VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, feature_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by,
               updated_at = CURRENT_TIMESTAMP`,
            [target.id, featureId, enabled, request.user.id]
          );
        } else {
          throw badRequest(`Nilai fitur ${featureId} harus true/false/null.`, featureId);
        }
      }
      await audit(client, request.user.id, 'user.features', 'user', target.id, body);
    });
    return sendData(response, serializeUser(request, await loadUserById(target.id), { includeAdminFields: true }));
  });

  router.post('/admin/users/:id/reset-password', async (request, response) => {
    const target = await targetUser(request.params.id);
    assertCanManage(request.user, target);
    const temporaryPassword = randomBytes(6).toString('base64url');
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    await withTransaction(async (client) => {
      await client.query('UPDATE users SET password_hash = $2, must_change_password = TRUE WHERE id = $1', [target.id, passwordHash]);
      await revokeUserSessions(client, target.id);
      await audit(client, request.user.id, 'user.reset_password', 'user', target.id);
    });
    return sendData(response, { temporaryPassword });
  });

  router.delete('/admin/users/:id', requireSuperAdmin, async (request, response) => {
    const target = await targetUser(request.params.id);
    assertCanManage(request.user, target);
    await withTransaction(async (client) => {
      if (target.role_codes.includes('super_admin')) await ensureAnotherSuperAdmin(client, target.id);
      await audit(client, request.user.id, 'user.delete', 'user', target.id, { email: target.email });
      await client.query('DELETE FROM users WHERE id = $1', [target.id]);
    });
    return response.status(204).end();
  });

  // ---- Membership plans ----
  router.get('/admin/membership-plans', async (_request, response) => sendData(response, await loadMembershipPlans()));

  router.put('/admin/membership-plans/:type', requireSuperAdmin, async (request, response) => {
    const type = request.params.type;
    const plan = await pool.query('SELECT type FROM membership_plans WHERE type = $1', [type]);
    if (!plan.rowCount) throw notFound('Plan tidak ditemukan.');
    const body = request.body || {};
    await withTransaction(async (client) => {
      const label = str(body, 'label', { max: 80 });
      const description = str(body, 'description', { max: 300 });
      const color = str(body, 'color', { max: 20 });
      await client.query(
        `UPDATE membership_plans SET label = COALESCE($2, label), description = COALESCE($3, description),
           color = COALESCE($4, color), updated_at = CURRENT_TIMESTAMP WHERE type = $1`,
        [type, label ?? null, description ?? null, color ?? null]
      );
      if (Array.isArray(body.features)) {
        for (const feature of body.features) {
          if (!feature || typeof feature.id !== 'string' || typeof feature.enabled !== 'boolean') {
            throw badRequest('Format fitur harus { id, enabled }.', 'features');
          }
          await client.query(
            `INSERT INTO membership_plan_features (plan_type, feature_id, enabled) VALUES ($1, $2, $3)
             ON CONFLICT (plan_type, feature_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
            [type, feature.id, feature.enabled]
          );
        }
      }
      await audit(client, request.user.id, 'membership_plan.update', 'membership_plan', type, body);
    });
    return sendData(response, (await loadMembershipPlans()).find((item) => item.type === type));
  });

  // ---- Lapak moderation ----
  router.get('/admin/lapak/products', async (request, response) => {
    const page = paging(request.query, { defaultPerPage: 25 });
    const filters = ['TRUE'];
    const values = [];
    if (request.query.status) {
      values.push(csv(String(request.query.status)));
      filters.push(`p.status = ANY($${values.length}::varchar[])`);
    }
    if (request.query.q) {
      values.push(likePattern(String(request.query.q)));
      filters.push(`(p.name ILIKE $${values.length} OR u.full_name ILIKE $${values.length})`);
    }
    const where = filters.join(' AND ');
    const [rows, count, counts] = await Promise.all([
      pool.query(`${PRODUCT_SELECT} WHERE ${where} ORDER BY (p.status = 'pending') DESC, p.created_at DESC LIMIT ${page.perPage} OFFSET ${page.offset}`, values),
      pool.query(`SELECT count(*)::int AS total FROM lapak_products p JOIN users u ON u.id = p.seller_id WHERE ${where}`, values),
      pool.query(`SELECT status, count(*)::int AS total FROM lapak_products GROUP BY status`)
    ]);
    return sendData(response, rows.rows.map((row) => serializeProduct(request, row)), pageMeta(page, count.rows[0].total, {
      counts: Object.fromEntries(counts.rows.map((row) => [row.status, row.total]))
    }));
  });

  async function moderateProduct(request, status) {
    const id = assertUuid(request.params.id, 'Produk tidak ditemukan.');
    const reason = status === 'rejected' ? str(request.body || {}, 'reason', { max: 300 }) || null : null;
    const result = await withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE lapak_products SET status = $2, rejection_reason = $3 WHERE id = $1 RETURNING seller_id, name`,
        [id, status, reason]
      );
      if (!updated.rowCount) throw notFound('Produk tidak ditemukan.');
      await audit(client, request.user.id, `lapak.${status}`, 'lapak_product', id, reason ? { reason } : {});
      return updated.rows[0];
    });
    await notifyUsers([result.seller_id], {
      type: 'lapak',
      title: status === 'approved' ? 'Produk Anda disetujui' : 'Produk Anda ditolak',
      body: status === 'approved' ? `${result.name} sudah tampil di Lapak.` : `${result.name}${reason ? `: ${reason}` : ''}`,
      icon: 'storefront',
      data: { route: `/lapak/${id}` }
    });
    const row = await pool.query(`${PRODUCT_SELECT} WHERE p.id = $1`, [id]);
    return serializeProduct(request, row.rows[0]);
  }

  router.post('/admin/lapak/products/:id/approve', async (request, response) => sendData(response, await moderateProduct(request, 'approved')));
  router.post('/admin/lapak/products/:id/reject', async (request, response) => sendData(response, await moderateProduct(request, 'rejected')));

  router.put('/admin/lapak/products/:id', async (request, response) => {
    const id = assertUuid(request.params.id, 'Produk tidak ditemukan.');
    const product = await parseProduct(request.body || {}, request.user, { allowAnyOwner: true });
    const result = await pool.query(
      `UPDATE lapak_products SET name = $2, category = $3, description = $4, price = $5, seller_whatsapp = $6,
         photos = $7, specs = $8, tags = $9 WHERE id = $1`,
      [id, product.name, product.category, product.description, product.price, product.sellerWhatsapp, product.photos, product.specs, product.tags]
    );
    if (!result.rowCount) throw notFound('Produk tidak ditemukan.');
    const row = await pool.query(`${PRODUCT_SELECT} WHERE p.id = $1`, [id]);
    return sendData(response, serializeProduct(request, row.rows[0]));
  });

  router.delete('/admin/lapak/products/:id', async (request, response) => {
    const id = assertUuid(request.params.id, 'Produk tidak ditemukan.');
    await withTransaction(async (client) => {
      const result = await client.query('DELETE FROM lapak_products WHERE id = $1 RETURNING name', [id]);
      if (!result.rowCount) throw notFound('Produk tidak ditemukan.');
      await audit(client, request.user.id, 'lapak.delete', 'lapak_product', id, { name: result.rows[0].name });
    });
    return response.status(204).end();
  });

  // ---- Events ----
  router.get('/admin/events', async (request, response) => {
    const page = paging(request.query, { defaultPerPage: 50 });
    const filters = ['TRUE'];
    const values = [];
    if (request.query.status) {
      values.push(csv(String(request.query.status)));
      filters.push(`e.status = ANY($${values.length}::varchar[])`);
    }
    if (request.query.type) {
      values.push(String(request.query.type));
      filters.push(`e.type = $${values.length}`);
    }
    if (request.query.q) {
      values.push(likePattern(String(request.query.q)));
      filters.push(`(e.title ILIKE $${values.length} OR e.location ILIKE $${values.length} OR e.type ILIKE $${values.length})`);
    }
    const where = filters.join(' AND ');
    const [rows, count] = await Promise.all([
      pool.query(`${EVENT_SELECT} FROM events e WHERE ${where} ORDER BY e.event_date DESC, e.event_time DESC LIMIT ${page.perPage} OFFSET ${page.offset}`, values),
      pool.query(`SELECT count(*)::int AS total FROM events e WHERE ${where}`, values)
    ]);
    return sendData(response, rows.rows.map((row) => serializeEvent(request, row)), pageMeta(page, count.rows[0].total));
  });

  router.get('/admin/events/:id', async (request, response) => {
    const id = assertUuid(request.params.id, 'Event tidak ditemukan.');
    const result = await pool.query(`${EVENT_SELECT} FROM events e WHERE e.id = $1`, [id]);
    if (!result.rowCount) throw notFound('Event tidak ditemukan.');
    return sendData(response, serializeEvent(request, result.rows[0]));
  });

  router.post('/admin/events', async (request, response) => {
    const data = parseEvent(request.body || {});
    await validEventType(data.type);
    if (data.image_path?.startsWith('uploads/')) await assertUploads(pool, [data.image_path], request.user.id, { allowAnyOwner: true, field: 'image' });
    data.status = data.status || 'draft';
    data.created_by = request.user.id;
    const columns = Object.keys(data);
    const id = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO events (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING id`,
        columns.map((column) => data[column])
      );
      await audit(client, request.user.id, 'event.create', 'event', inserted.rows[0].id, { title: data.title });
      return inserted.rows[0].id;
    });
    const result = await pool.query(`${EVENT_SELECT} FROM events e WHERE e.id = $1`, [id]);
    return sendData(response, serializeEvent(request, result.rows[0]), undefined, 201);
  });

  router.put('/admin/events/:id', async (request, response) => {
    const id = assertUuid(request.params.id, 'Event tidak ditemukan.');
    const data = parseEvent(request.body || {}, { partial: true });
    await validEventType(data.type);
    if (data.image_path?.startsWith('uploads/')) await assertUploads(pool, [data.image_path], request.user.id, { allowAnyOwner: true, field: 'image' });
    await withTransaction(async (client) => {
      const current = await client.query(`${EVENT_SELECT} FROM events e WHERE e.id = $1 FOR UPDATE`, [id]);
      if (!current.rowCount) throw notFound('Event tidak ditemukan.');
      if (data.quota !== undefined && data.quota < current.rows[0].registered_count) {
        throw badRequest(`Kuota tidak boleh kurang dari jumlah pendaftar (${current.rows[0].registered_count}).`, 'quota');
      }
      if (Object.keys(data).length) {
        const { sql, values } = updateSql('events', data);
        await client.query(sql, [id, ...values]);
      }
      await audit(client, request.user.id, 'event.update', 'event', id, { fields: Object.keys(data) });
    });
    const result = await pool.query(`${EVENT_SELECT} FROM events e WHERE e.id = $1`, [id]);
    return sendData(response, serializeEvent(request, result.rows[0]));
  });

  router.patch('/admin/events/:id/status', async (request, response) => {
    const id = assertUuid(request.params.id, 'Event tidak ditemukan.');
    const status = oneOf(request.body || {}, 'status', ['draft', 'published', 'cancelled'], { required: true });
    const event = await withTransaction(async (client) => {
      const updated = await client.query('UPDATE events SET status = $2 WHERE id = $1 RETURNING title', [id, status]);
      if (!updated.rowCount) throw notFound('Event tidak ditemukan.');
      await audit(client, request.user.id, `event.${status}`, 'event', id);
      return updated.rows[0];
    });
    if (status === 'cancelled') {
      const registrants = await pool.query(
        `SELECT user_id FROM event_registrations WHERE event_id = $1 AND status <> 'cancelled'`, [id]
      );
      await notifyUsers(registrants.rows.map((row) => row.user_id), {
        type: 'event', title: 'Event dibatalkan', body: event.title, icon: 'calendar', data: { route: `/event/${id}` }
      });
    }
    const result = await pool.query(`${EVENT_SELECT} FROM events e WHERE e.id = $1`, [id]);
    return sendData(response, serializeEvent(request, result.rows[0]));
  });

  router.delete('/admin/events/:id', async (request, response) => {
    const id = assertUuid(request.params.id, 'Event tidak ditemukan.');
    await withTransaction(async (client) => {
      const registrations = await client.query(
        `SELECT count(*)::int AS total FROM event_registrations WHERE event_id = $1 AND status <> 'cancelled'`, [id]
      );
      if (registrations.rows[0].total) throw conflict('Event sudah memiliki pendaftar. Batalkan event alih-alih menghapus.');
      const deleted = await client.query('DELETE FROM events WHERE id = $1 RETURNING title', [id]);
      if (!deleted.rowCount) throw notFound('Event tidak ditemukan.');
      await audit(client, request.user.id, 'event.delete', 'event', id, { title: deleted.rows[0].title });
    });
    return response.status(204).end();
  });

  // ---- Registrations ----
  router.get('/admin/event-registrations', async (request, response) => {
    const page = paging(request.query, { defaultPerPage: 50, maxPerPage: 500 });
    const filters = ['TRUE'];
    const values = [];
    if (request.query.eventId) {
      values.push(assertUuid(String(request.query.eventId), 'Event tidak ditemukan.'));
      filters.push(`r.event_id = $${values.length}`);
    }
    if (request.query.status) {
      values.push(csv(String(request.query.status)));
      filters.push(`r.status = ANY($${values.length}::varchar[])`);
    }
    if (request.query.q) {
      values.push(likePattern(String(request.query.q)));
      filters.push(`(r.name ILIKE $${values.length} OR r.email ILIKE $${values.length} OR r.phone ILIKE $${values.length})`);
    }
    const where = filters.join(' AND ');
    const [rows, count] = await Promise.all([
      pool.query(`${REGISTRATION_SELECT} WHERE ${where} ORDER BY r.created_at DESC LIMIT ${page.perPage} OFFSET ${page.offset}`, values),
      pool.query(`SELECT count(*)::int AS total FROM event_registrations r WHERE ${where}`, values)
    ]);
    if (request.query.format === 'csv') {
      const header = ['Event', 'Tanggal', 'Nama', 'Email', 'HP', 'Kota', 'Korda', 'Catatan', 'Status', 'Hadir', 'Daftar'];
      const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
      const statusLabels = { registered: 'Terdaftar', confirmed: 'Dikonfirmasi', cancelled: 'Dibatalkan' };
      const wibTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', dateStyle: 'short', timeStyle: 'short' });
      const lines = rows.rows.map((row) => [row.event_title, row.event_date, row.name, row.email, row.phone, row.city, row.korda_label || row.korda_id,
        row.notes, statusLabels[row.status] || row.status, row.attended ? 'ya' : '', row.created_at ? `${wibTime.format(row.created_at)} WIB` : '']
        .map(escape).join(','));
      response.set('Content-Type', 'text/csv; charset=utf-8');
      response.set('Content-Disposition', 'attachment; filename="registrasi-event.csv"');
      // BOM agar Excel membaca file sebagai UTF-8.
      return response.send(`\uFEFF${[header.join(','), ...lines].join('\n')}`);
    }
    return sendData(response, rows.rows.map(serializeRegistration), pageMeta(page, count.rows[0].total));
  });

  router.patch('/admin/event-registrations/:id', async (request, response) => {
    const id = assertUuid(request.params.id, 'Pendaftaran tidak ditemukan.');
    const body = request.body || {};
    const status = oneOf(body, 'status', ['registered', 'confirmed', 'cancelled']);
    const attended = bool(body, 'attended');
    if (status === undefined && attended === undefined) throw badRequest('Isi status atau attended.');
    const before = await pool.query(`${REGISTRATION_SELECT} WHERE r.id = $1`, [id]);
    if (!before.rowCount) throw notFound('Pendaftaran tidak ditemukan.');
    try {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE event_registrations SET status = COALESCE($2, status), attended = COALESCE($3, attended) WHERE id = $1`,
          [id, status ?? null, attended ?? null]
        );
        await audit(client, request.user.id, 'registration.update', 'event_registration', id, { status, attended });
      });
    } catch (error) {
      if (error.code === '23505') throw conflict('User ini sudah punya pendaftaran aktif lain di event yang sama.');
      throw error;
    }
    const row = before.rows[0];
    if (status && status !== row.status && row.user_id && status !== 'registered') {
      await notifyUsers([row.user_id], {
        type: 'event',
        title: status === 'confirmed' ? 'Pendaftaran Dikonfirmasi' : 'Pendaftaran Dibatalkan',
        body: row.event_title,
        icon: 'calendar',
        data: { route: `/event/${row.event_id}` }
      });
    }
    const result = await pool.query(`${REGISTRATION_SELECT} WHERE r.id = $1`, [id]);
    return sendData(response, serializeRegistration(result.rows[0]));
  });

  // ---- Testimonials ----
  router.get('/admin/testimonials', async (request, response) => {
    const page = paging(request.query, { defaultPerPage: 50 });
    const values = [];
    let where = 'TRUE';
    if (request.query.status) {
      values.push(csv(String(request.query.status)));
      where = `t.status = ANY($1::varchar[])`;
    }
    const [rows, count] = await Promise.all([
      pool.query(`${TESTIMONIAL_SELECT} WHERE ${where} ORDER BY (t.status = 'pending') DESC, t.created_at DESC LIMIT ${page.perPage} OFFSET ${page.offset}`, values),
      pool.query(`SELECT count(*)::int AS total FROM testimonials t WHERE ${where}`, values)
    ]);
    return sendData(response, rows.rows.map((row) => serializeTestimonial(request, row)), pageMeta(page, count.rows[0].total));
  });

  router.post('/admin/testimonials', async (request, response) => {
    const body = request.body || {};
    const name = str(body, 'name', { required: true, max: 150, label: 'Nama' });
    const program = str(body, 'program', { required: true, max: 40, label: 'Program' });
    const rating = int(body, 'rating', { required: true, min: 1, max: 5, label: 'Rating' });
    const text = str(body, 'text', { required: true, min: 20, max: 2000, label: 'Testimoni' });
    const korda = str(body, 'korda', { max: 60 }) || null;
    const date = str(body, 'date', { max: 10 }) || todayWib();
    if (!DATE_PATTERN.test(date)) throw badRequest('Tanggal harus berformat YYYY-MM-DD.', 'date');
    const inserted = await pool.query(
      `INSERT INTO testimonials (display_name, korda_id, program, rating, text, status, testimony_date)
       VALUES ($1, (SELECT id FROM kordas WHERE id = $2), $3, $4, $5, 'approved', $6) RETURNING id`,
      [name, korda, program, rating, text, date]
    );
    const result = await pool.query(`${TESTIMONIAL_SELECT} WHERE t.id = $1`, [inserted.rows[0].id]);
    return sendData(response, serializeTestimonial(request, result.rows[0]), undefined, 201);
  });

  async function moderateTestimonial(request, status) {
    const id = assertUuid(request.params.id, 'Testimoni tidak ditemukan.');
    const reason = status === 'rejected' ? str(request.body || {}, 'reason', { max: 300 }) || null : null;
    const updated = await pool.query(
      'UPDATE testimonials SET status = $2, rejection_reason = $3 WHERE id = $1 RETURNING user_id',
      [id, status, reason]
    );
    if (!updated.rowCount) throw notFound('Testimoni tidak ditemukan.');
    await audit(pool, request.user.id, `testimonial.${status}`, 'testimonial', id, reason ? { reason } : {});
    if (status === 'approved' && updated.rows[0].user_id) {
      await notifyUsers([updated.rows[0].user_id], {
        type: 'info', title: 'Testimoni Anda ditampilkan', body: 'Jazakallahu khairan atas testimoninya.', icon: 'chatbubbles',
        data: { route: '/testimoni' }
      });
    }
    const result = await pool.query(`${TESTIMONIAL_SELECT} WHERE t.id = $1`, [id]);
    return serializeTestimonial(request, result.rows[0]);
  }

  router.post('/admin/testimonials/:id/approve', async (request, response) => sendData(response, await moderateTestimonial(request, 'approved')));
  router.post('/admin/testimonials/:id/reject', async (request, response) => sendData(response, await moderateTestimonial(request, 'rejected')));
  router.delete('/admin/testimonials/:id', async (request, response) => {
    const id = assertUuid(request.params.id, 'Testimoni tidak ditemukan.');
    const result = await pool.query('DELETE FROM testimonials WHERE id = $1', [id]);
    if (!result.rowCount) throw notFound('Testimoni tidak ditemukan.');
    await audit(pool, request.user.id, 'testimonial.delete', 'testimonial', id);
    return response.status(204).end();
  });

  // ---- Questions ----
  router.get('/admin/questions', async (request, response) => {
    const page = paging(request.query, { defaultPerPage: 50 });
    const answeredFilter = request.query.answered === 'false'
      ? 'WHERE NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id = q.id AND a.is_official)' : '';
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT q.*, u.full_name AS author_name, u.email AS author_email,
           (SELECT count(*)::int FROM answers a WHERE a.question_id = q.id) AS answers_count,
           EXISTS (SELECT 1 FROM answers a WHERE a.question_id = q.id AND a.is_official) AS has_official
         FROM questions q LEFT JOIN users u ON u.id = q.user_id ${answeredFilter}
         ORDER BY q.created_at DESC LIMIT ${page.perPage} OFFSET ${page.offset}`
      ),
      pool.query(`SELECT count(*)::int AS total FROM questions q ${answeredFilter}`)
    ]);
    return sendData(response, rows.rows.map((row) => ({
      id: row.id, category: row.category, title: row.title, body: row.body, status: row.status,
      isAnonymous: row.is_anonymous, userName: row.author_name, userEmail: row.author_email,
      answersCount: row.answers_count, hasOfficialAnswer: row.has_official, createdAt: row.created_at
    })), pageMeta(page, count.rows[0].total));
  });

  router.patch('/admin/questions/:id', async (request, response) => {
    const id = assertUuid(request.params.id, 'Pertanyaan tidak ditemukan.');
    const status = oneOf(request.body || {}, 'status', ['open', 'closed'], { required: true });
    const result = await pool.query('UPDATE questions SET status = $2 WHERE id = $1', [id, status]);
    if (!result.rowCount) throw notFound('Pertanyaan tidak ditemukan.');
    return sendData(response, { id, status });
  });

  router.delete('/admin/questions/:id', async (request, response) => {
    const id = assertUuid(request.params.id, 'Pertanyaan tidak ditemukan.');
    const result = await pool.query('DELETE FROM questions WHERE id = $1', [id]);
    if (!result.rowCount) throw notFound('Pertanyaan tidak ditemukan.');
    await audit(pool, request.user.id, 'question.delete', 'question', id);
    return response.status(204).end();
  });

  router.delete('/admin/answers/:id', async (request, response) => {
    const id = assertUuid(request.params.id, 'Jawaban tidak ditemukan.');
    const result = await pool.query('DELETE FROM answers WHERE id = $1', [id]);
    if (!result.rowCount) throw notFound('Jawaban tidak ditemukan.');
    return response.status(204).end();
  });

  // ---- Konten CMS generik ----
  router.get('/admin/content', (_request, response) => sendData(response, Object.entries(RESOURCES).map(([key, resource]) => ({
    key,
    label: resource.label,
    pk: resource.pk,
    pkType: resource.pkType,
    noDelete: Boolean(resource.noDelete),
    fields: Object.entries(resource.fields).map(([name, field]) => ({
      name, type: field.type, required: Boolean(field.required), enum: field.enum || null, max: field.max || null
    }))
  }))));

  function resourceFor(request) {
    const resource = RESOURCES[request.params.resource];
    if (!resource) throw notFound('Jenis konten tidak dikenal.');
    return resource;
  }

  function fixedFilter(resource, values) {
    if (!resource.fixed) return 'TRUE';
    return Object.entries(resource.fixed).map(([column, value]) => {
      values.push(value);
      return `${column} = $${values.length}`;
    }).join(' AND ');
  }

  router.get('/admin/content/:resource', async (request, response) => {
    const resource = resourceFor(request);
    const page = paging(request.query, { defaultPerPage: 100, maxPerPage: 500 });
    const values = [];
    const filters = [fixedFilter(resource, values)];
    if (request.query.q) {
      // Tanpa konfigurasi `search`, cari di kode (bila bukan UUID) dan semua kolom teks pendek resource itu.
      const columns = resource.search || [
        ...(resource.pkType === 'uuid' ? [] : [resource.pk]),
        ...Object.values(resource.fields).filter((field) => field.type === 'string' && field.max <= 1000).map((field) => field.column)
      ];
      values.push(likePattern(String(request.query.q)));
      filters.push(`(${columns.map((column) => `${column}::text ILIKE $${values.length}`).join(' OR ')})`);
    }
    const where = filters.join(' AND ');
    const [rows, count] = await Promise.all([
      pool.query(`SELECT * FROM ${resource.table} WHERE ${where} ORDER BY ${resource.order} LIMIT ${page.perPage} OFFSET ${page.offset}`, values),
      pool.query(`SELECT count(*)::int AS total FROM ${resource.table} WHERE ${where}`, values)
    ]);
    return sendData(response, rows.rows.map((row) => serializeResource(request, resource, row)), pageMeta(page, count.rows[0].total));
  });

  router.post('/admin/content/:resource', async (request, response) => {
    const resource = resourceFor(request);
    const parsed = parseResourceBody(resource, request.body);
    // Field kosong tidak ikut di-INSERT agar default kolom database (mis. published_at = now) yang berlaku.
    const keep = parsed.values.map((value) => value !== null && value !== undefined);
    const columns = parsed.columns.filter((_, index) => keep[index]);
    const values = parsed.values.filter((_, index) => keep[index]);
    if (resource.pkType !== 'uuid') {
      columns.unshift(resource.pk);
      values.unshift(validateId(resource, request.body?.id));
    }
    for (const [column, value] of Object.entries(resource.fixed || {})) {
      columns.push(column);
      values.push(value);
    }
    let row;
    try {
      const result = await pool.query(
        `INSERT INTO ${resource.table} (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING *`,
        values
      );
      row = result.rows[0];
    } catch (error) {
      if (error.code === '23505') throw conflict('ID sudah dipakai.', 'id');
      throw error;
    }
    await audit(pool, request.user.id, `content.${request.params.resource}.create`, request.params.resource, row[resource.pk]);
    return sendData(response, serializeResource(request, resource, row), undefined, 201);
  });

  router.put('/admin/content/:resource/:id', async (request, response) => {
    const resource = resourceFor(request);
    const id = validateId(resource, request.params.id);
    const { columns, values } = parseResourceBody(resource, request.body, { partial: true });
    if (!columns.length) throw badRequest('Tidak ada data yang diubah.');
    const filterValues = [id];
    const fixed = Object.entries(resource.fixed || {}).map(([column, value]) => {
      filterValues.push(value);
      return ` AND ${column} = $${filterValues.length}`;
    }).join('');
    const sets = columns.map((column, index) => `${column} = $${filterValues.length + index + 1}`);
    const result = await pool.query(
      `UPDATE ${resource.table} SET ${sets.join(', ')} WHERE ${resource.pk} = $1${fixed} RETURNING *`,
      [...filterValues, ...values]
    );
    if (!result.rowCount) throw notFound(`${resource.label} tidak ditemukan.`);
    await audit(pool, request.user.id, `content.${request.params.resource}.update`, request.params.resource, id);
    return sendData(response, serializeResource(request, resource, result.rows[0]));
  });

  router.delete('/admin/content/:resource/:id', async (request, response) => {
    const resource = resourceFor(request);
    if (resource.noDelete) throw badRequest(`${resource.label} tidak dapat dihapus. Nonaktifkan saja (isActive = false).`);
    const id = validateId(resource, request.params.id);
    const values = [id];
    const fixed = Object.entries(resource.fixed || {}).map(([column, value]) => {
      values.push(value);
      return ` AND ${column} = $${values.length}`;
    }).join('');
    const result = await pool.query(`DELETE FROM ${resource.table} WHERE ${resource.pk} = $1${fixed}`, values);
    if (!result.rowCount) throw notFound(`${resource.label} tidak ditemukan.`);
    await audit(pool, request.user.id, `content.${request.params.resource}.delete`, request.params.resource, id);
    return response.status(204).end();
  });

  // ---- App config (site_content) ----
  router.get('/admin/app-config', async (_request, response) => sendData(response, await loadSiteContent()));

  router.put('/admin/app-config', requireSuperAdmin, async (request, response) => {
    const body = request.body || {};
    await withTransaction(async (client) => {
      for (const [key, value] of Object.entries(body)) {
        if (!(key in DEFAULT_SITE_CONTENT)) throw badRequest(`Kunci ${key} tidak dikenal.`, key);
        if (typeof value !== 'string' || value.length > 5000) throw badRequest(`${key} harus teks maksimal 5000 karakter.`, key);
        await client.query(
          `INSERT INTO site_content (content_key, content_value, updated_by) VALUES ($1, $2, $3)
           ON CONFLICT (content_key) DO UPDATE SET content_value = EXCLUDED.content_value, updated_by = EXCLUDED.updated_by,
             updated_at = CURRENT_TIMESTAMP`,
          [key, value, request.user.id]
        );
      }
      await audit(client, request.user.id, 'app_config.update', 'site_content', null, { keys: Object.keys(body) });
    });
    return sendData(response, await loadSiteContent());
  });

  // ---- Broadcast notifikasi ----
  router.post('/admin/notifications/broadcast', async (request, response) => {
    const body = request.body || {};
    const title = str(body, 'title', { required: true, max: 150, label: 'Judul' });
    const text = str(body, 'body', { required: true, max: 1000, label: 'Isi' });
    const type = oneOf(body, 'type', ['event', 'riyadhoh', 'motivasi', 'lbu', 'lapak', 'tanya', 'info']) || 'info';
    const target = body.target && typeof body.target === 'object' ? body.target : { all: true };
    const filters = ["u.status = 'active'"];
    const values = [];
    if (!target.all) {
      if (Array.isArray(target.membershipTypes) && target.membershipTypes.length) {
        values.push(target.membershipTypes);
        filters.push(`u.membership_type = ANY($${values.length}::varchar[])`);
      }
      if (Array.isArray(target.roles) && target.roles.length) {
        values.push(target.roles);
        filters.push(`EXISTS (SELECT 1 FROM user_roles x JOIN roles y ON y.id = x.role_id WHERE x.user_id = u.id AND y.code = ANY($${values.length}::varchar[]))`);
      }
      if (Array.isArray(target.kordas) && target.kordas.length) {
        values.push(target.kordas);
        filters.push(`u.korda_id = ANY($${values.length}::varchar[])`);
      }
    }
    const users = await pool.query(`SELECT u.id FROM users u WHERE ${filters.join(' AND ')}`, values);
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    const recipients = await notifyUsers(users.rows.map((row) => row.id), { type, title, body: text, icon: 'megaphone', data }, {
      push: body.sendPush !== false
    });
    await audit(pool, request.user.id, 'notification.broadcast', 'notification', null, { title, body: text, type, target, recipients });
    return sendData(response, { recipients }, undefined, 202);
  });

  router.get('/admin/notifications/broadcasts', async (_request, response) => {
    const result = await pool.query(
      `SELECT a.id, a.detail, a.created_at, u.full_name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.action = 'notification.broadcast' ORDER BY a.created_at DESC LIMIT 50`
    );
    return sendData(response, result.rows.map((row) => ({ id: row.id, ...row.detail, sentBy: row.actor_name, createdAt: row.created_at })));
  });

  // ---- Audit log ----
  router.get('/admin/audit-logs', requireSuperAdmin, async (request, response) => {
    const page = paging(request.query, { defaultPerPage: 50 });
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT a.*, u.full_name AS actor_name, u.email AS actor_email FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.created_at DESC LIMIT ${page.perPage} OFFSET ${page.offset}`
      ),
      pool.query('SELECT count(*)::int AS total FROM audit_logs')
    ]);
    return sendData(response, rows.rows.map((row) => ({
      id: row.id, action: row.action, targetType: row.target_type, targetId: row.target_id, detail: row.detail,
      actor: row.actor_id ? { id: row.actor_id, name: row.actor_name, email: row.actor_email } : null, createdAt: row.created_at
    })), pageMeta(page, count.rows[0].total));
  });

  return router;
}
