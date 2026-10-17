import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  ADMIN_SESSION_COOKIE, createSession, isStaff, loadUserById, requireAuth, revokeUserSessions, serializeUser, tokenHash
} from '../auth.js';
import { pool, withTransaction } from '../db.js';
import { verifyGoogleCredential } from '../google.js';
import {
  EMAIL_PATTERN, HttpError, badRequest, conflict, forbidden, isValidPhone, normalizePhone, sendData, str
} from '../http.js';

const isTest = process.env.NODE_ENV === 'test';
const limiter = (limit) => rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTest ? 10_000 : limit,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_request, response) => response.status(429).json({
    error: 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.'
  })
});

const registrationLimit = limiter(10);
const loginLimit = limiter(10);

function validatePassword(password, field = 'password') {
  if (typeof password !== 'string' || password.length < 6) {
    throw badRequest('Password minimal 6 karakter.', field);
  }
  if (Buffer.byteLength(password, 'utf8') > 72) throw badRequest('Password maksimal 72 byte.', field);
  return password;
}

async function findAccount(identifier) {
  const isPhone = !identifier.includes('@');
  const value = isPhone ? normalizePhone(identifier) : identifier.toLowerCase();
  const result = await pool.query(
    `SELECT id, password_hash, status FROM users
     WHERE ${isPhone ? 'phone = $1' : 'lower(email) = $1'}
     LIMIT 1`,
    [value]
  );
  return { account: result.rows[0], isPhone };
}

async function authenticateCredentials(body) {
  const field = body?.identifier === undefined && body?.email !== undefined ? 'email' : 'identifier';
  const identifier = str(body, field, { required: true, label: 'Email/No. HP', max: 254 });
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!password) throw badRequest('Password wajib diisi.', 'password');
  if (Buffer.byteLength(password, 'utf8') > 72) throw new HttpError(401, 'Email/No. HP atau password salah.');

  const { account, isPhone } = await findAccount(identifier);
  if (!account) {
    throw new HttpError(401, isPhone
      ? 'No. HP belum terdaftar. Silakan daftar terlebih dahulu.'
      : 'Email belum terdaftar. Silakan daftar terlebih dahulu.', { field: 'identifier' });
  }
  if (!account.password_hash) {
    throw new HttpError(401, 'Akun ini terdaftar lewat Google. Silakan masuk dengan tombol Google.', { field: 'identifier' });
  }
  if (!(await bcrypt.compare(password, account.password_hash))) {
    throw new HttpError(401, 'Password salah.', { field: 'password' });
  }
  if (account.status === 'pending') throw forbidden('Akun Anda masih menunggu persetujuan admin.');
  if (account.status !== 'active') throw forbidden('Akun Anda dinonaktifkan. Hubungi admin IDTC.');
  return account;
}

