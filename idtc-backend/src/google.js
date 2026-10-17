// Verifikasi kredensial "Sign in with Google" dari app mobile.
// - idToken (disarankan): JWT dari Google, diverifikasi tanda tangan (JWKS Google), issuer, audience, dan masa berlaku.
// - accessToken (cadangan, mis. alur implicit di web): dicek ke endpoint tokeninfo Google, lalu profil diambil dari userinfo.
// Audience wajib salah satu client ID milik app (GOOGLE_CLIENT_IDS); token untuk aplikasi lain ditolak.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HttpError } from './http.js';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const REQUEST_TIMEOUT_MS = 8000;

let jwks;
function googleJwks() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs'));
  return jwks;
}

export function googleClientIds() {
  return (process.env.GOOGLE_CLIENT_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

const invalidToken = () => new HttpError(401, 'Login Google gagal: token tidak valid atau sudah kedaluwarsa. Silakan coba lagi.');

function profileFrom(claims) {
  if (!claims.sub || !claims.email) throw new HttpError(401, 'Akun Google tidak memberikan email. Izinkan akses email lalu coba lagi.');
  return {
    subject: String(claims.sub),
    email: String(claims.email).trim().toLowerCase(),
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: typeof claims.name === 'string' ? claims.name.trim() : '',
    picture: typeof claims.picture === 'string' && /^https:\/\//.test(claims.picture) ? claims.picture : null
  };
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) return null;
  return response.json();
}

async function verifyIdToken(idToken, audience) {
  try {
    const { payload } = await jwtVerify(idToken, googleJwks(), { issuer: GOOGLE_ISSUERS, audience });
    return profileFrom(payload);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalidToken();
  }
}

async function verifyAccessToken(accessToken, audience) {
  let info;
  try {
    info = await fetchJson(`${TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`);
  } catch {
    throw new HttpError(503, 'Server Google tidak dapat dihubungi. Coba lagi sebentar.');
  }
  if (!info || Number(info.expires_in) <= 0) throw invalidToken();
  if (!audience.includes(info.aud) && !audience.includes(info.azp)) throw invalidToken();
  let profile = null;
  try {
    profile = await fetchJson(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch {
    // Profil tambahan (nama/foto) opsional; identitas utama sudah dari tokeninfo.
  }
  if (profile?.sub && profile.sub !== info.sub) throw invalidToken();
  return profileFrom({ ...profile, sub: info.sub, email: info.email ?? profile?.email, email_verified: info.email_verified ?? profile?.email_verified });
}

export async function verifyGoogleCredential({ idToken, accessToken }) {
  const audience = googleClientIds();
  if (!audience.length) throw new HttpError(503, 'Login Google belum diaktifkan di server.');
  if (typeof idToken === 'string' && idToken) return verifyIdToken(idToken, audience);
  if (typeof accessToken === 'string' && accessToken) return verifyAccessToken(accessToken, audience);
  throw new HttpError(400, 'Token Google wajib dikirim.', { field: 'idToken' });
}
