import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const { createApp } = await import('./src/app.js');
const { ensureSchema, pool } = await import('./src/db.js');
const { ensureBootstrapAdmin, loadSeedContent, seedBase } = await import('./src/seed.js');
const { ensureUploadDirectories } = await import('./src/uploads.js');

async function startServer() {
  await ensureUploadDirectories();
  const port = Number(process.env.PORT || 3100);
  const app = createApp();
  app.listen(port, '0.0.0.0', async () => {
    console.log(`[startup] IDTC backend berjalan di 0.0.0.0:${port} (admin: /admin, API: /api/v1)`);
    if (!process.env.DATABASE_URL) {
      console.error('[startup] DATABASE_URL belum diatur; API belum aktif.');
      return;
    }
    try {
      await pool.query('SELECT 1');
      await ensureSchema();
      await seedBase(pool, await loadSeedContent());
      await ensureBootstrapAdmin(pool);
      console.log('[startup] PostgreSQL siap.');
    } catch (error) {
      console.error('[startup] PostgreSQL gagal disiapkan:', error.message);
    }
  });
}

startServer().catch(async (error) => {
  console.error('[startup] server gagal dijalankan:', error.message);
  await pool.end();
  process.exit(1);
});
