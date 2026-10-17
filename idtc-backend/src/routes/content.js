import { createHash } from 'node:crypto';
import { Router } from 'express';
import { pool } from '../db.js';
import { badRequest, fileUrl, likePattern, notFound, pageMeta, paging, sendData, todayWib } from '../http.js';
import { RESOURCES, serializeResource } from '../resources.js';
import { serializeTestimonial, TESTIMONIAL_SELECT } from './community.js';
import { EVENT_SELECT, serializeEvent } from './events.js';
import { PRODUCT_SELECT } from './lapak.js';
import { riyadhohToday } from './riyadhoh.js';

// Nilai default konfigurasi app; dapat ditimpa admin lewat tabel site_content (pola idtc-user).
export const DEFAULT_SITE_CONTENT = {
  app_name: 'IDTC App',
  app_tagline: 'Hijrah Bersama, Tumbuh Bersama, Bebas Utang Bersama',
  latest_version: '1.0.0',
  min_supported_version: '1.0.0',
  store_url_android: 'https://play.google.com/store/apps/details?id=com.nasuha.nasjak',
  store_url_ios: '',
  release_date: '2026-08-08',
  author: 'Dani Hamdani',
  organization: 'Komunitas IDTC Jakarta',
  website: 'https://nasuha.org',
  contact_whatsapp: '',
  contact_email: 'info@nasuha.id',
  contact_instagram: 'komunitasnasuha',
  about_features: JSON.stringify([
    'Al-Quran 30 Juz + audio murottal',
    'Hadis 9 kitab',
    'Jadwal sholat, kiblat & masjid terdekat',
    'Riyadhoh harian & streak',
    'Motivasi, doa & artikel',
    'Event, TSN & LBU',
    'Lapak sahabat IDTC',
    'Tanya Praktisi & testimoni'
  ])
};

export async function loadSiteContent() {
  const result = await pool.query('SELECT content_key, content_value FROM site_content');
  const content = { ...DEFAULT_SITE_CONTENT };
  for (const row of result.rows) content[row.content_key] = row.content_value;
  return content;
}

export async function loadMembershipPlans() {
  const result = await pool.query(
    `SELECT p.type, p.label, p.description, p.color, f.id AS feature_id, f.name, f.description AS feature_description,
            f.icon, COALESCE(pf.enabled, FALSE) AS enabled
     FROM membership_plans p
     CROSS JOIN membership_features f
     LEFT JOIN membership_plan_features pf ON pf.plan_type = p.type AND pf.feature_id = f.id
     ORDER BY p.sort_order, f.sort_order`
  );
  const plans = [];
  for (const row of result.rows) {
    let plan = plans.find((item) => item.type === row.type);
    if (!plan) {
      plan = { type: row.type, label: row.label, description: row.description, color: row.color, features: [] };
      plans.push(plan);
    }
    plan.features.push({
      id: row.feature_id, name: row.name, description: row.feature_description, icon: row.icon, enabled: row.enabled
    });
  }
  return plans;
}

async function dailyQuote(date = todayWib()) {
  const count = await pool.query('SELECT count(*)::int AS total FROM quotes WHERE is_active');
  if (!count.rows[0].total) return null;
  const offset = parseInt(createHash('sha256').update(date).digest('hex').slice(0, 8), 16) % count.rows[0].total;
  const result = await pool.query(
    'SELECT id, text, author, category FROM quotes WHERE is_active ORDER BY legacy_id NULLS LAST, id OFFSET $1 LIMIT 1',
    [offset]
  );
  return result.rows[0];
}

function listResource(resourceKey, { where = 'TRUE', values = [], order } = {}) {
  const resource = RESOURCES[resourceKey];
  return pool.query(`SELECT * FROM ${resource.table} WHERE ${where} ORDER BY ${order || resource.order}`, values);
}

