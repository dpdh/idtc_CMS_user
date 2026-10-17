import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool, types } = pg;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// DATE dikembalikan apa adanya ('YYYY-MM-DD') supaya tidak bergeser zona waktu.
types.setTypeParser(1082, (value) => value);
// BIGINT (harga, member_number) aman sebagai Number untuk rentang aplikasi ini.
types.setTypeParser(20, (value) => Number(value));
// NUMERIC (rating) sebagai Number.
types.setTypeParser(1700, (value) => Number(value));

// PG_POOL_MAX: batasi koneksi saat memakai pooler terkelola (mis. Supabase Session pooler) yang kuotanya kecil.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 10,
});

pool.on('error', (error) => {
  console.error('[database] koneksi idle mengalami error:', error.message);
});

export async function ensureSchema(client = pool) {
  const sql = await readFile(path.join(projectRoot, 'schema.sql'), 'utf8');
  await client.query("SET client_min_messages TO WARNING");
  await client.query(sql);
}

export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function audit(client, actorId, action, targetType, targetId, detail = {}) {
  await client.query(
    `INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    // Stringify eksplisit: array JS akan dikirim pg sebagai array PostgreSQL ('{a,b}'), bukan JSON.
    [actorId, action, targetType, targetId == null ? null : String(targetId), JSON.stringify(detail ?? {})]
  );
}
