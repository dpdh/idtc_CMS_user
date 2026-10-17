import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import { fileTypeFromBuffer } from 'file-type';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KTA_QR_DOWNLOAD_WIDTH, ktaQrDataUrl, ktaQrFilename, renderKtaQrPng, upsertKtaQr } from './kta-qr.js';

const SESSION_COOKIE = 'idtc_admin_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const PAGE_SIZE = 25;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHOTO_TYPES = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']]);
const STAFF_ROLES = ['super_admin', 'admin', 'membership'];
const ASSIGNABLE_ROLES = ['super_admin', 'admin', 'membership', 'member'];
const ROLE_LABELS = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  membership: 'Membership',
  member: 'Free Member'
};
const DEFAULT_SITE_CONTENT = {
  welcome_headline_prefix: 'Bangun masa depan,',
  welcome_headline_emphasis: 'bersama IDTC.',
  welcome_description: 'Ruang kolaborasi para praktisi, akademisi, dan inovator untuk memajukan ekosistem digital twin di Indonesia.',
  login_heading: 'Masuk ke akun Anda',
  login_description: 'Lanjutkan kolaborasi dan aktivitas komunitas.',
  register_heading: 'Daftar anggota IDTC',
  register_description: 'Lengkapi data berikut untuk memulai keanggotaan Anda.'
};
const adminLoginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false
});
const adminPasswordResetLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false
});
const publicVerificationLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function secretsMatch(candidate, expected) {
  const candidateHash = createHash('sha256').update(candidate).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

async function saveMemberPhoto(file, photoDirectory, projectRoot) {
  if (!file) return { error: null, stored: null };
  const detectedType = await fileTypeFromBuffer(file.buffer);
  const extension = detectedType && PHOTO_TYPES.get(detectedType.mime);
  if (!extension) return { error: 'Foto harus berupa JPG, PNG, atau WEBP yang valid.', stored: null };

  const filename = `${randomUUID()}.${extension}`;
  const absolutePath = path.join(photoDirectory, filename);
  await writeFile(absolutePath, file.buffer, { flag: 'wx' });
  return {
    error: null,
    stored: {
      absolutePath,
      relativePath: path.relative(projectRoot, absolutePath).split(path.sep).join('/')
    }
  };
}

async function removeMemberPhoto(photoDirectory, storedPath) {
  if (!storedPath) return;
  const filename = path.basename(storedPath.replaceAll('\\', '/'));
  const absolutePath = path.resolve(photoDirectory, filename);
  if (!absolutePath.startsWith(`${photoDirectory}${path.sep}`)) return;
  await unlink(absolutePath).catch((error) => {
    if (error.code !== 'ENOENT') console.error('Gagal menghapus foto anggota:', error.message);
  });
}

function validateMemberProfile({ fullName, email, organization, profession }) {
  if (!fullName || fullName.length > 150) return { field: 'fullName', error: 'Nama wajib diisi dan maksimal 150 karakter.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return { field: 'email', error: 'Masukkan alamat email yang valid.' };
  }
  if (organization.length > 180) return { field: 'organization', error: 'Nama instansi maksimal 180 karakter.' };
  if (profession.length > 180) return { field: 'profession', error: 'Profesi atau jabatan maksimal 180 karakter.' };
  return null;
}

function requireSameOrigin(request, response, next) {
  const origin = request.get('origin');
  if (!origin || new URL(origin).host !== request.get('host')) {
    return response.status(403).json({ error: 'Permintaan lintas situs ditolak.' });
  }
  return next();
}

function createAdminGuard(pool) {
  return async (request, response, next) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) return response.status(401).json({ error: 'Sesi admin tidak ditemukan.' });

    const result = await pool.query(
            `SELECT u.id, u.full_name, u.email,
              array_agg(DISTINCT r.code ORDER BY r.code) AS role_codes
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > CURRENT_TIMESTAMP
         AND u.status = 'active'
         AND r.code = ANY($2::varchar[])
       GROUP BY u.id
       LIMIT 1`,
      [tokenHash(token), STAFF_ROLES]
    );

    if (!result.rowCount) return response.status(401).json({ error: 'Sesi admin tidak valid atau sudah berakhir.' });
    request.admin = {
      ...result.rows[0],
      roleCodes: result.rows[0].role_codes
    };
    return next();
  };
}

