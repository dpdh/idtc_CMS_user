// Helper test: database terpisah (idtc_test), server Express di port acak, dan klien HTTP kecil.
import pg from 'pg';

const baseDatabaseUrl = process.env.TEST_DATABASE_URL || 'postgresql://postgres@localhost:5432/idtc_test';
process.env.DATABASE_URL = baseDatabaseUrl;
process.env.NODE_ENV = 'test';
process.env.UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads-test';
process.env.ADMIN_EMAIL = 'super@idtc.test';
process.env.ADMIN_PASSWORD = 'SuperAdmin123';
delete process.env.PUBLIC_BASE_URL;

async function ensureDatabase() {
  const url = new URL(baseDatabaseUrl);
  const name = url.pathname.slice(1);
  url.pathname = '/postgres';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (!exists.rowCount) await client.query(`CREATE DATABASE "${name}"`);
  await client.end();
}

export async function startTestServer() {
  await ensureDatabase();
  const { ensureSchema, pool } = await import('../src/db.js');
  const { createApp } = await import('../src/app.js');
  const { ensureBootstrapAdmin, loadSeedContent, seedBase, seedContent } = await import('../src/seed.js');
  const { ensureUploadDirectories } = await import('../src/uploads.js');

  await ensureSchema();
  const tables = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'roles'`);
  await pool.query(`TRUNCATE ${tables.rows.map((row) => `"${row.tablename}"`).join(', ')} CASCADE`);
  const content = await loadSeedContent();
  await seedBase(pool, content);
  await seedContent(pool, content);
  await ensureBootstrapAdmin(pool);
  await ensureUploadDirectories();

  const hits = new Set();
  const app = createApp({ onRouteHit: (key) => hits.add(key) });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function api(method, path, { token, body, form, headers = {}, raw = false } = {}) {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (form) {
      init.body = form;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${origin}/api/v1${path}`, init);
    if (raw) return response;
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, body: json, headers: response.headers };
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }

  // Semua route API terdaftar ("METHOD /path"), hanya yang berada di router /api/v1.
  function listRoutes() {
    const routes = new Set();
    const walk = (stack, depth) => {
      for (const layer of stack) {
        if (layer.route && depth > 0) {
          for (const method of Object.keys(layer.route.methods)) routes.add(`${method.toUpperCase()} ${layer.route.path}`);
        } else if (layer.handle?.stack) {
          walk(layer.handle.stack, depth + 1);
        }
      }
    };
    walk(app.router.stack, 0);
    return [...routes].sort();
  }

  return { api, origin, pool, close, hits, listRoutes };
}

// PNG 1x1 valid untuk uji upload.
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

export function imageForm(fields = {}) {
  const form = new FormData();
  form.append('file', new Blob([TINY_PNG], { type: 'image/png' }), 'foto.png');
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

export function wibDate(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(now);
}
