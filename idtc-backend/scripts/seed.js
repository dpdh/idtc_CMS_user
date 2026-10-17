// Isi database dengan konten dari seeds/content.json.
// `npm run db:seed` → master + konten CMS. Tambah `-- --samples` untuk event & testimoni contoh (dev/demo).
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const { ensureSchema, pool, withTransaction } = await import('../src/db.js');
const { ensureBootstrapAdmin, loadSeedContent, seedBase, seedContent, seedSamples } = await import('../src/seed.js');

const withSamples = process.argv.includes('--samples');
try {
  await ensureSchema();
  const content = await loadSeedContent();
  await withTransaction(async (client) => {
    await seedBase(client, content);
    await seedContent(client, content);
    if (withSamples) await seedSamples(client, content);
    await ensureBootstrapAdmin(client);
  });
  const counts = await pool.query(`
    SELECT (SELECT count(*) FROM quotes) AS quotes, (SELECT count(*) FROM articles) AS articles,
           (SELECT count(*) FROM doas) AS doas, (SELECT count(*) FROM kordas) AS kordas,
           (SELECT count(*) FROM riyadhoh_items) AS riyadhoh_items, (SELECT count(*) FROM programs) AS programs,
           (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM testimonials) AS testimonials`);
  console.log('Seed selesai:', counts.rows[0]);
} catch (error) {
  console.error('Seed gagal:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