function requireRoles(request, response, next, ...allowedRoles) {
  if (!request.admin.roleCodes.some((role) => allowedRoles.includes(role))) {
    return response.status(403).json({ error: 'Role Anda tidak memiliki akses ke fitur ini.' });
  }
  return next();
}

async function ensureAdminSchema(pool) {
  await pool.query(
    `INSERT INTO roles (code, name)
     VALUES ('super_admin', 'Super Admin'), ('admin', 'Admin'),
            ('membership', 'Membership'), ('member', 'Free Member')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS site_content (
       content_key VARCHAR(80) PRIMARY KEY,
       content_value TEXT NOT NULL,
       updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`
  );
  for (const [key, value] of Object.entries(DEFAULT_SITE_CONTENT)) {
    await pool.query(
      'INSERT INTO site_content (content_key, content_value) VALUES ($1, $2) ON CONFLICT (content_key) DO NOTHING',
      [key, value]
    );
  }
}

export async function ensureBootstrapAdmin(pool) {
  await ensureAdminSchema(pool);
  const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || 'dani.hd@idtc.org').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(superAdminEmail) || superAdminEmail.length > 254) {
    throw new Error('SUPER_ADMIN_EMAIL harus berupa alamat email yang valid.');
  }
  const superAdminResult = await pool.query(
    `UPDATE users SET status = 'active', email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP)
     WHERE lower(email) = $1
     RETURNING id`,
    [superAdminEmail]
  );
  if (superAdminResult.rowCount) {
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE code = 'super_admin'
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [superAdminResult.rows[0].id]
    );
    console.log(`Super Admin siap: ${superAdminEmail}`);
  }
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email && !password) {
    console.warn('Panel admin belum aktif. Atur ADMIN_EMAIL dan ADMIN_PASSWORD untuk membuat admin.');
    return;
  }
  if (!email || !password || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('ADMIN_EMAIL dan ADMIN_PASSWORD wajib diatur; password harus 12-72 byte.');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingResult = await client.query(
      `SELECT u.id,
              EXISTS (
                SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = u.id AND r.code = 'admin'
              ) AS has_admin_role,
              EXISTS (
                SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = u.id AND r.code = 'super_admin'
              ) AS is_super_admin
       FROM users u WHERE lower(u.email) = $1 FOR UPDATE`,
      [email]
    );
    let adminId;
    if (existingResult.rowCount) {
      if (!existingResult.rows[0].has_admin_role && !existingResult.rows[0].is_super_admin) {
        throw new Error('ADMIN_EMAIL sudah digunakan akun non-admin. Gunakan email khusus admin.');
      }
      adminId = existingResult.rows[0].id;
      if (!existingResult.rows[0].is_super_admin) {
        await client.query(
          `UPDATE users SET full_name = 'Admin IDTC', password_hash = $1,
           organization = 'IDTC', status = 'active',
           email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP)
           WHERE id = $2`,
          [passwordHash, adminId]
        );
      }
    } else {
      const userResult = await client.query(
        `INSERT INTO users (full_name, email, password_hash, organization, member_photo_path, status, email_verified_at)
         VALUES ('Admin IDTC', $1, $2, 'IDTC', NULL, 'active', CURRENT_TIMESTAMP)
         RETURNING id`,
        [email, passwordHash]
      );
      adminId = userResult.rows[0].id;
    }
    const roleResult = await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE code = 'admin'
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [adminId]
    );
    const hasAdminRole = await client.query(
      `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND r.code = 'admin'`,
      [adminId]
    );
    if (!hasAdminRole.rowCount) throw new Error('Role admin belum tersedia. Jalankan database.sql.');
    await client.query('COMMIT');
    console.log(`Admin siap: ${email}${roleResult.rowCount ? '' : ' (role sudah tersedia)'}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function registerAdminRoutes(app, { pool, photoDirectory, projectRoot, upload }) {
  const requireAdmin = createAdminGuard(pool);
  const requireSuperAdmin = (request, response, next) => requireRoles(request, response, next, 'super_admin');
  const requireContentManager = (request, response, next) => requireRoles(request, response, next, 'super_admin', 'admin');
  app.use('/api/admin', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/admin', (_request, response) => response.sendFile(path.join(projectRoot, 'admin.html')));
  app.get('/admin.css', (_request, response) => response.sendFile(path.join(projectRoot, 'admin.css')));
  app.get('/admin.js', (_request, response) => response.sendFile(path.join(projectRoot, 'admin-ui.js')));
  app.get('/verify/:id', (_request, response) => response.sendFile(path.join(projectRoot, 'verify.html')));
  app.get('/verify.css', (_request, response) => response.sendFile(path.join(projectRoot, 'verify.css')));
  app.get('/verify.js', (_request, response) => response.sendFile(path.join(projectRoot, 'verify.js')));

  app.get('/api/members/verify/:id', publicVerificationLimit, async (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) return response.status(404).json({ error: 'Kode keanggotaan tidak valid.' });
    const result = await pool.query(
      `SELECT u.full_name, u.member_number, u.organization, u.status, u.created_at
       FROM users u
       WHERE u.id = $1 AND EXISTS (
         SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = u.id AND r.code = 'member'
       )
       LIMIT 1`,
      [request.params.id]
    );
    if (!result.rowCount) return response.status(404).json({ error: 'Keanggotaan tidak ditemukan.' });
    const member = result.rows[0];
    response.set('Cache-Control', 'no-store');
    return response.json({
      member: {
        fullName: member.full_name,
        memberNumber: `IDTC-${String(member.member_number).padStart(6, '0')}`,
        organization: member.organization,
        status: member.status,
        memberSince: member.created_at
      }
    });
  });

  app.get('/api/content/homepage', async (_request, response) => {
    const result = await pool.query('SELECT content_key, content_value FROM site_content');
    const content = { ...DEFAULT_SITE_CONTENT };
    for (const row of result.rows) content[row.content_key] = row.content_value;
    return response.json({ content });
  });

  app.post('/api/admin/reset-password', requireSameOrigin, adminPasswordResetLimit, async (request, response) => {
    const resetToken = typeof request.body?.resetToken === 'string' ? request.body.resetToken : '';
    const newPassword = typeof request.body?.newPassword === 'string' ? request.body.newPassword : '';
    const passwordConfirm = typeof request.body?.passwordConfirm === 'string' ? request.body.passwordConfirm : '';
    const configuredToken = process.env.SUPER_ADMIN_RESET_TOKEN || '';
    if (configuredToken.length < 32) {
      return response.status(503).json({ error: 'Token reset belum dikonfigurasi di environment server.' });
    }
    if (!resetToken || !secretsMatch(resetToken, configuredToken)) {
      return response.status(403).json({ error: 'Token reset tidak valid.' });
    }
    if (newPassword.length < 12 || Buffer.byteLength(newPassword, 'utf8') > 72) {
      return response.status(400).json({ error: 'Password baru harus minimal 12 karakter dan maksimal 72 byte.' });
    }
    if (passwordConfirm !== newPassword) {
      return response.status(400).json({ error: 'Konfirmasi password belum sama.' });
    }

    const email = (process.env.SUPER_ADMIN_EMAIL || 'dani.hd@idtc.org').trim().toLowerCase();
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT id FROM users WHERE lower(email) = $1 FOR UPDATE', [email]);
      let userId;
      if (existing.rowCount) {
        userId = existing.rows[0].id;
        await client.query(
          `UPDATE users SET password_hash = $1, status = 'active',
           email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP)
           WHERE id = $2`,
          [passwordHash, userId]
        );
      } else {
        const created = await client.query(
          `INSERT INTO users (full_name, email, password_hash, organization, member_photo_path, status, email_verified_at)
           VALUES ('Dani Hamdani', $1, $2, 'IDTC', NULL, 'active', CURRENT_TIMESTAMP)
           RETURNING id`,
          [email, passwordHash]
        );
        userId = created.rows[0].id;
      }
      await client.query(
        `INSERT INTO roles (code, name) VALUES ('super_admin', 'Super Admin')
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`
      );
      await client.query(
        `INSERT INTO user_roles (user_id, role_id, assigned_by)
         SELECT $1, id, $1 FROM roles WHERE code = 'super_admin'
         ON CONFLICT (user_id, role_id) DO NOTHING`,
        [userId]
      );
      await client.query(
        'UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL',
        [userId]
      );
      await client.query('COMMIT');
      return response.json({ message: 'Password Super Admin berhasil diperbarui. Silakan masuk kembali.' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/api/admin/login', requireSameOrigin, adminLoginLimit, async (request, response) => {
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const result = await pool.query(
            `SELECT u.id, u.full_name, u.email, u.password_hash,
              array_agg(DISTINCT r.code ORDER BY r.code) AS role_codes
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE lower(u.email) = $1 AND u.status = 'active' AND r.code = ANY($2::varchar[])
      GROUP BY u.id
       LIMIT 1`,
          [email, STAFF_ROLES]
    );
    const admin = result.rows[0];
    if (!admin || !password || !(await bcrypt.compare(password, admin.password_hash))) {
      return response.status(401).json({ error: 'Email atau password admin salah.' });
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    await pool.query(
      'INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [admin.id, tokenHash(token), expiresAt]
    );
    response.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: SESSION_DURATION_MS,
      path: '/'
    });
    return response.json({ admin: { id: admin.id, fullName: admin.full_name, email: admin.email, roleCodes: admin.role_codes } });
  });

  app.get('/api/admin/me', requireAdmin, (request, response) => {
    response.json({ admin: { id: request.admin.id, fullName: request.admin.full_name, email: request.admin.email, roleCodes: request.admin.role_codes } });
  });

  app.get('/api/admin/accounts', requireAdmin, requireSuperAdmin, async (request, response) => {
    const search = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 100) : '';
    const result = await pool.query(
      `SELECT u.id, u.full_name, u.email, u.status, u.created_at,
              COALESCE(array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), ARRAY[]::varchar[]) AS role_codes
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       WHERE ($1 = '' OR u.full_name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT 500`,
      [search]
    );
    return response.json({
      accounts: result.rows.map((account) => ({
        id: account.id,
        fullName: account.full_name,
        email: account.email,
        status: account.status,
        createdAt: account.created_at,
        roleCodes: account.role_codes,
        roles: account.role_codes.map((role) => ROLE_LABELS[role] || role)
      })),
      roles: ASSIGNABLE_ROLES.map((code) => ({ code, name: ROLE_LABELS[code] }))
    });
  });

  app.patch('/api/admin/accounts/:id/role', requireSameOrigin, requireAdmin, requireSuperAdmin, async (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) return response.status(400).json({ error: 'ID pengguna tidak valid.' });
    const role = request.body?.role;
    if (!ASSIGNABLE_ROLES.includes(role)) return response.status(400).json({ error: 'Role tujuan tidak valid.' });
    if (request.params.id === request.admin.id && role !== 'super_admin') {
      return response.status(403).json({ error: 'Super Admin tidak dapat menurunkan role akunnya sendiri.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('idtc_super_admin_role_change'))");
      const existing = await client.query(
        `SELECT u.id, EXISTS (
           SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id AND r.code = 'super_admin'
         ) AS is_super_admin
         FROM users u WHERE u.id = $1 FOR UPDATE`,
        [request.params.id]
      );
      if (!existing.rowCount) {
        await client.query('ROLLBACK');
        return response.status(404).json({ error: 'Pengguna tidak ditemukan.' });
      }
      if (existing.rows[0].is_super_admin && role !== 'super_admin') {
        const count = await client.query(
          `SELECT COUNT(DISTINCT ur.user_id)::int AS total
           FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE r.code = 'super_admin'`
        );
        if (count.rows[0].total <= 1) {
          await client.query('ROLLBACK');
          return response.status(409).json({ error: 'Minimal harus ada satu Super Admin.' });
        }
      }

      if (role === 'member') {
        await client.query(
          `DELETE FROM user_roles ur USING roles r
           WHERE ur.role_id = r.id AND ur.user_id = $1 AND r.code <> 'member'`,
          [request.params.id]
        );
      } else {
        await client.query(
          `DELETE FROM user_roles ur USING roles r
           WHERE ur.role_id = r.id AND ur.user_id = $1 AND r.code <> 'member'`,
          [request.params.id]
        );
        await client.query(
          `INSERT INTO user_roles (user_id, role_id, assigned_by)
           SELECT $1, id, $2 FROM roles WHERE code = $3
           ON CONFLICT (user_id, role_id) DO NOTHING`,
          [request.params.id, request.admin.id, role]
        );
      }
      if (role === 'member') {
        await client.query(
          `INSERT INTO user_roles (user_id, role_id, assigned_by)
           SELECT $1, id, $2 FROM roles WHERE code = 'member'
           ON CONFLICT (user_id, role_id) DO NOTHING`,
          [request.params.id, request.admin.id]
        );
      }
      await client.query('COMMIT');
      return response.json({ ok: true, role, roleName: ROLE_LABELS[role] });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/api/admin/content', requireAdmin, requireContentManager, async (_request, response) => {
    const result = await pool.query('SELECT content_key, content_value FROM site_content');
    const content = { ...DEFAULT_SITE_CONTENT };
    for (const row of result.rows) content[row.content_key] = row.content_value;
    return response.json({ content });
  });

  app.put('/api/admin/content', requireSameOrigin, requireAdmin, requireContentManager, async (request, response) => {
    const content = request.body?.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      return response.status(400).json({ error: 'Data konten tidak valid.' });
    }
    const entries = Object.keys(DEFAULT_SITE_CONTENT).map((key) => [key, content[key]]);
    for (const [key, value] of entries) {
        const maximumLength = key.includes('description') ? 1000 : 180;
      if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) {
        return response.status(400).json({ error: `Konten ${key} wajib diisi dan maksimal ${maximumLength} karakter.` });
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [key, value] of entries) {
        await client.query(
          `INSERT INTO site_content (content_key, content_value, updated_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (content_key) DO UPDATE SET
             content_value = EXCLUDED.content_value,
             updated_by = EXCLUDED.updated_by,
             updated_at = CURRENT_TIMESTAMP`,
          [key, value.trim(), request.admin.id]
        );
      }
      await client.query('COMMIT');
      return response.json({ content: Object.fromEntries(entries.map(([key, value]) => [key, value.trim()])) });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/api/admin/logout', requireSameOrigin, requireAdmin, async (request, response) => {
    const token = request.cookies[SESSION_COOKIE];
    await pool.query(
      'UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = $1 AND revoked_at IS NULL',
      [tokenHash(token)]
    );
    response.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' });
    return response.json({ ok: true });
  });

  app.get('/api/admin/users', requireAdmin, async (request, response) => {
    const status = typeof request.query.status === 'string' ? request.query.status : 'all';
    if (!['all', 'pending', 'active', 'suspended'].includes(status)) {
      return response.status(400).json({ error: 'Filter status tidak valid.' });
    }
    const search = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 100) : '';
    const requestedPage = Number.parseInt(request.query.page, 10);
    const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const offset = (page - 1) * PAGE_SIZE;
    const [usersResult, countResult] = await Promise.all([
      pool.query(
        `SELECT u.id, u.member_number, u.full_name, u.email, u.organization, u.profession, u.member_photo_path,
          u.status, u.created_at,
                COALESCE(user_role.role_codes, '') AS role_codes
         FROM users u
         LEFT JOIN LATERAL (
           SELECT string_agg(r.code, ', ' ORDER BY r.code) AS role_codes
           FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id
         ) user_role ON TRUE
         WHERE EXISTS (
           SELECT 1 FROM user_roles member_role JOIN roles member ON member.id = member_role.role_id
           WHERE member_role.user_id = u.id AND member.code = 'member'
         )
           AND NOT EXISTS (
             SELECT 1 FROM user_roles staff_role JOIN roles staff ON staff.id = staff_role.role_id
             WHERE staff_role.user_id = u.id AND staff.code IN ('super_admin', 'admin', 'membership')
           )
           AND ($1 = 'all' OR u.status = $1)
           AND ($2 = '' OR u.full_name ILIKE '%' || $2 || '%'
                OR u.email ILIKE '%' || $2 || '%'
                OR COALESCE(u.organization, '') ILIKE '%' || $2 || '%'
                OR COALESCE(u.profession, '') ILIKE '%' || $2 || '%')
         ORDER BY u.created_at DESC
         LIMIT $3 OFFSET $4`,
        [status, search, PAGE_SIZE, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended
         FROM users u
         WHERE EXISTS (
           SELECT 1 FROM user_roles member_role JOIN roles member ON member.id = member_role.role_id
           WHERE member_role.user_id = u.id AND member.code = 'member'
         )
           AND NOT EXISTS (
             SELECT 1 FROM user_roles staff_role JOIN roles staff ON staff.id = staff_role.role_id
             WHERE staff_role.user_id = u.id AND staff.code IN ('super_admin', 'admin', 'membership')
           )`
      )
    ]);
    const counts = countResult.rows[0];
    const filteredCount = await pool.query(
      `SELECT COUNT(*)::int AS total FROM users u
       WHERE EXISTS (
         SELECT 1 FROM user_roles member_role JOIN roles member ON member.id = member_role.role_id
         WHERE member_role.user_id = u.id AND member.code = 'member'
       )
         AND NOT EXISTS (
           SELECT 1 FROM user_roles staff_role JOIN roles staff ON staff.id = staff_role.role_id
           WHERE staff_role.user_id = u.id AND staff.code IN ('super_admin', 'admin', 'membership')
         )
         AND ($1 = 'all' OR u.status = $1)
         AND ($2 = '' OR u.full_name ILIKE '%' || $2 || '%'
              OR u.email ILIKE '%' || $2 || '%'
              OR COALESCE(u.organization, '') ILIKE '%' || $2 || '%'
              OR COALESCE(u.profession, '') ILIKE '%' || $2 || '%')`,
      [status, search]
    );
    return response.json({
      users: usersResult.rows.map((user) => ({
        id: user.id,
        memberNumber: user.member_number,
        fullName: user.full_name,
        email: user.email,
        organization: user.organization,
        profession: user.profession,
        status: user.status,
        createdAt: user.created_at,
        roleCodes: user.role_codes.split(', ').filter(Boolean),
        hasPhoto: Boolean(user.member_photo_path)
      })),
      counts,
      total: filteredCount.rows[0].total,
      page,
      pageSize: PAGE_SIZE
    });
  });

  app.post('/api/admin/users', requireSameOrigin, requireAdmin, upload.single('memberPhoto'), async (request, response) => {
    const fullName = typeof request.body.fullName === 'string' ? request.body.fullName.trim() : '';
    const email = typeof request.body.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    const organization = typeof request.body.organization === 'string' ? request.body.organization.trim() : '';
    const profession = typeof request.body.profession === 'string' ? request.body.profession.trim() : '';
    const password = typeof request.body.password === 'string' ? request.body.password : '';
    const status = typeof request.body.status === 'string' ? request.body.status : 'pending';
    const validation = validateMemberProfile({ fullName, email, organization, profession });
    if (validation) return response.status(400).json(validation);
    if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
      return response.status(400).json({ field: 'password', error: 'Password harus minimal 8 karakter dan maksimal 72 byte.' });
    }
    if (!['pending', 'active'].includes(status)) return response.status(400).json({ field: 'status', error: 'Status awal tidak valid.' });

    const savedPhoto = await saveMemberPhoto(request.file, photoDirectory, projectRoot);
    if (savedPhoto.error) return response.status(400).json({ field: 'memberPhoto', error: savedPhoto.error });
    const passwordHash = await bcrypt.hash(password, 12);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userResult = await client.query(
        `INSERT INTO users (full_name, email, password_hash, organization, profession, member_photo_path, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, member_number, full_name, email, organization, profession, status, created_at`,
        [fullName, email, passwordHash, organization || null, profession || null, savedPhoto.stored?.relativePath || null, status]
      );
      const user = userResult.rows[0];
      const roleResult = await client.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, id FROM roles WHERE code = 'member'
         RETURNING user_id`,
        [user.id]
      );
      if (roleResult.rowCount !== 1) throw new Error('Role member belum tersedia. Jalankan database.sql.');
      await client.query('COMMIT');
      return response.status(201).json({ user: { ...user, memberNumber: user.member_number, fullName: user.full_name, createdAt: user.created_at } });
    } catch (error) {
      await client.query('ROLLBACK');
      if (savedPhoto.stored) await removeMemberPhoto(photoDirectory, savedPhoto.stored.relativePath);
      if (error.code === '23505') return response.status(409).json({ field: 'email', error: 'Email tersebut sudah terdaftar.' });
      throw error;
    } finally {
      client.release();
    }
  });

  app.put('/api/admin/users/:id', requireSameOrigin, requireAdmin, upload.single('memberPhoto'), async (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) return response.status(400).json({ error: 'ID pengguna tidak valid.' });
    const fullName = typeof request.body.fullName === 'string' ? request.body.fullName.trim() : '';
    const email = typeof request.body.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    const organization = typeof request.body.organization === 'string' ? request.body.organization.trim() : '';
    const profession = typeof request.body.profession === 'string' ? request.body.profession.trim() : '';
    const password = typeof request.body.password === 'string' ? request.body.password : '';
    const validation = validateMemberProfile({ fullName, email, organization, profession });
    if (validation) return response.status(400).json(validation);
    if (password && (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72)) {
      return response.status(400).json({ field: 'password', error: 'Password harus minimal 8 karakter dan maksimal 72 byte.' });
    }

    const savedPhoto = await saveMemberPhoto(request.file, photoDirectory, projectRoot);
    if (savedPhoto.error) return response.status(400).json({ field: 'memberPhoto', error: savedPhoto.error });
    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    const client = await pool.connect();
    let oldPhotoPath = null;
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT u.member_photo_path FROM users u
         WHERE u.id = $1 AND EXISTS (
           SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id AND r.code = 'member'
         ) AND NOT EXISTS (
           SELECT 1 FROM user_roles staff_role JOIN roles staff ON staff.id = staff_role.role_id
           WHERE staff_role.user_id = u.id AND staff.code IN ('super_admin', 'admin', 'membership')
         ) FOR UPDATE`,
        [request.params.id]
      );
      if (!existing.rowCount) {
        await client.query('ROLLBACK');
        if (savedPhoto.stored) await removeMemberPhoto(photoDirectory, savedPhoto.stored.relativePath);
        return response.status(404).json({ error: 'Anggota tidak ditemukan.' });
      }
      oldPhotoPath = existing.rows[0].member_photo_path;
      const userResult = await client.query(
        `UPDATE users SET full_name = $1, email = $2, organization = $3, profession = $4,
         member_photo_path = COALESCE($5, member_photo_path),
         password_hash = COALESCE($6, password_hash)
         WHERE id = $7
         RETURNING id, member_number, full_name, email, organization, profession, status, created_at`,
        [fullName, email, organization || null, profession || null, savedPhoto.stored?.relativePath || null, passwordHash, request.params.id]
      );
      if (passwordHash) {
        await client.query(
          'UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL',
          [request.params.id]
        );
      }
      await client.query('COMMIT');
      if (savedPhoto.stored && oldPhotoPath) await removeMemberPhoto(photoDirectory, oldPhotoPath);
      const user = userResult.rows[0];
      return response.json({ user: { ...user, memberNumber: user.member_number, fullName: user.full_name, createdAt: user.created_at } });
    } catch (error) {
      await client.query('ROLLBACK');
      if (savedPhoto.stored) await removeMemberPhoto(photoDirectory, savedPhoto.stored.relativePath);
      if (error.code === '23505') return response.status(409).json({ field: 'email', error: 'Email tersebut sudah terdaftar.' });
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete('/api/admin/users/:id', requireSameOrigin, requireAdmin, async (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) return response.status(400).json({ error: 'ID pengguna tidak valid.' });
    const client = await pool.connect();
    let memberPhotoPath;
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT u.member_photo_path FROM users u
         WHERE u.id = $1 AND EXISTS (
           SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id AND r.code = 'member'
         ) AND NOT EXISTS (
           SELECT 1 FROM user_roles staff_role JOIN roles staff ON staff.id = staff_role.role_id
           WHERE staff_role.user_id = u.id AND staff.code IN ('super_admin', 'admin', 'membership')
         ) FOR UPDATE`,
        [request.params.id]
      );
      if (!existing.rowCount) {
        await client.query('ROLLBACK');
        return response.status(404).json({ error: 'Anggota tidak ditemukan.' });
      }
      memberPhotoPath = existing.rows[0].member_photo_path;
      await client.query('DELETE FROM users WHERE id = $1', [request.params.id]);
      await client.query('COMMIT');
      await removeMemberPhoto(photoDirectory, memberPhotoPath);
      return response.json({ ok: true });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/api/admin/users/:id/photo', requireAdmin, async (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) return response.status(400).json({ error: 'ID pengguna tidak valid.' });
    const result = await pool.query('SELECT member_photo_path FROM users WHERE id = $1', [request.params.id]);
    if (!result.rowCount || !result.rows[0].member_photo_path) return response.status(404).json({ error: 'Foto tidak ditemukan.' });
    const filename = path.basename(result.rows[0].member_photo_path.replaceAll('\\', '/'));
    const photoPath = path.resolve(photoDirectory, filename);
    if (!photoPath.startsWith(`${photoDirectory}${path.sep}`)) return response.status(404).json({ error: 'Foto tidak ditemukan.' });
    return response.sendFile(photoPath, (error) => {
      if (error && !response.headersSent) response.status(404).json({ error: 'Foto tidak ditemukan.' });
    });
  });

  // Ambil data anggota aktif untuk QR KTA, rekam payload-nya di kta_qr_codes.
  // Mengembalikan null (dan sudah mengirim response error) bila anggota tidak berhak.
  async function prepareMemberKtaQr(request, response) {
    if (!UUID_PATTERN.test(request.params.id)) {
      response.status(400).json({ error: 'ID pengguna tidak valid.' });
      return null;
    }
    const member = await pool.query(
      `SELECT u.id, u.member_number FROM users u
       WHERE u.id = $1 AND u.status = 'active' AND EXISTS (
         SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = u.id AND r.code = 'member'
       )`,
      [request.params.id]
    );
    if (!member.rowCount) {
      response.status(404).json({ error: 'QR hanya tersedia untuk anggota aktif.' });
      return null;
    }
    const baseUrl = process.env.PUBLIC_BASE_URL || `${request.protocol}://${request.get('host')}`;
    const verificationUrl = new URL(`/verify/${member.rows[0].id}`, baseUrl).toString();
    const record = await upsertKtaQr(pool, member.rows[0].id, verificationUrl);
    return { verificationUrl, record, memberNumber: member.rows[0].member_number };
  }

  app.get('/api/admin/users/:id/qr', requireAdmin, async (request, response) => {
    const prepared = await prepareMemberKtaQr(request, response);
    if (!prepared) return;
    const qrBuffer = await renderKtaQrPng(prepared.verificationUrl, { projectRoot });
    return response.json({
      verificationUrl: prepared.verificationUrl,
      qrDataUrl: ktaQrDataUrl(qrBuffer),
      qr: { id: prepared.record.id, issuedAt: prepared.record.issued_at, updatedAt: prepared.record.updated_at }
    });
  });

  app.get('/api/admin/users/:id/qr/download', requireAdmin, async (request, response) => {
    const prepared = await prepareMemberKtaQr(request, response);
    if (!prepared) return;
    const qrBuffer = await renderKtaQrPng(prepared.verificationUrl, { projectRoot, width: KTA_QR_DOWNLOAD_WIDTH });
    response.set('Content-Type', 'image/png');
    response.set('Content-Disposition', `attachment; filename="${ktaQrFilename(prepared.memberNumber)}"`);
    response.set('Cache-Control', 'no-store');
    return response.send(qrBuffer);
  });

  app.patch('/api/admin/users/:id/status', requireSameOrigin, requireAdmin, async (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) return response.status(400).json({ error: 'ID pengguna tidak valid.' });
    const status = request.body?.status;
    if (!['active', 'suspended'].includes(status)) return response.status(400).json({ error: 'Status tujuan tidak valid.' });
    if (status === 'suspended' && request.params.id === request.admin.id) {
      return response.status(403).json({ error: 'Admin tidak dapat menangguhkan akun yang sedang digunakan.' });
    }
    const result = await pool.query(
      `UPDATE users SET status = $1
       WHERE id = $2 AND EXISTS (
         SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = users.id AND r.code = 'member'
       ) AND NOT EXISTS (
         SELECT 1 FROM user_roles staff_role JOIN roles staff ON staff.id = staff_role.role_id
         WHERE staff_role.user_id = users.id AND staff.code IN ('super_admin', 'admin', 'membership')
       )
       RETURNING id, full_name, email, status`,
      [status, request.params.id]
    );
    if (!result.rowCount) return response.status(404).json({ error: 'Pengguna tidak ditemukan.' });
    return response.json({ user: result.rows[0] });
  });
}