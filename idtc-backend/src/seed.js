// Seed data awal dari seeds/content.json (hasil ekstraksi konten app mobile).
// Idempoten: upsert berdasarkan primary key / legacy_id, sehingga aman dijalankan berulang.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { projectRoot } from './uploads.js';

export async function loadSeedContent() {
  return JSON.parse(await readFile(path.join(projectRoot, 'seeds', 'content.json'), 'utf8'));
}

// Data master yang wajib ada agar API berfungsi (fitur, plan, referensi, korda, item riyadhoh).
export async function seedBase(client, content) {
  for (const [index, feature] of content.membershipFeatures.entries()) {
    await client.query(
      `INSERT INTO membership_features (id, name, description, icon, sort_order) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, icon = EXCLUDED.icon,
         sort_order = EXCLUDED.sort_order`,
      [feature.id, feature.name, feature.description, feature.icon, index + 1]
    );
  }
  for (const [index, plan] of content.membershipPlans.entries()) {
    await client.query(
      `INSERT INTO membership_plans (type, label, description, color, sort_order) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (type) DO NOTHING`,
      [plan.type, plan.label, plan.description, plan.color, index + 1]
    );
    for (const [featureId, enabled] of Object.entries(plan.features)) {
      await client.query(
        `INSERT INTO membership_plan_features (plan_type, feature_id, enabled) VALUES ($1, $2, $3)
         ON CONFLICT (plan_type, feature_id) DO NOTHING`,
        [plan.type, featureId, enabled]
      );
    }
  }
  for (const [kind, items] of Object.entries(content.references)) {
    for (const [index, item] of items.entries()) {
      await client.query(
        `INSERT INTO reference_items (kind, code, label, icon, color, sort_order) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (kind, code) DO NOTHING`,
        [kind, item.code, item.label, item.icon || null, item.color || null, index + 1]
      );
    }
  }
  for (const korda of content.kordas) {
    await client.query(
      `INSERT INTO kordas (id, label, region, ketua, phone, icon, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [korda.id, korda.label, korda.region, korda.ketua, korda.phone, korda.icon, korda.sortOrder]
    );
  }
  for (const [index, item] of content.riyadhohItems.entries()) {
    await client.query(
      `INSERT INTO riyadhoh_items (id, name, category, icon, rakaat, sort_order) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [item.id, item.name, item.category, item.icon, item.rakaat ?? null, index + 1]
    );
  }
  for (const [index, doc] of content.riyadhohDocs.entries()) {
    await client.query(
      `INSERT INTO riyadhoh_docs (id, title, body, sort_order) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [doc.id, doc.title, doc.body, index + 1]
    );
  }
}

// Konten CMS (motivasi, artikel, doa, program, infaq, sosial).
export async function seedContent(client, content) {
  for (const quote of content.quotes) {
    await client.query(
      `INSERT INTO quotes (legacy_id, text, author, category) VALUES ($1, $2, $3, $4) ON CONFLICT (legacy_id) DO NOTHING`,
      [quote.id, quote.text, quote.author, quote.category]
    );
  }
  for (const [index, category] of content.motivasiCategories.entries()) {
    await client.query(
      `INSERT INTO motivasi_categories (id, title, subtitle, description, icon, color, gradient, quote_tags, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
      [category.id, category.title, category.subtitle, category.description, category.icon, category.color,
        category.gradient || [], category.quoteTags || [], index + 1]
    );
  }
  for (const [index, article] of content.articles.entries()) {
    const values = [article.id, article.section, article.categoryId, article.title, article.summary || '', article.content || '',
      article.author || 'Tim IDTC', article.readTime || '', article.icon || 'book', article.status || 'published', index + 1];
    if (article.id) {
      await client.query(
        `INSERT INTO articles (legacy_id, section, category_id, title, summary, content, author, read_time, icon, status, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (legacy_id) DO NOTHING`,
        values
      );
    } else {
      await client.query(
        `INSERT INTO articles (section, category_id, title, summary, content, author, read_time, icon, status, sort_order)
         SELECT $1::varchar, $2::varchar, $3::varchar, $4::varchar, $5, $6, $7, $8, $9, $10
         WHERE NOT EXISTS (SELECT 1 FROM articles WHERE title = $3 AND section = $1)`,
        values.slice(1)
      );
    }
  }
  for (const [index, doa] of content.doas.entries()) {
    await client.query(
      `INSERT INTO doas (legacy_id, category, title, arabic, latin, meaning, source, icon, debt, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (legacy_id) DO NOTHING`,
      [doa.id, doa.category, doa.title, doa.arabic || null, doa.latin || null, doa.meaning, doa.source || null,
        doa.icon, Boolean(doa.debt), index + 1]
    );
  }
  for (const [index, program] of content.programs.entries()) {
    await client.query(
      `INSERT INTO programs (slug, grp, title, subtitle, description, icon, gradient, data, related_event_type, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (slug) DO NOTHING`,
      [program.slug, program.grp, program.title, program.subtitle, program.description, program.icon, program.gradient || [],
        program.data || {}, program.relatedEventType, index + 1]
    );
  }
  for (const program of content.infaqPrograms) {
    await client.query(
      `INSERT INTO infaq_programs (id, title, short_label, description, icon, gradient, bank_name, bank_account, bank_holder,
         whatsapp_confirm, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
      [program.id, program.title, program.shortLabel, program.description, program.icon, program.gradient || [], program.bankName,
        program.bankAccount, program.bankHolder, program.whatsappConfirm, program.sortOrder]
    );
  }
  for (const link of content.socialLinks) {
    await client.query(
      `INSERT INTO social_links (id, name, icon, color, gradient, handle, url, deep_link, cta, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
      [link.id, link.name, link.icon, link.color, link.gradient || [], link.handle, link.url, link.deepLink || null, link.cta, link.sortOrder]
    );
  }
  for (const story of content.stories || []) {
    await client.query(
      `INSERT INTO stories (id, category, title, person, summary, body, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      [story.id, story.category, story.title, story.person, story.summary, story.body, story.sortOrder]
    );
  }
  for (const question of content.quizQuestions || []) {
    await client.query(
      `INSERT INTO quiz_questions (id, category, question, choices, answer, explanation, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      [question.id, question.category, question.question, question.choices, question.answer, question.explanation, question.sortOrder]
    );
  }
  for (const book of content.books || []) {
    await client.query(
      `INSERT INTO books (id, title, cover_title, cover_caption, meta, description, url, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
      [book.id, book.title, book.coverTitle, book.coverCaption, book.meta, book.description, book.url, book.sortOrder]
    );
  }
  for (const group of content.worshipGroups || []) {
    await client.query(
      `INSERT INTO worship_groups (id, name, description, schedule, icon, color, reminder_key, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
      [group.id, group.name, group.description, group.schedule, group.icon, group.color, group.reminderKey, group.sortOrder]
    );
  }
  const existingPosts = await client.query('SELECT count(*)::int AS total FROM social_posts');
  if (!existingPosts.rows[0].total) {
    for (const [index, post] of content.socialPosts.entries()) {
      await client.query(
        `INSERT INTO social_posts (platform, type, title, description, url, deep_link, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP - ($7 || ' hours')::interval)`,
        [post.platform, post.type, post.title, post.description, post.url, post.deepLink, String(index * 12)]
      );
    }
  }
}

// Data contoh (event & testimoni dari konstanta lama app). Hanya untuk dev/demo.
export async function seedSamples(client, content) {
  const events = await client.query('SELECT count(*)::int AS total FROM events');
  if (!events.rows[0].total) {
    for (const event of content.events) {
      await client.query(
        `INSERT INTO events (title, type, event_date, event_time, location, description, quota, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'published')`,
        [event.title, event.type, event.date, event.time, event.location, event.description, event.quota]
      );
    }
  }
  const testimonials = await client.query('SELECT count(*)::int AS total FROM testimonials');
  if (!testimonials.rows[0].total) {
    for (const testimonial of content.testimonials) {
      await client.query(
        `INSERT INTO testimonials (display_name, korda_id, korda_label, program, rating, text, status, testimony_date)
         VALUES ($1, $2, $3, $4, $5, $6, 'approved', $7)`,
        [testimonial.name, testimonial.kordaId, testimonial.korda, testimonial.program, testimonial.rating, testimonial.text, testimonial.date]
      );
    }
  }
}

// Bootstrap Super Admin dari .env (pola idtc-user: ADMIN_EMAIL + ADMIN_PASSWORD).
export async function ensureBootstrapAdmin(client) {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email && !password) {
    console.warn('[startup] ADMIN_EMAIL/ADMIN_PASSWORD belum diatur; Super Admin bootstrap dilewati.');
    return null;
  }
  if (!email || !password || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('ADMIN_EMAIL dan ADMIN_PASSWORD wajib diatur; password 8-72 byte.');
  }
  const existing = await client.query('SELECT id FROM users WHERE lower(email) = $1', [email]);
  let userId = existing.rows[0]?.id;
  if (!userId) {
    const passwordHash = await bcrypt.hash(password, 12);
    const inserted = await client.query(
      `INSERT INTO users (full_name, email, password_hash, membership_type, email_verified_at)
       VALUES ($1, $2, $3, 'sahabat', CURRENT_TIMESTAMP) RETURNING id`,
      [process.env.ADMIN_NAME || 'Super Admin IDTC', email, passwordHash]
    );
    userId = inserted.rows[0].id;
    console.log(`[startup] Super Admin dibuat: ${email}`);
  }
  await client.query(`UPDATE users SET status = 'active' WHERE id = $1`, [userId]);
  await client.query(
    `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'super_admin'
     ON CONFLICT (user_id, role_id) DO NOTHING`,
    [userId]
  );
  return userId;
}
