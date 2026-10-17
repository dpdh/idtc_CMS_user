import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  randomBytes,
  randomUUID
} from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { fileTypeFromBuffer } from 'file-type';
import helmet from 'helmet';
import multer from 'multer';
import pg from 'pg';
import { ensureBootstrapAdmin, registerAdminRoutes } from './admin.js';
import { KTA_QR_DOWNLOAD_WIDTH, ktaQrDataUrl, ktaQrFilename, renderKtaQrPng, upsertKtaQr } from './kta-qr.js';

dotenv.config();

const { Pool } = pg;
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const photoDirectory = path.resolve(projectRoot, process.env.UPLOAD_DIR || 'uploads/member-photos');
const pilotProjectUploadDirectory = path.resolve(projectRoot, 'uploads/pilot-projects');
const databaseUrl = process.env.DATABASE_URL;
const SESSION_COOKIE = 'idtc_admin_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AVATAR_IDS = new Set(['explorer', 'engineer', 'scientist', 'creator', 'pioneer', 'visionary']);
const allowedPhotoTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 6, parts: 7 }
});
const pilotProjectPostUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4, parts: 5 }
});
const pilotProjectUploadTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['application/pdf', 'pdf']
]);
const registrationLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false
});
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false
});
const socialLoginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});
const greetingLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_request, response) => response.status(429).json({
    error: 'Terlalu banyak mengirim sapaan. Coba lagi dalam 15 menit.'
  })
});
const pilotProjectActivityLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_request, response) => response.status(429).json({
    error: 'Terlalu banyak aktivitas project. Coba lagi dalam 15 menit.'
  })
});
const pool = new Pool({ connectionString: databaseUrl });
const oauthJwksCache = new Map();
const OAUTH_PROVIDERS = ['google', 'facebook', 'instagram', 'apple'];
const OAUTH_CALLBACKS = Object.fromEntries(
  OAUTH_PROVIDERS.map((provider) => [provider, `/auth/${provider}/callback`])
);

function getOAuthConfig(provider) {
  const config = {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET
    },
    facebook: {
      clientId: process.env.FACEBOOK_APP_ID,
      clientSecret: process.env.FACEBOOK_APP_SECRET,
      graphVersion: process.env.FACEBOOK_GRAPH_VERSION || 'v26.0'
    },
    instagram: {
      clientId: process.env.INSTAGRAM_APP_ID,
      clientSecret: process.env.INSTAGRAM_APP_SECRET
    },
    apple: {
      clientId: process.env.APPLE_CLIENT_ID,
      teamId: process.env.APPLE_TEAM_ID,
      keyId: process.env.APPLE_KEY_ID,
      privateKey: process.env.APPLE_PRIVATE_KEY?.replaceAll('\\n', '\n')
    }
  }[provider];
  if (!config) return null;
  const configured = provider === 'apple'
    ? Boolean(config.clientId && config.teamId && config.keyId && config.privateKey)
    : Boolean(config.clientId && config.clientSecret);
  return { ...config, configured };
}

function oauthCallbackUrl(provider) {
  const base = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const url = new URL(OAUTH_CALLBACKS[provider], base);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('PUBLIC_BASE_URL must use HTTPS for social login in production.');
  }
  return url.toString();
}

function oauthErrorRedirect(response, error) {
  return response.redirect(`/?auth_error=${encodeURIComponent(error)}`);
}

async function ensureOAuthSchema() {
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_id VARCHAR(30) NOT NULL DEFAULT 'explorer'
     CHECK (avatar_id IN ('explorer', 'engineer', 'scientist', 'creator', 'pioneer', 'visionary'))`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS oauth_identities (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       provider VARCHAR(20) NOT NULL CHECK (provider IN ('google', 'facebook', 'instagram', 'apple')),
       provider_subject VARCHAR(255) NOT NULL,
       user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       UNIQUE (provider, provider_subject),
       UNIQUE (user_id, provider)
     )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS oauth_states (
       state_hash CHAR(64) PRIMARY KEY,
       provider VARCHAR(20) NOT NULL CHECK (provider IN ('google', 'facebook', 'instagram', 'apple')),
       nonce_hash CHAR(64),
       link_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       expires_at TIMESTAMPTZ NOT NULL
     )`
  );
  await pool.query('CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON oauth_states (expires_at)');
}

async function ensureKtaQrSchema() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS kta_qr_codes (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
       payload TEXT NOT NULL CHECK (length(btrim(payload)) > 0),
       issued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`
  );
  await pool.query('CREATE INDEX IF NOT EXISTS kta_qr_codes_issued_at_idx ON kta_qr_codes (issued_at DESC)');
}

async function ensureCollaborationSchema() {
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS profession VARCHAR(180)');
  await pool.query(
    `UPDATE users u
     SET profession = application.profession
     FROM (
       SELECT DISTINCT ON (application.user_id)
              application.user_id, NULLIF(BTRIM(field.value), '') AS profession
       FROM member_applications application
       CROSS JOIN LATERAL jsonb_each_text(
         CASE WHEN jsonb_typeof(application.response_data) = 'object'
              THEN application.response_data ELSE '{}'::jsonb END
       ) AS field(key, value)
       WHERE application.user_id IS NOT NULL
         AND lower(field.key) LIKE 'jabatan / posisi%'
         AND NULLIF(BTRIM(field.value), '') IS NOT NULL
       ORDER BY application.user_id, application.imported_at DESC, application.id DESC
     ) application
     WHERE u.id = application.user_id
       AND NULLIF(BTRIM(u.profession), '') IS NULL`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS pilot_project_groups (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       name VARCHAR(120) NOT NULL CHECK (length(btrim(name)) > 0),
       focus VARCHAR(180) NOT NULL CHECK (length(btrim(focus)) > 0),
       description VARCHAR(1000) NOT NULL DEFAULT '',
       project_manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
       created_by UUID REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`
  );
  await pool.query(
    'ALTER TABLE pilot_project_groups ADD COLUMN IF NOT EXISTS project_manager_id UUID REFERENCES users(id) ON DELETE SET NULL'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS pilot_project_groups_created_at_idx ON pilot_project_groups (created_at DESC)'
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS pilot_project_group_members (
       group_id UUID NOT NULL REFERENCES pilot_project_groups(id) ON DELETE CASCADE,
       user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (group_id, user_id)
     )`
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS pilot_project_group_members_user_id_idx ON pilot_project_group_members (user_id)'
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS pilot_project_posts (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       group_id UUID NOT NULL REFERENCES pilot_project_groups(id) ON DELETE CASCADE,
       author_id UUID REFERENCES users(id) ON DELETE SET NULL,
       content VARCHAR(2000) NOT NULL DEFAULT '',
       link_url VARCHAR(2000),
       media_filename VARCHAR(100),
       media_type VARCHAR(100),
       media_name VARCHAR(255),
       created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CHECK (length(btrim(content)) > 0 OR link_url IS NOT NULL OR media_filename IS NOT NULL)
     )`
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS pilot_project_posts_group_created_idx ON pilot_project_posts (group_id, created_at DESC)'
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS pilot_project_post_likes (
       post_id UUID NOT NULL REFERENCES pilot_project_posts(id) ON DELETE CASCADE,
       user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (post_id, user_id)
     )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS pilot_project_post_comments (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       post_id UUID NOT NULL REFERENCES pilot_project_posts(id) ON DELETE CASCADE,
       author_id UUID REFERENCES users(id) ON DELETE SET NULL,
       content VARCHAR(1000) NOT NULL CHECK (length(btrim(content)) > 0),
       created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS pilot_project_post_comments_post_created_idx ON pilot_project_post_comments (post_id, created_at)'
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS member_greetings (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       reaction VARCHAR(20) NOT NULL CHECK (reaction IN ('love', 'flower', 'crown')),
       message VARCHAR(240) NOT NULL DEFAULT '',
       created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CHECK (sender_id <> recipient_id)
     )`
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS member_greetings_created_at_idx ON member_greetings (created_at DESC)'
  );
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function decodeJwtPart(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

async function getJwks(uri, provider) {
  const cached = oauthJwksCache.get(provider);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetch(uri, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Failed to retrieve ${provider} signing keys.`);
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new Error(`Invalid ${provider} signing keys response.`);
  oauthJwksCache.set(provider, { keys: body.keys, expiresAt: Date.now() + 60 * 60 * 1000 });
  return body.keys;
}

