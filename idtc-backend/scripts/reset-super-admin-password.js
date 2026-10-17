// Reset password Super Admin (pola idtc-user). Password diketik tersembunyi di terminal, bukan lewat argumen/env.
// Pemakaian: npm run admin:reset-password            → akun ADMIN_EMAIL dari .env
//            npm run admin:reset-password -- email@x  → akun lain
// Ke database production: DATABASE_URL='postgresql://...' npm run admin:reset-password
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { emitKeypressEvents } from 'node:readline';
import pg from 'pg';

dotenv.config({ quiet: true });

const email = (process.argv[2] || process.env.ADMIN_EMAIL || '').trim().toLowerCase();

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('Jalankan perintah ini langsung di terminal interaktif agar password tidak terlihat.'));
      return;
    }

    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    process.stdout.write(prompt);
    let value = '';

    const finish = (error) => {
      input.off('keypress', onKeypress);
      process.off('SIGINT', onInterrupt);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onInterrupt = () => finish(new Error('Reset password dibatalkan.'));
    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('Reset password dibatalkan.'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        return;
      }
      if (character && !key.ctrl && !key.meta) value += character;
    };

    input.on('keypress', onKeypress);
    process.once('SIGINT', onInterrupt);
  });
}

async function resetPassword() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL belum diatur. Isi .env atau set DATABASE_URL saat menjalankan perintah.');
  if (!email || !email.includes('@')) throw new Error('Email Super Admin belum diketahui. Isi ADMIN_EMAIL di .env atau berikan email sebagai argumen.');

  const password = await readHidden(`Password baru untuk ${email} (minimal 12 karakter, input tersembunyi): `);
  const confirmation = await readHidden('Ulangi password baru: ');
  if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Password harus minimal 12 karakter dan maksimal 72 byte.');
  }
  if (password !== confirmation) throw new Error('Konfirmasi password tidak sama.');

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(password, 12);
    const account = await client.query('SELECT id FROM users WHERE lower(email) = $1 FOR UPDATE', [email]);
    let userId;
    if (account.rowCount) {
      userId = account.rows[0].id;
      await client.query(
        `UPDATE users SET password_hash = $1, status = 'active', must_change_password = FALSE,
         email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [passwordHash, userId]
      );
    } else {
      const created = await client.query(
        `INSERT INTO users (full_name, email, password_hash, membership_type, status, email_verified_at)
         VALUES ($1, $2, $3, 'sahabat', 'active', CURRENT_TIMESTAMP) RETURNING id`,
        [process.env.ADMIN_NAME || 'Super Admin IDTC', email, passwordHash]
      );
      userId = created.rows[0].id;
    }
    await client.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'super_admin'
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [userId]
    );
    await client.query(
      'UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    );
    await client.query('COMMIT');
    console.log(`Akun Super Admin siap untuk ${email}. Password tersimpan sebagai hash; sesi lama sudah dicabut.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

resetPassword().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
