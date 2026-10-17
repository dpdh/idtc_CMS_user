import { createHash, randomBytes } from 'node:crypto';
import { pool } from './db.js';
import { fileUrl, forbidden, unauthorized } from './http.js';
import { markUserActive } from './monitor.js';

export const ADMIN_SESSION_COOKIE = 'idtc_admin_session';
export const MOBILE_SESSION_MS = 180 * 24 * 60 * 60 * 1000;
export const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
export const STAFF_ROLES = ['super_admin', 'admin'];
export const ROLE_CODES = ['super_admin', 'admin', 'praktisi', 'sahabat', 'calon_sahabat'];
export const OFFICIAL_ANSWER_ROLES = ['super_admin', 'admin', 'praktisi'];

export function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(client, userId, { clientType = 'mobile', deviceName = null } = {}) {
  const token = randomBytes(32).toString('hex');
  const duration = clientType === 'admin' ? ADMIN_SESSION_MS : MOBILE_SESSION_MS;
  const expiresAt = new Date(Date.now() + duration);
  await client.query(
    `INSERT INTO user_sessions (user_id, token_hash, client, device_name, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, tokenHash(token), clientType, deviceName ? String(deviceName).slice(0, 120) : null, expiresAt]
  );
  return { token, expiresAt, duration };
}

export async function revokeUserSessions(client, userId, exceptTokenHash = null) {
  await client.query(
    `UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND revoked_at IS NULL AND ($2::char(64) IS NULL OR token_hash <> $2)`,
    [userId, exceptTokenHash]
  );
}

const USER_COLUMNS = `
  u.id, u.full_name, u.email, u.phone, u.photo_path, u.bio, u.city, u.address, u.gender,
  u.birth_date, u.occupation, u.korda_id, u.lbu_batch, u.membership_type, u.must_change_password,
  u.status, u.member_number, u.created_at, u.updated_at, (u.password_hash IS NOT NULL) AS has_password,
  COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), ARRAY[]::varchar[]) AS role_codes,
  COALESCE(max(r.rank), 0) AS role_rank,
  EXISTS (SELECT 1 FROM oauth_identities oi WHERE oi.user_id = u.id AND oi.provider = 'google') AS has_google`;

export async function loadUserById(id, client = pool) {
  const result = await client.query(
    `SELECT ${USER_COLUMNS}
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.id = $1
     GROUP BY u.id`,
    [id]
  );
  if (!result.rowCount) return null;
  return attachFeatures(result.rows[0], client);
}

export async function attachFeatures(row, client = pool) {
  const features = await client.query(
    `SELECT f.id, COALESCE(o.enabled, pf.enabled, FALSE) AS enabled, o.enabled IS NOT NULL AS overridden
     FROM membership_features f
     LEFT JOIN membership_plan_features pf ON pf.feature_id = f.id AND pf.plan_type = $2
     LEFT JOIN user_feature_overrides o ON o.feature_id = f.id AND o.user_id = $1
     ORDER BY f.sort_order, f.id`,
    [row.id, row.membership_type]
  );
  row.features = Object.fromEntries(features.rows.map((feature) => [feature.id, feature.enabled]));
  row.feature_overrides = Object.fromEntries(
    features.rows.filter((feature) => feature.overridden).map((feature) => [feature.id, feature.enabled])
  );
  return row;
}

export function primaryRole(roleCodes = []) {
  return ROLE_CODES.find((code) => roleCodes.includes(code)) || 'calon_sahabat';
}

export function serializeUser(request, row, { includeAdminFields = false } = {}) {
  const user = {
    id: row.id,
    email: row.email,
    name: row.full_name,
    phone: row.phone,
    avatar: fileUrl(request, row.photo_path),
    authProvider: row.has_google ? 'google' : 'password',
    hasPassword: Boolean(row.has_password),
    role: primaryRole(row.role_codes),
    roles: row.role_codes,
    isActive: row.status === 'active',
    status: row.status,
    joinDate: row.created_at,
    memberNumber: row.member_number ? `NSH-${String(row.member_number).padStart(6, '0')}` : null,
    bio: row.bio,
    city: row.city,
    address: row.address,
    gender: row.gender,
    birthDate: row.birth_date,
    occupation: row.occupation,
    nasuhaRegion: row.korda_id,
    lbuBatch: row.lbu_batch,
    membershipType: row.membership_type,
    membershipFeatures: row.features || {},
    mustChangePassword: row.must_change_password
  };
  if (includeAdminFields) user.featureOverrides = row.feature_overrides || {};
  return user;
}

export function publicUser(request, row, prefix = 'author_') {
  if (!row[`${prefix}id`]) return null;
  return {
    id: row[`${prefix}id`],
    name: row[`${prefix}name`],
    avatar: fileUrl(request, row[`${prefix}photo`]),
    city: row[`${prefix}city`] ?? null,
    role: row[`${prefix}role`] ?? null
  };
}

function readToken(request) {
  const header = request.get('authorization');
  if (header && /^Bearer\s+/i.test(header)) {
    return { token: header.replace(/^Bearer\s+/i, '').trim(), via: 'bearer' };
  }
  const cookieToken = request.cookies?.[ADMIN_SESSION_COOKIE];
  if (cookieToken) return { token: cookieToken, via: 'cookie' };
  return { token: null, via: null };
}

function sameOrigin(request) {
  const origin = request.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === request.get('host');
  } catch {
    return false;
  }
}

// Middleware global: isi request.user bila token valid. Tidak menolak request tanpa token.
export async function authenticate(request, _response, next) {
  const { token, via } = readToken(request);
  if (!token || token.length > 128) return next();
  const result = await pool.query(
    `SELECT s.id AS session_id, s.user_id, s.last_used_at
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > CURRENT_TIMESTAMP
       AND u.status = 'active'
     LIMIT 1`,
    [tokenHash(token)]
  );
  const session = result.rows[0];
  if (!session) {
    request.authError = 'Sesi masuk tidak valid atau sudah berakhir. Silakan login kembali.';
    return next();
  }
  if (via === 'cookie' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !sameOrigin(request)) {
    request.authError = 'Permintaan lintas situs ditolak.';
    return next();
  }
  const user = await loadUserById(session.user_id);
  if (!user) return next();
  request.user = user;
  request.session = { id: session.session_id, tokenHash: tokenHash(token), via };
  markUserActive(user.id);
  if (!session.last_used_at || Date.now() - new Date(session.last_used_at).getTime() > 60 * 60 * 1000) {
    pool.query('UPDATE user_sessions SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [session.session_id])
      .catch(() => {});
  }
  return next();
}

export function requireAuth(request, _response, next) {
  if (!request.user) throw unauthorized(request.authError);
  return next();
}

export function hasRole(user, ...roles) {
  return Boolean(user?.role_codes?.some((code) => roles.includes(code)));
}

export function isStaff(user) {
  return hasRole(user, ...STAFF_ROLES);
}

export function requireFeature(feature, { bypassRoles = [] } = {}) {
  return (request, _response, next) => {
    if (!request.user) throw unauthorized(request.authError);
    if (isStaff(request.user) || hasRole(request.user, ...bypassRoles) || request.user.features?.[feature]) return next();
    throw forbidden('Fitur ini khusus member. Upgrade membership Anda untuk mengaksesnya.', {
      code: 'FEATURE_LOCKED',
      feature
    });
  };
}

export function requireAdmin(request, _response, next) {
  if (!request.user) throw unauthorized(request.authError);
  if (!isStaff(request.user)) throw forbidden('Hanya admin yang dapat mengakses fitur ini.');
  return next();
}

export function requireSuperAdmin(request, _response, next) {
  if (!request.user) throw unauthorized(request.authError);
  if (!hasRole(request.user, 'super_admin')) throw forbidden('Hanya Super Admin yang dapat mengakses fitur ini.');
  return next();
}