async function verifyOidcToken(token, { provider, jwksUrl, issuer, audience, nonceHash, algorithms }) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid identity token.');
  const header = decodeJwtPart(parts[0]);
  const claims = decodeJwtPart(parts[1]);
  if (!algorithms.includes(header.alg) || typeof header.kid !== 'string') {
    throw new Error('Unsupported identity token signature.');
  }
  const keys = await getJwks(jwksUrl, provider);
  const jwk = keys.find((key) => key.kid === header.kid && (!key.alg || key.alg === header.alg));
  if (!jwk) throw new Error('Identity token signing key not found.');
  const signedContent = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const verifier = createVerify(header.alg === 'RS256' ? 'RSA-SHA256' : 'sha256');
  verifier.update(signedContent);
  verifier.end();
  const validSignature = verifier.verify(
    header.alg === 'ES256'
      ? { key: publicKey, dsaEncoding: 'ieee-p1363' }
      : publicKey,
    signature
  );
  const now = Math.floor(Date.now() / 1000);
  const validAudience = Array.isArray(claims.aud)
    ? claims.aud.includes(audience)
    : claims.aud === audience;
  if (!validSignature || claims.iss !== issuer || !validAudience ||
      (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== audience) ||
      !Number.isFinite(claims.exp) || claims.exp <= now ||
      (claims.nbf && claims.nbf > now) ||
      typeof claims.sub !== 'string' || !claims.sub ||
      tokenHash(String(claims.nonce || '')) !== nonceHash) {
    throw new Error('Identity token verification failed.');
  }
  return claims;
}

function createAppleClientSecret(config) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: config.teamId,
    iat: now,
    exp: now + 300,
    aud: 'https://appleid.apple.com',
    sub: config.clientId
  })).toString('base64url');
  const unsigned = `${header}.${claims}`;
  const signer = createSign('SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign({
    key: createPrivateKey(config.privateKey),
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  return `${unsigned}.${signature}`;
}

async function postForm(url, values) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(10000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error_description || body.error || 'OAuth token exchange failed.');
  return body;
}

async function getFacebookAccessToken(config, code, callbackUrl) {
  const url = new URL(`https://graph.facebook.com/${encodeURIComponent(config.graphVersion)}/oauth/access_token`);
  url.search = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: callbackUrl
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || 'Facebook token exchange failed.');
  return body;
}

async function getJson(url, accessToken) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || body.error_description || 'OAuth profile request failed.');
  return body;
}

async function getOAuthIdentity(provider, code, callbackUrl, nonceHash) {
  const config = getOAuthConfig(provider);
  let tokenResponse;
  if (provider === 'google') {
    tokenResponse = await postForm('https://oauth2.googleapis.com/token', {
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code'
    });
    if (typeof tokenResponse.id_token !== 'string') throw new Error('Google did not return an identity token.');
    const claims = await verifyOidcToken(tokenResponse.id_token, {
      provider,
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      issuer: 'https://accounts.google.com',
      audience: config.clientId,
      nonceHash,
      algorithms: ['RS256']
    });
    return { subject: claims.sub };
  }

  if (provider === 'facebook') {
    const graphUrl = `https://graph.facebook.com/${encodeURIComponent(config.graphVersion)}`;
    tokenResponse = await getFacebookAccessToken(config, code, callbackUrl);
    if (typeof tokenResponse.access_token !== 'string') throw new Error('Facebook did not return an access token.');
    const profile = await getJson(
      `${graphUrl}/me?fields=id`,
      tokenResponse.access_token
    );
    if (typeof profile.id !== 'string' || !profile.id) throw new Error('Facebook profile ID is missing.');
    return { subject: profile.id };
  }

  if (provider === 'instagram') {
    tokenResponse = await postForm('https://api.instagram.com/oauth/access_token', {
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code'
    });
    if (typeof tokenResponse.access_token !== 'string') throw new Error('Instagram did not return an access token.');
    const profile = await getJson(
      `https://graph.instagram.com/me?fields=user_id,username&access_token=${encodeURIComponent(tokenResponse.access_token)}`,
      tokenResponse.access_token
    );
    const subject = profile.user_id || profile.id;
    if (typeof subject !== 'string' && typeof subject !== 'number') {
      throw new Error('Instagram profile ID is missing.');
    }
    return { subject: String(subject), email: null };
  }

  tokenResponse = await postForm('https://appleid.apple.com/auth/token', {
    code,
    client_id: config.clientId,
    client_secret: createAppleClientSecret(config),
    redirect_uri: callbackUrl,
    grant_type: 'authorization_code'
  });
  if (typeof tokenResponse.id_token !== 'string') throw new Error('Apple did not return an identity token.');
  const claims = await verifyOidcToken(tokenResponse.id_token, {
    provider,
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    issuer: 'https://appleid.apple.com',
    audience: config.clientId,
    nonceHash,
    algorithms: ['RS256']
  });
  return { subject: claims.sub };
}

function requireSameOrigin(request, response, next) {
  const origin = request.get('origin');
  if (!origin) return response.status(403).json({ error: 'Permintaan lintas situs ditolak.' });
  try {
    if (new URL(origin).host !== request.get('host')) {
      return response.status(403).json({ error: 'Permintaan lintas situs ditolak.' });
    }
  } catch {
    return response.status(403).json({ error: 'Permintaan lintas situs ditolak.' });
  }
  return next();
}

