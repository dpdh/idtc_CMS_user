// Metrik ringan in-memory untuk halaman Kesehatan Sistem di panel admin, plus pencatat aktivitas harian.
// Nilai reset saat server restart; untuk riwayat panjang gunakan log/monitoring hosting.
import { pool } from './db.js';
import { todayWib } from './http.js';

const MAX_RECENT_ERRORS = 30;
const SLOW_REQUEST_MS = 2000;
const startedAt = new Date();
const counters = { total: 0, clientErrors: 0, serverErrors: 0, slow: 0 };
const recentErrors = [];

export function requestMetrics(request, response, next) {
  const start = process.hrtime.bigint();
  response.on('finish', () => {
    counters.total += 1;
    if (response.statusCode >= 500) counters.serverErrors += 1;
    else if (response.statusCode >= 400) counters.clientErrors += 1;
    if (Number(process.hrtime.bigint() - start) / 1e6 > SLOW_REQUEST_MS) counters.slow += 1;
  });
  next();
}

// Hanya path (tanpa query string) supaya token/parameter sensitif tidak ikut tersimpan.
export function recordServerError(request, error) {
  recentErrors.unshift({
    at: new Date().toISOString(),
    method: request.method,
    path: (request.originalUrl || request.url || '').split('?')[0],
    message: String(error?.message || error).slice(0, 300)
  });
  recentErrors.length = Math.min(recentErrors.length, MAX_RECENT_ERRORS);
}

export function metricsSnapshot() {
  return { startedAt: startedAt.toISOString(), ...counters, recentErrors: [...recentErrors] };
}

const activeToday = new Map();

export function markUserActive(userId) {
  const today = todayWib();
  if (activeToday.get(userId) === today) return;
  // Bersihkan entri hari sebelumnya agar Map tidak tumbuh tanpa batas.
  if (activeToday.size > 50000) activeToday.clear();
  activeToday.set(userId, today);
  pool.query(
    'INSERT INTO user_activity_days (activity_date, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [today, userId]
  ).catch(() => activeToday.delete(userId));
}