export function authRoutes() {
  const router = Router();

  router.post('/auth/register', registrationLimit, async (request, response) => {
    const body = request.body || {};
    const name = str(body, 'name', { required: true, label: 'Nama', max: 150 });
    const email = str(body, 'email', { required: true, label: 'Email', max: 254 })?.toLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw badRequest('Format email tidak valid.', 'email');
    const rawPhone = str(body, 'phone', { label: 'No. HP', max: 20 });
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    if (phone && !isValidPhone(phone)) throw badRequest('Format No. HP tidak valid.', 'phone');
    const password = validatePassword(body.password);
    const confirmation = body.passwordConfirmation;
    if (confirmation !== undefined && confirmation !== password) {
      throw badRequest('Konfirmasi password tidak cocok.', 'passwordConfirmation');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    try {
      const result = await withTransaction(async (client) => {
        const inserted = await client.query(
          `INSERT INTO users (full_name, email, phone, password_hash)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [name, email, phone, passwordHash]
        );
        const userId = inserted.rows[0].id;
        await client.query(
          `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'calon_sahabat'`,
          [userId]
        );
        const session = await createSession(client, userId, { deviceName: body.deviceName });
        return { userId, token: session.token };
      });
      const user = await loadUserById(result.userId);
      return sendData(response, { token: result.token, user: serializeUser(request, user) }, undefined, 201);
    } catch (error) {
      if (error.code === '23505') {
        if (String(error.constraint).includes('phone')) throw conflict('No. HP sudah terdaftar. Silakan login.', 'phone');
        throw conflict('Email sudah terdaftar. Silakan login.', 'email');
      }
      throw error;
    }
  });

  router.post('/auth/login', loginLimit, async (request, response) => {
    const account = await authenticateCredentials(request.body);
    const session = await createSession(pool, account.id, { deviceName: request.body?.deviceName });
    const user = await loadUserById(account.id);
    return sendData(response, { token: session.token, user: serializeUser(request, user) });
  });

  // Sign in with Google: akun ditautkan lewat `sub` Google (oauth_identities), bukan email. Email Google yang sudah
  // terverifikasi boleh ditautkan ke akun email/HP yang sudah ada; bila belum ada, akun baru dibuat tanpa password.
  router.post('/auth/google', loginLimit, async (request, response) => {
    const body = request.body || {};
    const google = await verifyGoogleCredential({ idToken: body.idToken, accessToken: body.accessToken });
    if (!google.emailVerified) throw new HttpError(401, 'Email akun Google ini belum terverifikasi oleh Google.');

    const result = await withTransaction(async (client) => {
      let created = false;
      const linked = await client.query(
        `SELECT user_id FROM oauth_identities WHERE provider = 'google' AND provider_subject = $1`,
        [google.subject]
      );
      let userId = linked.rows[0]?.user_id;
      if (!userId) {
        const existing = await client.query('SELECT id FROM users WHERE lower(email) = $1 FOR UPDATE', [google.email]);
        userId = existing.rows[0]?.id;
        if (!userId) {
          const inserted = await client.query(
            `INSERT INTO users (full_name, email, photo_path, email_verified_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING id`,
            [(google.name || google.email.split('@')[0]).slice(0, 150), google.email, google.picture]
          );
          userId = inserted.rows[0].id;
          created = true;
          await client.query(
            `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'calon_sahabat'`,
            [userId]
          );
        }
        const identity = await client.query(
          `INSERT INTO oauth_identities (provider, provider_subject, user_id) VALUES ('google', $1, $2)
           ON CONFLICT DO NOTHING RETURNING id`,
          [google.subject, userId]
        );
        if (!identity.rowCount) throw conflict('Email ini sudah terhubung dengan akun Google lain.');
      }

      const account = await client.query(
        `UPDATE users SET email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP),
           photo_path = COALESCE(photo_path, $2)
         WHERE id = $1 RETURNING status`,
        [userId, google.picture]
      );
      const status = account.rows[0].status;
      if (status === 'pending') throw forbidden('Akun Anda masih menunggu persetujuan admin.');
      if (status !== 'active') throw forbidden('Akun Anda dinonaktifkan. Hubungi admin IDTC.');
      const session = await createSession(client, userId, { deviceName: body.deviceName });
      return { userId, created, token: session.token };
    });

    const user = await loadUserById(result.userId);
    return sendData(
      response,
      { token: result.token, user: serializeUser(request, user), isNewUser: result.created },
      undefined,
      result.created ? 201 : 200
    );
  });

  router.post('/auth/logout', requireAuth, async (request, response) => {
    await pool.query('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1', [request.session.id]);
    if (request.session.via === 'cookie') response.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });
    return response.status(204).end();
  });

  router.get('/auth/me', requireAuth, (request, response) => sendData(response, serializeUser(request, request.user)));

  router.put('/auth/password', requireAuth, async (request, response) => {
    const body = request.body || {};
    const password = validatePassword(body.password);
    if (body.passwordConfirmation !== undefined && body.passwordConfirmation !== password) {
      throw badRequest('Konfirmasi password tidak cocok.', 'passwordConfirmation');
    }
    const current = await pool.query('SELECT password_hash FROM users WHERE id = $1', [request.user.id]);
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    // Akun Google tanpa password boleh membuat password pertama tanpa password lama.
    const currentHash = current.rows[0].password_hash;
    if (currentHash && !(await bcrypt.compare(currentPassword, currentHash))) {
      throw badRequest('Password saat ini salah.', 'currentPassword');
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await withTransaction(async (client) => {
      await client.query(
        'UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
        [passwordHash, request.user.id]
      );
      await revokeUserSessions(client, request.user.id, request.session.tokenHash);
    });
    return sendData(response, { message: 'Password berhasil diubah.' });
  });

  // Login panel admin web: sesi disimpan di cookie HttpOnly (pola idtc-user).
  router.post('/admin/session', loginLimit, async (request, response) => {
    const origin = request.get('origin');
    if (!origin || new URL(origin).host !== request.get('host')) {
      throw forbidden('Permintaan lintas situs ditolak.');
    }
    const account = await authenticateCredentials(request.body);
    const user = await loadUserById(account.id);
    if (!isStaff(user)) throw forbidden('Akun ini tidak memiliki akses panel admin.');
    const session = await createSession(pool, account.id, { clientType: 'admin', deviceName: 'admin-web' });
    response.cookie(ADMIN_SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: session.duration,
      path: '/'
    });
    return sendData(response, { user: serializeUser(request, user) });
  });

  router.delete('/admin/session', async (request, response) => {
    const token = request.cookies?.[ADMIN_SESSION_COOKIE];
    if (token) {
      await pool.query(
        'UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = $1',
        [tokenHash(token)]
      );
    }
    response.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });
    return response.status(204).end();
  });

  return router;
}