async function findAuthenticatedUser(token) {
  const result = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.member_number, u.organization, u.profession, u.status, u.avatar_id,
            u.created_at, u.member_photo_path IS NOT NULL AS has_photo, u.must_change_password,
            COALESCE(array_agg(DISTINCT r.code ORDER BY r.code)
              FILTER (WHERE r.code IS NOT NULL), ARRAY[]::varchar[]) AS role_codes
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > CURRENT_TIMESTAMP
       AND u.status = 'active'
     GROUP BY u.id
     LIMIT 1`,
    [tokenHash(token)]
  );
  const user = result.rows[0];
  if (!user) return null;
  return {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    memberNumber: user.member_number,
    organization: user.organization,
    profession: user.profession,
    status: user.status,
    avatarId: user.avatar_id,
    createdAt: user.created_at,
    hasPhoto: user.has_photo,
    mustChangePassword: user.must_change_password,
    roleCodes: user.role_codes
  };
}

function requirePasswordChangeComplete(user, response) {
  if (!user.mustChangePassword) return true;
  response.status(403).json({ error: 'Ganti kata sandi sebelum melanjutkan.', mustChangePassword: true });
  return false;
}

async function ensureMemberPasswordChangeSchema() {
  await pool.query(
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE'
  );
}

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());

app.get('/', (_request, response) => response.sendFile(path.join(projectRoot, 'index.html')));
app.get('/assets/img/IDTC_logo.png', (_request, response) => response.sendFile(path.join(projectRoot, 'assets', 'img', 'IDTC_logo.png')));
app.get('/assets/img/Id_f_01.png', (_request, response) => response.sendFile(path.join(projectRoot, 'assets', 'img', 'Id_f_01.png')));
app.get('/assets/img/id_b_02.png', (_request, response) => response.sendFile(path.join(projectRoot, 'assets', 'img', 'id_b_02.png')));
app.get('/style.css', (_request, response) => response.sendFile(path.join(projectRoot, 'style.css')));
app.get('/script.js', (_request, response) => response.sendFile(path.join(projectRoot, 'script.js')));
app.get('/api/health', async (_request, response) => {
  await pool.query('SELECT 1');
  response.json({ status: 'ok' });
});

registerAdminRoutes(app, { pool, photoDirectory, projectRoot, upload });

app.post('/api/auth/login', requireSameOrigin, loginLimit, async (request, response) => {
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
      !password || Buffer.byteLength(password, 'utf8') > 72) {
    return response.status(400).json({ error: 'Masukkan email dan kata sandi yang valid.' });
  }

  const result = await pool.query(
    `SELECT u.id, u.password_hash, u.status, u.must_change_password,
            COALESCE(array_agg(DISTINCT r.code ORDER BY r.code)
              FILTER (WHERE r.code IS NOT NULL), ARRAY[]::varchar[]) AS role_codes
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE lower(u.email) = $1
     GROUP BY u.id
     LIMIT 1`,
    [email]
  );
  const account = result.rows[0];
  if (!account || !(await bcrypt.compare(password, account.password_hash))) {
    return response.status(401).json({ error: 'Email atau kata sandi salah.' });
  }
  if (account.status === 'pending') {
    return response.status(403).json({ error: 'Akun Anda masih menunggu persetujuan IDTC.' });
  }
  if (account.status !== 'active') {
    return response.status(403).json({ error: 'Akun Anda tidak aktif. Hubungi administrator IDTC.' });
  }
  if (!account.role_codes.length) {
    return response.status(403).json({ error: 'Akun belum memiliki akses portal. Hubungi administrator IDTC.' });
  }

  const token = randomBytes(32).toString('hex');
  const sessionDuration = request.body.remember === true ? 30 * 24 * 60 * 60 * 1000 : SESSION_DURATION_MS;
  const expiresAt = new Date(Date.now() + sessionDuration);
  await pool.query(
    'INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [account.id, tokenHash(token), expiresAt]
  );
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: sessionDuration,
    path: '/'
  });
  const user = await findAuthenticatedUser(token);
  return response.json({ user });
});

app.get('/api/auth/me', async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Sesi masuk tidak ditemukan.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  return response.json({ user });
});

app.get('/api/auth/collaboration', async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk melihat data kolaborasi.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;

  const result = await pool.query(
    `WITH members AS (
       SELECT u.organization, u.profession
       FROM users u
       WHERE u.status = 'active'
         AND EXISTS (
           SELECT 1 FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id AND r.code = 'member'
         )
     ),
     labels AS (
       SELECT 'organization' AS category, BTRIM(organization) AS name,
              lower(BTRIM(organization)) AS normalized_name
       FROM members
       WHERE NULLIF(BTRIM(organization), '') IS NOT NULL
       UNION ALL
       SELECT 'profession' AS category, BTRIM(profession) AS name,
              lower(BTRIM(profession)) AS normalized_name
       FROM members
       WHERE NULLIF(BTRIM(profession), '') IS NOT NULL
     )
     SELECT category, MIN(name) AS name, COUNT(*)::int AS count
     FROM labels
     GROUP BY category, normalized_name
     ORDER BY category, count DESC, name ASC`
  );
  const organization = [];
  const profession = [];
  for (const row of result.rows) {
    const value = { name: row.name, count: row.count };
    (row.category === 'organization' ? organization : profession).push(value);
  }
  response.set('Cache-Control', 'private, no-store');
  return response.json({
    organization,
    profession,
    totals: {
      organizations: organization.length,
      professions: profession.length
    }
  });
});

app.get('/api/auth/collaboration/greetings', async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk menyapa rekan anggota.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;

  const [membersResult, greetingsResult] = await Promise.all([
    pool.query(
      `SELECT u.id, u.full_name, u.organization
       FROM users u
       WHERE u.status = 'active'
         AND u.id <> $1
         AND EXISTS (
           SELECT 1 FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id AND r.code = 'member'
         )
         AND NOT EXISTS (
           SELECT 1 FROM user_roles staff_role
           JOIN roles staff ON staff.id = staff_role.role_id
           WHERE staff_role.user_id = u.id
             AND staff.code IN ('super_admin', 'admin', 'membership')
         )
       ORDER BY u.full_name`,
      [user.id]
    ),
    pool.query(
      `SELECT greeting.id, greeting.reaction, greeting.message, greeting.created_at,
              sender.full_name AS sender_name,
              recipient.full_name AS recipient_name
       FROM member_greetings greeting
       JOIN users sender ON sender.id = greeting.sender_id AND sender.status = 'active'
       JOIN users recipient ON recipient.id = greeting.recipient_id AND recipient.status = 'active'
       ORDER BY greeting.created_at DESC, greeting.id DESC
       LIMIT 40`
    )
  ]);
  response.set('Cache-Control', 'private, no-store');
  return response.json({
    members: membersResult.rows.map((member) => ({
      id: member.id,
      fullName: member.full_name,
      organization: member.organization
    })),
    greetings: greetingsResult.rows
  });
});

app.post('/api/auth/collaboration/greetings', requireSameOrigin, greetingLimit, async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk mengirim sapaan.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;

  const recipientId = typeof request.body?.recipientId === 'string' ? request.body.recipientId : '';
  const reaction = typeof request.body?.reaction === 'string' ? request.body.reaction : '';
  const message = typeof request.body?.message === 'string' ? request.body.message.trim() : '';
  if (!UUID_PATTERN.test(recipientId)) {
    return response.status(400).json({ field: 'recipientId', error: 'Pilih rekan anggota yang valid.' });
  }
  if (!['love', 'flower', 'crown'].includes(reaction)) {
    return response.status(400).json({ field: 'reaction', error: 'Pilih ikon love, bunga, atau mahkota.' });
  }
  if (message.length > 240) {
    return response.status(400).json({ field: 'message', error: 'Sapaan maksimal 240 karakter.' });
  }
  if (recipientId === user.id) {
    return response.status(400).json({ field: 'recipientId', error: 'Pilih rekan anggota selain diri sendiri.' });
  }

  const recipientResult = await pool.query(
    `SELECT u.id, u.full_name
     FROM users u
     WHERE u.id = $1 AND u.status = 'active'
       AND EXISTS (
         SELECT 1 FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = u.id AND r.code = 'member'
       )
       AND NOT EXISTS (
         SELECT 1 FROM user_roles staff_role
         JOIN roles staff ON staff.id = staff_role.role_id
         WHERE staff_role.user_id = u.id
           AND staff.code IN ('super_admin', 'admin', 'membership')
       )`,
    [recipientId]
  );
  if (!recipientResult.rowCount) {
    return response.status(404).json({ field: 'recipientId', error: 'Rekan anggota tidak ditemukan atau tidak aktif.' });
  }

  const result = await pool.query(
    `INSERT INTO member_greetings (sender_id, recipient_id, reaction, message)
     VALUES ($1, $2, $3, $4)
     RETURNING id, reaction, message, created_at`,
    [user.id, recipientId, reaction, message]
  );
  return response.status(201).json({
    greeting: {
      ...result.rows[0],
      sender_name: user.fullName,
      recipient_name: recipientResult.rows[0].full_name
    },
    message: 'Sapaan Anda berhasil dibagikan.'
  });
});

app.get('/api/auth/pilot-project-groups', async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk melihat group pilot project.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;
  const isAdmin = user.roleCodes.some((role) => ['super_admin', 'admin'].includes(role));
  const [groupsResult, assignmentsResult, membersResult] = await Promise.all([
    pool.query(
      `SELECT g.id, g.name, g.focus, g.description, g.created_at,
              creator.full_name AS created_by,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM user_roles creator_role
                  JOIN roles creator_role_name ON creator_role_name.id = creator_role.role_id
                  WHERE creator_role.user_id = creator.id
                    AND creator_role_name.code IN ('super_admin', 'admin')
                ) THEN 'admin'
                WHEN EXISTS (
                  SELECT 1 FROM user_roles creator_role
                  JOIN roles creator_role_name ON creator_role_name.id = creator_role.role_id
                  WHERE creator_role.user_id = creator.id
                    AND creator_role_name.code = 'member'
                ) THEN 'member'
                ELSE 'penggagas'
              END AS created_by_role,
              manager.id AS manager_id, manager.full_name AS manager_name,
              manager.profession AS manager_profession
       FROM pilot_project_groups g
       LEFT JOIN users creator ON creator.id = g.created_by
       LEFT JOIN users manager ON manager.id = g.project_manager_id
       ORDER BY g.created_at DESC, g.id`
    ),
    pool.query(
      `SELECT assignment.group_id, member.id, member.full_name, member.profession
       FROM pilot_project_group_members assignment
       JOIN users member ON member.id = assignment.user_id AND member.status = 'active'
       ORDER BY member.full_name`
    ),
    isAdmin
      ? pool.query(
        `SELECT u.id, u.full_name, u.profession, u.organization
         FROM users u
         WHERE u.status = 'active'
           AND EXISTS (
             SELECT 1 FROM user_roles ur
             JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = u.id AND r.code = 'member'
           )
           AND NOT EXISTS (
             SELECT 1 FROM user_roles staff_role
             JOIN roles staff ON staff.id = staff_role.role_id
             WHERE staff_role.user_id = u.id
               AND staff.code IN ('super_admin', 'admin', 'membership')
           )
         ORDER BY u.full_name`
      )
      : Promise.resolve({ rows: [] })
  ]);
  const membersByGroup = new Map();
  for (const member of assignmentsResult.rows) {
    const groupMembers = membersByGroup.get(member.group_id) || [];
    groupMembers.push({
      id: member.id,
      fullName: member.full_name,
      profession: member.profession
    });
    membersByGroup.set(member.group_id, groupMembers);
  }
  response.set('Cache-Control', 'private, no-store');
  return response.json({
    isAdmin,
    groups: groupsResult.rows.map((group) => ({
      id: group.id,
      name: group.name,
      focus: group.focus,
      description: group.description,
      created_at: group.created_at,
      created_by: group.created_by,
      created_by_role: group.created_by_role,
      projectManager: group.manager_id
        ? {
          id: group.manager_id,
          fullName: group.manager_name,
          profession: group.manager_profession
        }
        : null,
      members: membersByGroup.get(group.id) || []
    })),
    members: membersResult.rows.map((member) => ({
      id: member.id,
      fullName: member.full_name,
      profession: member.profession,
      organization: member.organization
    }))
  });
});

app.put('/api/auth/pilot-project-groups/:groupId/team', requireSameOrigin, async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk mengatur tim pilot project.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;
  if (!user.roleCodes.some((role) => ['super_admin', 'admin'].includes(role))) {
    return response.status(403).json({ error: 'Hanya admin yang dapat mengatur PM dan tim pilot project.' });
  }

  const groupId = request.params.groupId;
  const projectManagerId = request.body?.projectManagerId === '' || request.body?.projectManagerId === null
    ? null
    : request.body?.projectManagerId;
  const memberIds = request.body?.memberIds;
  if (!UUID_PATTERN.test(groupId)) {
    return response.status(400).json({ error: 'Group pilot project tidak valid.' });
  }
  if (projectManagerId !== null &&
      (typeof projectManagerId !== 'string' || !UUID_PATTERN.test(projectManagerId))) {
    return response.status(400).json({ field: 'projectManagerId', error: 'Pilih PM yang valid.' });
  }
  if (!Array.isArray(memberIds) || memberIds.length > 100 ||
      memberIds.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id)) ||
      new Set(memberIds).size !== memberIds.length) {
    return response.status(400).json({ field: 'memberIds', error: 'Daftar anggota tim tidak valid.' });
  }

  const assignedIds = [...new Set([...memberIds, ...(projectManagerId ? [projectManagerId] : [])])];
  if (assignedIds.length) {
    const eligibleMembers = await pool.query(
      `SELECT u.id
       FROM users u
       WHERE u.id = ANY($1::uuid[]) AND u.status = 'active'
         AND EXISTS (
           SELECT 1 FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id AND r.code = 'member'
         )
         AND NOT EXISTS (
           SELECT 1 FROM user_roles staff_role
           JOIN roles staff ON staff.id = staff_role.role_id
           WHERE staff_role.user_id = u.id
             AND staff.code IN ('super_admin', 'admin', 'membership')
         )`,
      [assignedIds]
    );
    if (eligibleMembers.rowCount !== assignedIds.length) {
      return response.status(400).json({ error: 'PM dan anggota tim harus dipilih dari anggota aktif.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const groupResult = await client.query(
      'UPDATE pilot_project_groups SET project_manager_id = $1 WHERE id = $2 RETURNING id',
      [projectManagerId, groupId]
    );
    if (!groupResult.rowCount) {
      await client.query('ROLLBACK');
      return response.status(404).json({ error: 'Group pilot project tidak ditemukan.' });
    }
    await client.query('DELETE FROM pilot_project_group_members WHERE group_id = $1', [groupId]);
    if (memberIds.length) {
      await client.query(
        `INSERT INTO pilot_project_group_members (group_id, user_id)
         SELECT $1, selected.user_id FROM unnest($2::uuid[]) AS selected(user_id)`,
        [groupId, memberIds]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return response.json({ message: 'PM dan tim pilot project berhasil diperbarui.' });
});

app.get('/api/auth/pilot-project-groups/:groupId/posts', async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk melihat aktivitas pilot project.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;
  const { groupId } = request.params;
  if (!UUID_PATTERN.test(groupId)) {
    return response.status(400).json({ error: 'Group pilot project tidak valid.' });
  }
  const groupResult = await pool.query('SELECT id FROM pilot_project_groups WHERE id = $1', [groupId]);
  if (!groupResult.rowCount) return response.status(404).json({ error: 'Group pilot project tidak ditemukan.' });
  const postsResult = await pool.query(
    `SELECT post.id, post.content, post.link_url, post.media_filename, post.media_type,
            post.media_name, post.created_at, author.full_name AS author_name,
            author.profession AS author_profession,
            (SELECT COUNT(*)::int FROM pilot_project_post_likes likes WHERE likes.post_id = post.id) AS like_count,
            EXISTS (
              SELECT 1 FROM pilot_project_post_likes likes
              WHERE likes.post_id = post.id AND likes.user_id = $2
            ) AS liked_by_me
     FROM pilot_project_posts post
     LEFT JOIN users author ON author.id = post.author_id
     WHERE post.group_id = $1
     ORDER BY post.created_at DESC, post.id DESC
     LIMIT 50`,
    [groupId, user.id]
  );
  const postIds = postsResult.rows.map((post) => post.id);
  const commentsResult = postIds.length
    ? await pool.query(
      `WITH recent_comments AS (
         SELECT pc.id, pc.post_id, pc.content, pc.created_at,
                author.full_name AS author_name,
                ROW_NUMBER() OVER (PARTITION BY pc.post_id ORDER BY pc.created_at DESC, pc.id DESC) AS position
         FROM pilot_project_post_comments pc
         LEFT JOIN users author ON author.id = pc.author_id
         WHERE pc.post_id = ANY($1::uuid[])
       )
       SELECT id, post_id, content, created_at, author_name
       FROM recent_comments
       WHERE position <= 10
       ORDER BY post_id, created_at`,
      [postIds]
    )
    : { rows: [] };
  const commentsByPost = new Map();
  for (const comment of commentsResult.rows) {
    const comments = commentsByPost.get(comment.post_id) || [];
    comments.push({
      id: comment.id,
      content: comment.content,
      created_at: comment.created_at,
      author_name: comment.author_name || 'Pengguna IDTC'
    });
    commentsByPost.set(comment.post_id, comments);
  }
  response.set('Cache-Control', 'private, no-store');
  return response.json({
    posts: postsResult.rows.map((post) => ({
      id: post.id,
      content: post.content,
      linkUrl: post.link_url,
      mediaUrl: post.media_filename
        ? `/api/auth/pilot-project-groups/${groupId}/posts/${post.id}/media`
        : null,
      mediaType: post.media_type,
      mediaName: post.media_name,
      createdAt: post.created_at,
      authorName: post.author_name || 'Pengguna IDTC',
      authorProfession: post.author_profession || '',
      likeCount: post.like_count,
      likedByMe: post.liked_by_me,
      comments: commentsByPost.get(post.id) || []
    }))
  });
});

app.get('/api/auth/pilot-project-groups/:groupId/posts/:postId/media', async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk melihat lampiran project.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;
  const { groupId, postId } = request.params;
  if (!UUID_PATTERN.test(groupId) || !UUID_PATTERN.test(postId)) {
    return response.status(400).json({ error: 'Lampiran pilot project tidak valid.' });
  }
  const result = await pool.query(
    `SELECT media_filename, media_type
     FROM pilot_project_posts
     WHERE id = $1 AND group_id = $2 AND media_filename IS NOT NULL`,
    [postId, groupId]
  );
  if (!result.rowCount) return response.status(404).json({ error: 'Lampiran tidak ditemukan.' });
  const filename = path.basename(result.rows[0].media_filename);
  response.set({
    'Cache-Control': 'private, no-store',
    'Content-Type': result.rows[0].media_type,
    'Content-Disposition': `${result.rows[0].media_type === 'application/pdf' ? 'attachment' : 'inline'}; filename="${filename}"`,
    'X-Content-Type-Options': 'nosniff'
  });
  return response.sendFile(filename, { root: pilotProjectUploadDirectory });
});

app.post(
  '/api/auth/pilot-project-groups/:groupId/posts',
  requireSameOrigin,
  pilotProjectActivityLimit,
  pilotProjectPostUpload.single('media'),
  async (request, response) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) return response.status(401).json({ error: 'Silakan masuk untuk membagikan aktivitas project.' });
    const user = await findAuthenticatedUser(token);
    if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
    if (!requirePasswordChangeComplete(user, response)) return;
    const { groupId } = request.params;
    if (!UUID_PATTERN.test(groupId)) {
      return response.status(400).json({ error: 'Group pilot project tidak valid.' });
    }
    const content = typeof request.body?.content === 'string' ? request.body.content.trim() : '';
    const rawLink = typeof request.body?.linkUrl === 'string' ? request.body.linkUrl.trim() : '';
    if (content.length > 2000) {
      return response.status(400).json({ field: 'content', error: 'Keterangan maksimal 2.000 karakter.' });
    }
    if (rawLink.length > 2000) {
      return response.status(400).json({ field: 'linkUrl', error: 'Tautan maksimal 2.000 karakter.' });
    }
    let linkUrl = null;
    if (rawLink) {
      try {
        const parsedLink = new URL(rawLink);
        if (!['http:', 'https:'].includes(parsedLink.protocol)) throw new Error('Unsupported URL scheme.');
        linkUrl = parsedLink.toString();
      } catch {
        return response.status(400).json({ field: 'linkUrl', error: 'Masukkan tautan web yang diawali http:// atau https://.' });
      }
    }
    let mediaType = null;
    let mediaFilename = null;
    let mediaName = null;
    if (request.file) {
      const detectedType = await fileTypeFromBuffer(request.file.buffer);
      const extension = detectedType ? pilotProjectUploadTypes.get(detectedType.mime) : null;
      if (!detectedType || !extension) {
        return response.status(400).json({ field: 'media', error: 'Lampiran harus berupa JPG, PNG, WEBP, atau PDF.' });
      }
      mediaType = detectedType.mime;
      mediaFilename = `${randomUUID()}.${extension}`;
      mediaName = path.basename(request.file.originalname.replaceAll('\\', '/')).slice(0, 255);
    }
    if (!content && !linkUrl && !request.file) {
      return response.status(400).json({ error: 'Tambahkan keterangan, tautan, atau lampiran sebelum membagikan.' });
    }
    const groupResult = await pool.query('SELECT id FROM pilot_project_groups WHERE id = $1', [groupId]);
    if (!groupResult.rowCount) return response.status(404).json({ error: 'Group pilot project tidak ditemukan.' });
    if (request.file) {
      await writeFile(path.join(pilotProjectUploadDirectory, mediaFilename), request.file.buffer, { flag: 'wx' });
    }
    try {
      const result = await pool.query(
        `INSERT INTO pilot_project_posts
           (group_id, author_id, content, link_url, media_filename, media_type, media_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [groupId, user.id, content, linkUrl, mediaFilename, mediaType, mediaName]
      );
      return response.status(201).json({ postId: result.rows[0].id, message: 'Aktivitas project berhasil dibagikan.' });
    } catch (error) {
      if (mediaFilename) await unlink(path.join(pilotProjectUploadDirectory, mediaFilename)).catch(() => {});
      throw error;
    }
  }
);