export function contentRoutes() {
  const router = Router();

  router.get('/config', async (_request, response) => {
    const content = await loadSiteContent();
    let features = [];
    try {
      features = JSON.parse(content.about_features);
    } catch {
      features = [];
    }
    return sendData(response, {
      app: {
        name: content.app_name,
        tagline: content.app_tagline,
        latestVersion: content.latest_version,
        minSupportedVersion: content.min_supported_version,
        storeUrl: { android: content.store_url_android || null, ios: content.store_url_ios || null },
        releaseDate: content.release_date,
        author: content.author,
        organization: content.organization,
        website: content.website,
        features
      },
      contact: { whatsapp: content.contact_whatsapp, email: content.contact_email, instagram: content.contact_instagram },
      featureFlags: { googleLogin: false, asistenAi: false },
      membershipPlans: await loadMembershipPlans()
    });
  });

  router.get('/references', async (_request, response) => {
    const [kordas, refs] = await Promise.all([
      pool.query('SELECT id, label, region, sort_order FROM kordas WHERE is_active ORDER BY sort_order, id'),
      pool.query('SELECT kind, code, label, icon, color FROM reference_items WHERE is_active ORDER BY kind, sort_order, code')
    ]);
    const byKind = (kind) => refs.rows.filter((row) => row.kind === kind);
    return sendData(response, {
      kordas: kordas.rows.map((row) => ({ id: row.id, label: row.label, region: row.region, sortOrder: row.sort_order })),
      eventTypes: byKind('event_type').map((row) => ({ id: row.code, label: row.label, color: row.color })),
      lapakCategories: byKind('lapak_category').map((row) => ({ id: row.code, label: row.label, icon: row.icon })),
      questionCategories: byKind('question_category').map((row) => row.code),
      testimonialPrograms: byKind('testimonial_program').map((row) => row.code),
      doaCategories: byKind('doa_category').map((row) => row.code),
      genders: [{ id: 'laki-laki', label: 'Laki-laki' }, { id: 'perempuan', label: 'Perempuan' }],
      productConditions: ['Baru', 'Bekas'],
      infaqNominals: [10000, 25000, 50000, 100000, 250000, 500000]
    });
  });

  router.get('/membership-plans', async (_request, response) => sendData(response, await loadMembershipPlans()));

  router.get('/home', async (request, response) => {
    const today = todayWib();
    const [quote, events, testimonial, posts] = await Promise.all([
      dailyQuote(today),
      pool.query(`${EVENT_SELECT} FROM events e WHERE e.status = 'published' AND e.event_date >= $1
                  ORDER BY e.event_date, e.event_time LIMIT 3`, [today]),
      pool.query(`${TESTIMONIAL_SELECT} WHERE t.status = 'approved' ORDER BY t.rating DESC, t.testimony_date DESC LIMIT 1`),
      listResource('social-posts', { where: 'is_active', order: 'published_at DESC LIMIT 3' })
    ]);
    const data = {
      quoteOfTheDay: quote || null,
      upcomingEvents: events.rows.map((row) => serializeEvent(request, row)),
      featuredTestimonial: testimonial.rows[0] ? serializeTestimonial(request, testimonial.rows[0]) : null,
      socialPosts: posts.rows.map((row) => serializeResource(request, RESOURCES['social-posts'], row)),
      riyadhohToday: null,
      unreadNotifications: 0
    };
    if (request.user) {
      const unread = await pool.query('SELECT count(*)::int AS total FROM notifications WHERE user_id = $1 AND read_at IS NULL', [request.user.id]);
      data.unreadNotifications = unread.rows[0].total;
      data.riyadhohToday = await riyadhohToday(request.user.id);
    }
    return sendData(response, data);
  });

  router.get('/search', async (request, response) => {
    const q = typeof request.query.q === 'string' ? request.query.q.trim() : '';
    if (q.length < 2) throw badRequest('Kata kunci minimal 2 karakter.', 'q');
    const like = likePattern(q);
    const allTypes = ['events', 'products', 'articles', 'quotes', 'doas', 'testimonials', 'questions'];
    const requested = typeof request.query.types === 'string' ? request.query.types.split(',') : allTypes;
    const types = allTypes.filter((type) => requested.includes(type));
    const queries = {
      events: () => pool.query(
        `SELECT id, title, type, event_date FROM events WHERE status = 'published' AND (title ILIKE $1 OR description ILIKE $1 OR type ILIKE $1)
         ORDER BY event_date DESC LIMIT 5`, [like]
      ).then((result) => result.rows.map((row) => ({ id: row.id, title: row.title, subtitle: `${row.type} · ${row.event_date}`, route: `/event/${row.id}` }))),
      products: () => pool.query(
        `${PRODUCT_SELECT} WHERE p.status = 'approved' AND (p.name ILIKE $1 OR p.description ILIKE $1) ORDER BY p.created_at DESC LIMIT 5`, [like]
      ).then((result) => result.rows.map((row) => ({ id: row.id, title: row.name, subtitle: `Rp ${Number(row.price).toLocaleString('id-ID')}`, route: `/lapak/${row.id}` }))),
      articles: () => pool.query(
        `SELECT id, title, summary FROM articles WHERE status = 'published' AND (title ILIKE $1 OR summary ILIKE $1 OR content ILIKE $1) LIMIT 5`, [like]
      ).then((result) => result.rows.map((row) => ({ id: row.id, title: row.title, subtitle: row.summary.slice(0, 80), route: `/motivasi/article/${row.id}` }))),
      quotes: () => pool.query(
        `SELECT id, text, author FROM quotes WHERE is_active AND (text ILIKE $1 OR author ILIKE $1 OR category ILIKE $1) LIMIT 5`, [like]
      ).then((result) => result.rows.map((row) => ({ id: row.id, title: row.text.length > 80 ? `${row.text.slice(0, 80)}...` : row.text, subtitle: row.author, route: '/motivasi' }))),
      doas: () => pool.query(
        `SELECT id, title, category FROM doas WHERE is_active AND (title ILIKE $1 OR meaning ILIKE $1 OR latin ILIKE $1) LIMIT 5`, [like]
      ).then((result) => result.rows.map((row) => ({ id: row.id, title: row.title, subtitle: row.category, route: '/doa' }))),
      testimonials: () => pool.query(
        `SELECT id, display_name, program, text FROM testimonials WHERE status = 'approved' AND (text ILIKE $1 OR display_name ILIKE $1) LIMIT 5`, [like]
      ).then((result) => result.rows.map((row) => ({ id: row.id, title: row.display_name, subtitle: `${row.program} · ${row.text.slice(0, 60)}`, route: '/testimoni' }))),
      questions: () => pool.query(
        `SELECT id, title, category FROM questions WHERE title ILIKE $1 OR body ILIKE $1 ORDER BY created_at DESC LIMIT 5`, [like]
      ).then((result) => result.rows.map((row) => ({ id: row.id, title: row.title, subtitle: row.category, route: `/tanya/${row.id}` })))
    };
    const results = await Promise.all(types.map((type) => queries[type]()));
    return sendData(response, Object.fromEntries(types.map((type, index) => [type, results[index]])));
  });

  // ---- Motivasi ----
  router.get('/motivasi/categories', async (request, response) => {
    const [rows, counts] = await Promise.all([
      listResource('motivasi-categories', { where: 'is_active' }),
      pool.query(`SELECT category_id, count(*)::int AS total FROM articles WHERE status = 'published' GROUP BY category_id`)
    ]);
    const countMap = Object.fromEntries(counts.rows.map((row) => [row.category_id, row.total]));
    return sendData(response, rows.rows.map((row) => ({
      ...serializeResource(request, RESOURCES['motivasi-categories'], row),
      articlesCount: countMap[row.id] || 0
    })));
  });

  router.get('/motivasi/categories/:id', async (request, response) => {
    const result = await listResource('motivasi-categories', { where: 'id = $1 AND is_active', values: [request.params.id] });
    const row = result.rows[0];
    if (!row) throw notFound('Kategori tidak ditemukan.');
    const [quote, articles] = await Promise.all([
      row.quote_tags.length
        ? pool.query('SELECT id, text, author, category FROM quotes WHERE is_active AND category = ANY($1) ORDER BY random() LIMIT 1', [row.quote_tags])
        : Promise.resolve({ rows: [] }),
      pool.query(
        `SELECT id, legacy_id, category_id, title, summary, author, read_time, icon, cover_path, published_at FROM articles
         WHERE status = 'published' AND category_id = $1 ORDER BY sort_order, published_at DESC`,
        [row.id]
      )
    ]);
    return sendData(response, {
      ...serializeResource(request, RESOURCES['motivasi-categories'], row),
      quote: quote.rows[0] || null,
      articles: articles.rows.map((article) => serializeArticle(request, article))
    });
  });

  router.get('/quotes/daily', async (_request, response) => sendData(response, await dailyQuote()));

  router.get('/quotes', async (request, response) => {
    const page = paging(request.query, { defaultPerPage: 50, maxPerPage: 500 });
    const values = [];
    let where = 'is_active';
    if (request.query.category) {
      values.push(String(request.query.category));
      where += ` AND category = $${values.length}`;
    }
    const order = request.query.random === '1' ? 'random()' : 'legacy_id NULLS LAST, id';
    const [rows, count] = await Promise.all([
      pool.query(`SELECT id, text, author, category FROM quotes WHERE ${where} ORDER BY ${order} LIMIT ${page.perPage} OFFSET ${page.offset}`, values),
      pool.query(`SELECT count(*)::int AS total FROM quotes WHERE ${where}`, values)
    ]);
    return sendData(response, rows.rows, pageMeta(page, count.rows[0].total));
  });

  router.get('/articles', async (request, response) => {
    const page = paging(request.query, { defaultPerPage: 50 });
    const filters = ["status = 'published'"];
    const values = [];
    for (const [param, column] of [['categoryId', 'category_id'], ['section', 'section']]) {
      if (request.query[param]) {
        values.push(String(request.query[param]));
        filters.push(`${column} = $${values.length}`);
      }
    }
    if (request.query.q) {
      values.push(likePattern(String(request.query.q)));
      filters.push(`(title ILIKE $${values.length} OR summary ILIKE $${values.length})`);
    }
    const where = filters.join(' AND ');
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT id, legacy_id, section, category_id, title, summary, author, read_time, icon, cover_path, published_at
         FROM articles WHERE ${where} ORDER BY sort_order, published_at DESC LIMIT ${page.perPage} OFFSET ${page.offset}`,
        values
      ),
      pool.query(`SELECT count(*)::int AS total FROM articles WHERE ${where}`, values)
    ]);
    return sendData(response, rows.rows.map((row) => serializeArticle(request, row)), pageMeta(page, count.rows[0].total));
  });

  router.get('/articles/:id', async (request, response) => {
    const id = request.params.id;
    const isLegacy = /^\d+$/.test(id);
    if (!isLegacy && !/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Artikel tidak ditemukan.');
    const result = await pool.query(
      `SELECT * FROM articles WHERE status = 'published' AND ${isLegacy ? 'legacy_id = $1' : 'id = $1'}`,
      [isLegacy ? Number(id) : id]
    );
    const row = result.rows[0];
    if (!row) throw notFound('Artikel tidak ditemukan.');
    let category = null;
    if (row.category_id) {
      const categoryResult = await listResource('motivasi-categories', { where: 'id = $1', values: [row.category_id] });
      if (categoryResult.rows[0]) category = serializeResource(request, RESOURCES['motivasi-categories'], categoryResult.rows[0]);
    }
    return sendData(response, { ...serializeArticle(request, row), content: row.content, category });
  });

  router.get('/doas', async (request, response) => {
    const filters = ['is_active'];
    const values = [];
    if (request.query.category) {
      values.push(String(request.query.category));
      filters.push(`category = $${values.length}`);
    }
    if (request.query.debt === 'true') filters.push('debt');
    if (request.query.q) {
      values.push(likePattern(String(request.query.q)));
      filters.push(`(title ILIKE $${values.length} OR meaning ILIKE $${values.length} OR latin ILIKE $${values.length})`);
    }
    const result = await listResource('doas', { where: filters.join(' AND '), values });
    return sendData(response, result.rows.map((row) => serializeResource(request, RESOURCES.doas, row)));
  });

  router.get('/programs', async (request, response) => {
    const values = [];
    let where = 'is_active';
    if (request.query.group) {
      values.push(String(request.query.group));
      where += ` AND grp = $${values.length}`;
    }
    const result = await listResource('programs', { where, values });
    const programs = result.rows.map((row) => serializeResource(request, RESOURCES.programs, row));
    const kegiatan = programs.filter((program) => program.group === 'kegiatan');
    const summary = kegiatan.reduce((total, program) => ({
      events: total.events + (program.data?.stats?.events || 0),
      beneficiaries: total.beneficiaries + (program.data?.stats?.beneficiaries || 0),
      volunteers: total.volunteers + (program.data?.stats?.volunteers || 0)
    }), { events: 0, beneficiaries: 0, volunteers: 0 });
    return sendData(response, programs, { kegiatanSummary: summary });
  });

  router.get('/programs/:slug', async (request, response) => {
    const result = await listResource('programs', { where: 'slug = $1 AND is_active', values: [request.params.slug] });
    if (!result.rows[0]) throw notFound('Program tidak ditemukan.');
    return sendData(response, serializeResource(request, RESOURCES.programs, result.rows[0]));
  });

  const simpleList = (path, resourceKey) => {
    router.get(path, async (request, response) => {
      const result = await listResource(resourceKey, { where: 'is_active' });
      return sendData(response, result.rows.map((row) => serializeResource(request, RESOURCES[resourceKey], row)));
    });
  };
  simpleList('/kordas', 'kordas');
  simpleList('/infaq/programs', 'infaq-programs');
  simpleList('/social/links', 'social-links');

  router.get('/social/posts', async (request, response) => {
    const values = [];
    let where = 'is_active';
    if (request.query.platform) {
      values.push(String(request.query.platform));
      where += ` AND platform = $${values.length}`;
    }
    const limit = Math.min(50, Math.max(1, Number.parseInt(request.query.limit, 10) || 20));
    const result = await listResource('social-posts', { where, values, order: `published_at DESC LIMIT ${limit}` });
    return sendData(response, result.rows.map((row) => serializeResource(request, RESOURCES['social-posts'], row)));
  });

  return router;
}

function serializeArticle(request, row) {
  return {
    id: row.id,
    legacyId: row.legacy_id,
    section: row.section,
    categoryId: row.category_id,
    title: row.title,
    summary: row.summary,
    author: row.author,
    readTime: row.read_time,
    icon: row.icon,
    coverImage: fileUrl(request, row.cover_path),
    publishedAt: row.published_at
  };
}
