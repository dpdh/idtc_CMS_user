// Helper HTTP: error, validasi input, paging, dan format respons.
// Format mengikuti idtc-user: error = { error, field? }; sukses = { data, meta? }.

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (message, field) => new HttpError(400, message, field ? { field } : {});
export const unauthorized = (message = 'Sesi masuk tidak ditemukan. Silakan login kembali.') => new HttpError(401, message);
export const forbidden = (message = 'Anda tidak memiliki akses ke fitur ini.', extra = {}) => new HttpError(403, message, extra);
export const notFound = (message = 'Data tidak ditemukan.') => new HttpError(404, message);
export const conflict = (message, field) => new HttpError(409, message, field ? { field } : {});

export function sendData(response, data, meta, status = 200) {
  const body = { data };
  if (meta) body.meta = meta;
  return response.status(status).json(body);
}

export function baseUrl(request) {
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
  return configured || `${request.protocol}://${request.get('host')}`;
}

export function fileUrl(request, storagePath) {
  if (!storagePath) return null;
  if (/^https?:\/\//.test(storagePath)) return storagePath;
  return `${baseUrl(request)}/${storagePath.replace(/^\/+/, '')}`;
}

export function toStoragePath(value) {
  // Terima URL penuh hasil /uploads atau path relatif; simpan relatif "uploads/...".
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const match = trimmed.match(/(?:^|\/)(uploads\/[a-z]+\/[A-Za-z0-9._-]+)$/);
  if (match) return match[1];
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  return null;
}

export function normalizePhone(phone) {
  if (typeof phone !== 'string') return '';
  const digits = phone.replace(/[^0-9+]/g, '');
  if (digits.startsWith('+62')) return `0${digits.slice(3)}`;
  if (digits.startsWith('62')) return `0${digits.slice(2)}`;
  return digits.replace(/\+/g, '');
}

export function isValidPhone(phone) {
  return /^0\d{8,14}$/.test(phone);
}

export function whatsappNumber(phone) {
  const normalized = normalizePhone(phone || '');
  return normalized ? `62${normalized.slice(1)}` : '';
}

// Validator kecil, melempar HttpError 400 dengan field.
export function str(body, field, { required = false, max = 255, min = 0, label = field, trim = true } = {}) {
  const raw = body?.[field];
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
    if (required) throw badRequest(`${label} wajib diisi.`, field);
    return raw === null ? null : undefined;
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') throw badRequest(`${label} tidak valid.`, field);
  const value = trim ? String(raw).trim() : String(raw);
  if (value.length < min) throw badRequest(`${label} minimal ${min} karakter.`, field);
  if (value.length > max) throw badRequest(`${label} maksimal ${max} karakter.`, field);
  return value;
}

export function int(body, field, { required = false, min = -Infinity, max = Infinity, label = field } = {}) {
  const raw = body?.[field];
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw badRequest(`${label} wajib diisi.`, field);
    return raw === null ? null : undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${label} harus berupa angka${Number.isFinite(min) ? ` minimal ${min}` : ''}.`, field);
  }
  return value;
}

export function bool(body, field) {
  const raw = body?.[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '1' || raw === 1) return true;
  if (raw === 'false' || raw === '0' || raw === 0) return false;
  throw badRequest(`${field} harus true/false.`, field);
}

export function oneOf(body, field, allowed, { required = false, label = field } = {}) {
  const value = str(body, field, { required, label });
  if (value === undefined || value === null) return value;
  if (!allowed.includes(value)) throw badRequest(`${label} tidak valid.`, field);
  return value;
}

export function date(body, field, { required = false, label = field } = {}) {
  const value = str(body, field, { required, label, max: 10 });
  if (value === undefined || value === null) return value;
  if (!DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw badRequest(`${label} harus berformat YYYY-MM-DD.`, field);
  }
  return value;
}

export function stringArray(body, field, { maxItems = 10, maxLength = 60, label = field } = {}) {
  const raw = body?.[field];
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const values = list.map((item) => String(item).trim()).filter(Boolean);
  if (values.length > maxItems) throw badRequest(`${label} maksimal ${maxItems} item.`, field);
  if (values.some((item) => item.length > maxLength)) throw badRequest(`${label} maksimal ${maxLength} karakter per item.`, field);
  return values;
}

export function assertUuid(value, message = 'Data tidak ditemukan.') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw notFound(message);
  return value;
}

export function paging(query, { defaultPerPage = 20, maxPerPage = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const perPage = Math.min(maxPerPage, Math.max(1, Number.parseInt(query.perPage, 10) || defaultPerPage));
  return { page, perPage, offset: (page - 1) * perPage };
}

export function pageMeta({ page, perPage }, total, extra = {}) {
  return { page, perPage, total, lastPage: Math.max(1, Math.ceil(total / perPage)), ...extra };
}

export function csv(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

// Tanggal "hari ini" dalam WIB (Asia/Jakarta), format YYYY-MM-DD.
export function todayWib(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(now);
}

export function addDays(dateString, days) {
  const value = new Date(`${dateString}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function likePattern(value) {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}