app.post('/api/auth/pilot-project-groups/:groupId/posts/:postId/like', requireSameOrigin, pilotProjectActivityLimit, async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk menyukai aktivitas.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;
  const { groupId, postId } = request.params;
  if (!UUID_PATTERN.test(groupId) || !UUID_PATTERN.test(postId)) {
    return response.status(400).json({ error: 'Aktivitas pilot project tidak valid.' });
  }
  const result = await pool.query(
    `INSERT INTO pilot_project_post_likes (post_id, user_id)
     SELECT post.id, $3 FROM pilot_project_posts post
     WHERE post.id = $1 AND post.group_id = $2
     ON CONFLICT (post_id, user_id) DO NOTHING
     RETURNING post_id`,
    [postId, groupId, user.id]
  );
  const postExists = result.rowCount || (await pool.query(
    'SELECT 1 FROM pilot_project_posts WHERE id = $1 AND group_id = $2',
    [postId, groupId]
  )).rowCount;
  if (!postExists) return response.status(404).json({ error: 'Aktivitas project tidak ditemukan.' });
  const count = await pool.query('SELECT COUNT(*)::int AS count FROM pilot_project_post_likes WHERE post_id = $1', [postId]);
  return response.json({ liked: true, likeCount: count.rows[0].count });
});

app.delete('/api/auth/pilot-project-groups/:groupId/posts/:postId/like', requireSameOrigin, async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk mengubah apresiasi.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;
  const { groupId, postId } = request.params;
  if (!UUID_PATTERN.test(groupId) || !UUID_PATTERN.test(postId)) {
    return response.status(400).json({ error: 'Aktivitas pilot project tidak valid.' });
  }
  const post = await pool.query('SELECT 1 FROM pilot_project_posts WHERE id = $1 AND group_id = $2', [postId, groupId]);
  if (!post.rowCount) return response.status(404).json({ error: 'Aktivitas project tidak ditemukan.' });
  await pool.query('DELETE FROM pilot_project_post_likes WHERE post_id = $1 AND user_id = $2', [postId, user.id]);
  const count = await pool.query('SELECT COUNT(*)::int AS count FROM pilot_project_post_likes WHERE post_id = $1', [postId]);
  return response.json({ liked: false, likeCount: count.rows[0].count });
});

app.post('/api/auth/pilot-project-groups/:groupId/posts/:postId/comments', requireSameOrigin, pilotProjectActivityLimit, async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk mengomentari aktivitas.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;
  const { groupId, postId } = request.params;
  if (!UUID_PATTERN.test(groupId) || !UUID_PATTERN.test(postId)) {
    return response.status(400).json({ error: 'Aktivitas pilot project tidak valid.' });
  }
  const content = typeof request.body?.content === 'string' ? request.body.content.trim() : '';
  if (!content || content.length > 1000) {
    return response.status(400).json({ field: 'content', error: 'Komentar wajib diisi dan maksimal 1.000 karakter.' });
  }
  const result = await pool.query(
    `INSERT INTO pilot_project_post_comments (post_id, author_id, content)
     SELECT post.id, $3, $4
     FROM pilot_project_posts post
     WHERE post.id = $1 AND post.group_id = $2
     RETURNING id, content, created_at`,
    [postId, groupId, user.id, content]
  );
  if (!result.rowCount) return response.status(404).json({ error: 'Aktivitas project tidak ditemukan.' });
  return response.status(201).json({
    comment: { ...result.rows[0], author_name: user.fullName },
    message: 'Komentar berhasil dikirim.'
  });
});

app.post('/api/auth/pilot-project-groups', requireSameOrigin, async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk membuat group pilot project.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;

  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  const focus = typeof request.body?.focus === 'string' ? request.body.focus.trim() : '';
  const description = typeof request.body?.description === 'string' ? request.body.description.trim() : '';
  if (name.length < 3 || name.length > 120) {
    return response.status(400).json({ field: 'name', error: 'Nama group wajib diisi (3–120 karakter).' });
  }
  if (!focus || focus.length > 180) {
    return response.status(400).json({ field: 'focus', error: 'Fokus wajib diisi dan maksimal 180 karakter.' });
  }
  if (description.length > 1000) {
    return response.status(400).json({ field: 'description', error: 'Deskripsi maksimal 1.000 karakter.' });
  }
  const result = await pool.query(
    `INSERT INTO pilot_project_groups (name, focus, description, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, focus, description, created_at`,
    [name, focus, description, user.id]
  );
  return response.status(201).json({
    group: { ...result.rows[0], created_by: user.fullName },
    message: 'Group pilot project berhasil dibuat.'
  });
});

app.get('/api/auth/membership-documents', async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk melihat dokumen anggota.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;
  response.set('Cache-Control', 'no-store');
  if (!user.roleCodes.includes('member')) {
    return response.json({ eligible: false, reason: 'Dokumen ini hanya tersedia untuk akun anggota IDTC.' });
  }
  const baseUrl = process.env.PUBLIC_BASE_URL || `${request.protocol}://${request.get('host')}`;
  const verificationUrl = new URL(`/verify/${user.id}`, baseUrl).toString();
  await upsertKtaQr(pool, user.id, verificationUrl);
  const qrDataUrl = ktaQrDataUrl(await renderKtaQrPng(verificationUrl, { projectRoot }));
  return response.json({
    eligible: true,
    member: {
      fullName: user.fullName,
      memberNumber: `IDTC-${String(user.memberNumber).padStart(6, '0')}`,
      organization: user.organization,
      createdAt: user.createdAt,
      hasPhoto: user.hasPhoto
    },
    verificationUrl,
    qrDataUrl
  });
});

app.get('/api/auth/kta-qr/download', async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk mengunduh QR KTA.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;
  if (!user.roleCodes.includes('member')) {
    return response.status(403).json({ error: 'QR KTA hanya tersedia untuk akun anggota IDTC.' });
  }
  const baseUrl = process.env.PUBLIC_BASE_URL || `${request.protocol}://${request.get('host')}`;
  const verificationUrl = new URL(`/verify/${user.id}`, baseUrl).toString();
  await upsertKtaQr(pool, user.id, verificationUrl);
  const qrBuffer = await renderKtaQrPng(verificationUrl, { projectRoot, width: KTA_QR_DOWNLOAD_WIDTH });
  response.set('Content-Type', 'image/png');
  response.set('Content-Disposition', `attachment; filename="${ktaQrFilename(user.memberNumber)}"`);
  response.set('Cache-Control', 'private, no-store');
  return response.send(qrBuffer);
});

app.get('/api/auth/photo', async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk melihat foto profil.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;
  if (!user.roleCodes.includes('member')) return response.status(403).json({ error: 'Foto ini hanya tersedia untuk akun anggota.' });
  const result = await pool.query('SELECT member_photo_path FROM users WHERE id = $1', [user.id]);
  if (!result.rowCount || !result.rows[0].member_photo_path) {
    return response.status(404).json({ error: 'Foto anggota tidak tersedia.' });
  }
  const filename = path.basename(result.rows[0].member_photo_path.replaceAll('\\', '/'));
  const photoPath = path.resolve(photoDirectory, filename);
  if (!photoPath.startsWith(`${photoDirectory}${path.sep}`)) {
    return response.status(404).json({ error: 'Foto anggota tidak tersedia.' });
  }
  response.set('Cache-Control', 'private, no-store');
  return response.sendFile(photoPath, (error) => {
    if (error && !response.headersSent) response.status(404).json({ error: 'Foto anggota tidak tersedia.' });
  });
});

app.patch('/api/auth/profile', requireSameOrigin, async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk kembali untuk mengubah profil.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;
  const fullName = typeof request.body?.fullName === 'string' ? request.body.fullName.trim() : '';
  const organization = typeof request.body?.organization === 'string' ? request.body.organization.trim() : '';
  const profession = typeof request.body?.profession === 'string' ? request.body.profession.trim() : '';
  const avatarId = typeof request.body?.avatarId === 'string' ? request.body.avatarId : '';
  if (!fullName || fullName.length > 150) {
    return response.status(400).json({ field: 'fullName', error: 'Nama wajib diisi dan maksimal 150 karakter.' });
  }
  if (organization.length > 180) {
    return response.status(400).json({ field: 'organization', error: 'Instansi maksimal 180 karakter.' });
  }
  if (profession.length > 180) {
    return response.status(400).json({ field: 'profession', error: 'Profesi atau jabatan maksimal 180 karakter.' });
  }
  if (!AVATAR_IDS.has(avatarId)) {
    return response.status(400).json({ field: 'avatarId', error: 'Pilih avatar karakter yang tersedia.' });
  }

  await pool.query(
    'UPDATE users SET full_name = $1, organization = $2, profession = $3, avatar_id = $4 WHERE id = $5 AND status = $6',
    [fullName, organization || null, profession || null, avatarId, user.id, 'active']
  );
  const updatedUser = await findAuthenticatedUser(token);
  return response.json({ user: updatedUser, message: 'Pengaturan profil berhasil disimpan.' });
});

app.post('/api/auth/profile/photo', requireSameOrigin, upload.single('memberPhoto'), async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk memperbarui foto profil.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;
  if (!user.roleCodes.includes('member')) {
    return response.status(403).json({ error: 'Foto profil ini hanya tersedia untuk akun anggota.' });
  }
  if (!request.file) {
    return response.status(400).json({ field: 'memberPhoto', error: 'Pilih foto profil terlebih dahulu.' });
  }

  const detectedType = await fileTypeFromBuffer(request.file.buffer);
  const extension = detectedType && allowedPhotoTypes.get(detectedType.mime);
  if (!extension) {
    return response.status(400).json({ field: 'memberPhoto', error: 'Foto harus berupa JPG, PNG, atau WEBP yang valid.' });
  }

  const filename = `${randomUUID()}.${extension}`;
  const photoPath = path.join(photoDirectory, filename);
  const relativePath = path.relative(projectRoot, photoPath).split(path.sep).join('/');
  let photoStored = false;
  let photoCommitted = false;
  const client = await pool.connect();
  try {
    await writeFile(photoPath, request.file.buffer, { flag: 'wx' });
    photoStored = true;
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT member_photo_path FROM users WHERE id = $1 AND status = $2 FOR UPDATE',
      [user.id, 'active']
    );
    if (!current.rowCount) {
      await client.query('ROLLBACK');
      await unlink(photoPath);
      return response.status(404).json({ error: 'Akun anggota tidak ditemukan.' });
    }
    const oldPhotoPath = current.rows[0].member_photo_path;
    const updated = await client.query(
      `UPDATE users SET member_photo_path = $1
       WHERE id = $2 AND status = 'active'
       RETURNING id`,
      [relativePath, user.id]
    );
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      await unlink(photoPath);
      return response.status(404).json({ error: 'Akun anggota tidak ditemukan.' });
    }
    await client.query('COMMIT');
    photoCommitted = true;
    if (oldPhotoPath) {
      const oldFilename = path.basename(oldPhotoPath.replaceAll('\\', '/'));
      const oldPath = path.resolve(photoDirectory, oldFilename);
      if (oldPath.startsWith(`${photoDirectory}${path.sep}`)) {
        try {
          await unlink(oldPath);
        } catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') console.error('Gagal menghapus foto profil lama:', cleanupError);
        }
      }
    }
    return response.json({
      user: await findAuthenticatedUser(token),
      photoUrl: `/api/auth/photo?v=${Date.now()}`,
      message: 'Foto profil berhasil diperbarui.'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (photoStored && !photoCommitted) {
      try {
        await unlink(photoPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') console.error('Gagal membersihkan foto profil sementara:', cleanupError);
      }
    }
    throw error;
  } finally {
    client.release();
  }
});

app.delete('/api/auth/profile/photo', requireSameOrigin, async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk untuk memperbarui foto profil.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!requirePasswordChangeComplete(user, response)) return;
  if (!user.roleCodes.includes('member')) {
    return response.status(403).json({ error: 'Foto profil ini hanya tersedia untuk akun anggota.' });
  }
  const avatarId = typeof request.body?.avatarId === 'string' ? request.body.avatarId : user.avatarId;
  if (!AVATAR_IDS.has(avatarId)) {
    return response.status(400).json({ field: 'avatarId', error: 'Pilih avatar karakter yang tersedia.' });
  }

  const client = await pool.connect();
  let oldPhotoPath = null;
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT member_photo_path FROM users WHERE id = $1 AND status = $2 FOR UPDATE',
      [user.id, 'active']
    );
    if (!current.rowCount) {
      await client.query('ROLLBACK');
      return response.status(404).json({ error: 'Akun anggota tidak ditemukan.' });
    }
    oldPhotoPath = current.rows[0].member_photo_path;
    await client.query(
      'UPDATE users SET member_photo_path = NULL, avatar_id = $1 WHERE id = $2',
      [avatarId, user.id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (oldPhotoPath) {
    const filename = path.basename(oldPhotoPath.replaceAll('\\', '/'));
    const oldPath = path.resolve(photoDirectory, filename);
    if (oldPath.startsWith(`${photoDirectory}${path.sep}`)) {
      try {
        await unlink(oldPath);
      } catch (error) {
        if (error.code !== 'ENOENT') console.error('Gagal menghapus foto profil lama:', error);
      }
    }
  }
  return response.json({
    user: await findAuthenticatedUser(token),
    message: 'Foto profil dihapus. Avatar karakter Anda kini digunakan.'
  });
});

app.post('/api/auth/logout', requireSameOrigin, async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (token) {
    await pool.query(
      'UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = $1 AND revoked_at IS NULL',
      [tokenHash(token)]
    );
  }
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/'
  });
  return response.json({ ok: true });
});

app.post('/api/auth/change-password', requireSameOrigin, async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return response.status(401).json({ error: 'Silakan masuk kembali untuk mengganti kata sandi.' });
  const user = await findAuthenticatedUser(token);
  if (!user) return response.status(401).json({ error: 'Sesi masuk tidak valid atau sudah berakhir.' });
  if (!user.mustChangePassword) {
    return response.status(409).json({ error: 'Akun ini tidak memerlukan perubahan kata sandi.' });
  }

  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  const passwordConfirmation = typeof request.body?.passwordConfirmation === 'string'
    ? request.body.passwordConfirmation
    : '';
  if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    return response.status(400).json({ field: 'password', error: 'Kata sandi baru harus minimal 12 karakter dan maksimal 72 byte.' });
  }
  if (password !== passwordConfirmation) {
    return response.status(400).json({ field: 'passwordConfirmation', error: 'Konfirmasi kata sandi belum sama.' });
  }
  const current = await pool.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!current.rowCount) return response.status(401).json({ error: 'Akun tidak ditemukan.' });
  if (await bcrypt.compare(password, current.rows[0].password_hash)) {
    return response.status(400).json({ field: 'password', error: 'Kata sandi baru harus berbeda dari kata sandi sementara.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const currentTokenHash = tokenHash(token);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE users SET password_hash = $1, must_change_password = FALSE
       WHERE id = $2 AND must_change_password = TRUE AND status = 'active'
       RETURNING id`,
      [passwordHash, user.id]
    );
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'Kata sandi akun sudah diperbarui. Silakan masuk kembali.' });
    }
    await client.query(
      `UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND token_hash <> $2 AND revoked_at IS NULL`,
      [user.id, currentTokenHash]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return response.json({ user: await findAuthenticatedUser(token), message: 'Kata sandi berhasil diperbarui.' });
});

app.get('/api/auth/providers', async (request, response) => {
  const configured = Object.fromEntries(
    OAUTH_PROVIDERS.map((provider) => [provider, getOAuthConfig(provider).configured])
  );
  const token = request.cookies?.[SESSION_COOKIE];
  let linked = [];
  if (token) {
    const user = await findAuthenticatedUser(token);
    if (user) {
      if (!requirePasswordChangeComplete(user, response)) return;
      const result = await pool.query(
        'SELECT provider FROM oauth_identities WHERE user_id = $1 ORDER BY provider',
        [user.id]
      );
      linked = result.rows.map((row) => row.provider);
    }
  }
  return response.json({ configured, linked });
});

app.get('/auth/:provider', socialLoginLimit, async (request, response) => {
  const { provider } = request.params;
  if (!OAUTH_PROVIDERS.includes(provider)) return response.sendStatus(404);
  const config = getOAuthConfig(provider);
  if (!config.configured) return oauthErrorRedirect(response, 'provider_not_configured');

  let linkUserId = null;
  if (request.query.link === '1') {
    const token = request.cookies?.[SESSION_COOKIE];
    const user = token && await findAuthenticatedUser(token);
    if (!user) return oauthErrorRedirect(response, 'login_required_to_link');
    linkUserId = user.id;
  }

  let callbackUrl;
  try {
    callbackUrl = oauthCallbackUrl(provider);
  } catch (error) {
    console.error('Social login URL configuration error:', error.message);
    return oauthErrorRedirect(response, 'provider_configuration_error');
  }
  const state = randomBytes(32).toString('hex');
  const nonce = randomBytes(32).toString('hex');
  await pool.query('DELETE FROM oauth_states WHERE expires_at <= CURRENT_TIMESTAMP');
  await pool.query(
    `INSERT INTO oauth_states (state_hash, provider, nonce_hash, link_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [tokenHash(state), provider, tokenHash(nonce), linkUserId, new Date(Date.now() + 10 * 60 * 1000)]
  );

  const authorization = provider === 'google'
    ? new URL('https://accounts.google.com/o/oauth2/v2/auth')
    : provider === 'facebook'
      ? new URL(`https://www.facebook.com/${encodeURIComponent(config.graphVersion)}/dialog/oauth`)
      : provider === 'instagram'
        ? new URL('https://www.instagram.com/oauth/authorize')
        : new URL('https://appleid.apple.com/auth/authorize');
  const parameters = {
    client_id: config.clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    state
  };
  if (provider === 'google') {
    Object.assign(parameters, { scope: 'openid', nonce, prompt: 'select_account' });
  } else if (provider === 'facebook') {
    Object.assign(parameters, { scope: 'public_profile' });
  } else if (provider === 'instagram') {
    Object.assign(parameters, {
      scope: 'instagram_business_basic',
      enable_fb_login: '0',
      force_authentication: '1'
    });
  } else {
    Object.assign(parameters, { response_mode: 'query', nonce });
  }
  authorization.search = new URLSearchParams(parameters).toString();
  return response.redirect(authorization.toString());
});

app.get('/auth/:provider/callback', socialLoginLimit, async (request, response) => {
  const { provider } = request.params;
  if (!OAUTH_PROVIDERS.includes(provider)) return response.sendStatus(404);
  const state = typeof request.query.state === 'string' ? request.query.state : '';
  if (!/^[a-f0-9]{64}$/.test(state)) return oauthErrorRedirect(response, 'invalid_oauth_state');
  const stateResult = await pool.query(
    `DELETE FROM oauth_states
     WHERE state_hash = $1 AND provider = $2 AND expires_at > CURRENT_TIMESTAMP
     RETURNING nonce_hash, link_user_id`,
    [tokenHash(state), provider]
  );
  const oauthState = stateResult.rows[0];
  if (!oauthState) return oauthErrorRedirect(response, 'invalid_oauth_state');
  if (typeof request.query.error === 'string') {
    return oauthErrorRedirect(response, 'provider_cancelled');
  }
  const code = typeof request.query.code === 'string' ? request.query.code : '';
  if (!code || code.length > 4096) return oauthErrorRedirect(response, 'provider_authorization_failed');
  let callbackUrl;
  try {
    callbackUrl = oauthCallbackUrl(provider);
  } catch (error) {
    console.error('Social login URL configuration error:', error.message);
    return oauthErrorRedirect(response, 'provider_configuration_error');
  }

  let identity;
  try {
    identity = await getOAuthIdentity(provider, code, callbackUrl, oauthState.nonce_hash);
  } catch (error) {
    console.error(`${provider} OAuth verification failed:`, error.message);
    return oauthErrorRedirect(response, 'provider_verification_failed');
  }

  if (oauthState.link_user_id) {
    const activeUser = await pool.query(
      "SELECT id FROM users WHERE id = $1 AND status = 'active'",
      [oauthState.link_user_id]
    );
    if (!activeUser.rowCount) return oauthErrorRedirect(response, 'account_inactive');
    const existingIdentity = await pool.query(
      'SELECT user_id FROM oauth_identities WHERE provider = $1 AND provider_subject = $2',
      [provider, identity.subject]
    );
    if (existingIdentity.rowCount && existingIdentity.rows[0].user_id !== oauthState.link_user_id) {
      return oauthErrorRedirect(response, 'provider_already_linked');
    }
    try {
      const linkedIdentity = await pool.query(
        `INSERT INTO oauth_identities (provider, provider_subject, user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, provider_subject) DO NOTHING
         RETURNING id`,
        [provider, identity.subject, oauthState.link_user_id]
      );
      if (!linkedIdentity.rowCount) {
        const owner = await pool.query(
          'SELECT user_id FROM oauth_identities WHERE provider = $1 AND provider_subject = $2',
          [provider, identity.subject]
        );
        if (!owner.rowCount || owner.rows[0].user_id !== oauthState.link_user_id) {
          return oauthErrorRedirect(response, 'provider_already_linked');
        }
      }
    } catch (error) {
      if (error.code === '23505') return oauthErrorRedirect(response, 'provider_already_linked');
      throw error;
    }
    return response.redirect('/?social_success=linked');
  }

  const result = await pool.query(
    `SELECT u.id, u.status
     FROM oauth_identities oi
     JOIN users u ON u.id = oi.user_id
     WHERE oi.provider = $1 AND oi.provider_subject = $2
     LIMIT 1`,
    [provider, identity.subject]
  );
  const user = result.rows[0];
  if (!user) return oauthErrorRedirect(response, 'provider_unlinked');
  if (user.status === 'pending') return oauthErrorRedirect(response, 'account_pending');
  if (user.status !== 'active') return oauthErrorRedirect(response, 'account_inactive');

  const token = randomBytes(32).toString('hex');
  await pool.query(
    'INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, tokenHash(token), new Date(Date.now() + SESSION_DURATION_MS)]
  );
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: SESSION_DURATION_MS,
    path: '/'
  });
  return response.redirect('/?social_success=login');
});

app.post('/api/auth/register', registrationLimit, upload.single('memberPhoto'), async (request, response) => {
  const fullName = typeof request.body.fullName === 'string' ? request.body.fullName.trim() : '';
  const email = typeof request.body.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const organization = typeof request.body.organization === 'string' ? request.body.organization.trim() : '';
  const profession = typeof request.body.profession === 'string' ? request.body.profession.trim() : '';
  const password = typeof request.body.password === 'string' ? request.body.password : '';
  const passwordConfirm = typeof request.body.passwordConfirm === 'string' ? request.body.passwordConfirm : '';
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!fullName || fullName.length > 150) {
    return response.status(400).json({ field: 'fullName', error: 'Nama wajib diisi dan maksimal 150 karakter.' });
  }
  if (!emailPattern.test(email) || email.length > 254) {
    return response.status(400).json({ field: 'email', error: 'Masukkan alamat email yang valid.' });
  }
  if (organization.length > 180) {
    return response.status(400).json({ field: 'organization', error: 'Nama instansi maksimal 180 karakter.' });
  }
  if (profession.length > 180) {
    return response.status(400).json({ field: 'profession', error: 'Profesi atau jabatan maksimal 180 karakter.' });
  }
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    return response.status(400).json({ field: 'password', error: 'Kata sandi harus minimal 8 karakter dan maksimal 72 byte.' });
  }
  if (passwordConfirm !== password) {
    return response.status(400).json({ field: 'passwordConfirm', error: 'Konfirmasi kata sandi belum sama.' });
  }
  if (!request.file) {
    return response.status(400).json({ field: 'memberPhoto', error: 'Lampirkan foto untuk kartu anggota IDTC.' });
  }

  const detectedType = await fileTypeFromBuffer(request.file.buffer);
  const extension = detectedType && allowedPhotoTypes.get(detectedType.mime);
  if (!extension) {
    return response.status(400).json({ field: 'memberPhoto', error: 'Foto harus berupa JPG, PNG, atau WEBP yang valid.' });
  }

  const filename = `${randomUUID()}.${extension}`;
  const photoPath = path.join(photoDirectory, filename);
  const photoPathForDatabase = path.relative(projectRoot, photoPath).split(path.sep).join('/');
  let photoStored = false;

  try {
    await writeFile(photoPath, request.file.buffer, { flag: 'wx' });
    photoStored = true;
    const passwordHash = await bcrypt.hash(password, 12);
    const client = await pool.connect();
    let user;

    try {
      await client.query('BEGIN');
      const userResult = await client.query(
        `INSERT INTO users (full_name, email, password_hash, organization, profession, member_photo_path)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, full_name, email, status`,
        [fullName, email, passwordHash, organization || null, profession || null, photoPathForDatabase]
      );
      user = userResult.rows[0];
      const roleResult = await client.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, id FROM roles WHERE code = 'member'
         RETURNING user_id`,
        [user.id]
      );
      if (roleResult.rowCount !== 1) throw new Error('Role member belum tersedia. Jalankan database.sql.');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return response.status(201).json({
      message: 'Pendaftaran berhasil dikirim. Akun Anda menunggu verifikasi IDTC.',
      user: { id: user.id, fullName: user.full_name, email: user.email, status: user.status }
    });
  } catch (error) {
    if (photoStored) await unlink(photoPath).catch(() => {});
    if (error.code === '23505') {
      return response.status(409).json({ field: 'email', error: 'Email tersebut sudah terdaftar.' });
    }
    throw error;
  }
});

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    const isProjectPost = error.field === 'media';
    return response.status(413).json({
      field: isProjectPost ? 'media' : 'memberPhoto',
      error: isProjectPost ? 'Ukuran lampiran maksimal 10 MB.' : 'Ukuran foto maksimal 5 MB.'
    });
  }
  if (error instanceof multer.MulterError) {
    return response.status(400).json({ error: 'Formulir atau lampiran tidak valid.' });
  }
  console.error(error);
  return response.status(500).json({ error: 'Terjadi kesalahan pada layanan portal.' });
});

async function startServer() {
  if (!databaseUrl) throw new Error('DATABASE_URL belum diatur. Salin .env.example ke .env dan isi koneksi PostgreSQL.');
  await mkdir(photoDirectory, { recursive: true });
  await mkdir(pilotProjectUploadDirectory, { recursive: true });
  await pool.query('SELECT 1');
  await ensureMemberPasswordChangeSchema();
  await ensureOAuthSchema();
  await ensureKtaQrSchema();
  await ensureCollaborationSchema();
  await ensureBootstrapAdmin(pool);
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`IDTC berjalan di http://localhost:${port}`));
}

startServer().catch(async (error) => {
  console.error(error.message);
  await pool.end();
  process.exit(1);
});