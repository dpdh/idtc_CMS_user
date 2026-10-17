// Definisi resource konten CMS. Dipakai oleh endpoint publik (serializer) dan CRUD admin generik.
import { SLUG_PATTERN, UUID_PATTERN, badRequest, fileUrl, notFound, toStoragePath } from './http.js';

const s = (column, options = {}) => ({ column, type: 'string', max: 255, ...options });
const text = (column, options = {}) => ({ column, type: 'string', max: 20000, ...options });
const intField = (column, options = {}) => ({ column, type: 'int', ...options });
const boolField = (column, options = {}) => ({ column, type: 'bool', ...options });
const arr = (column, options = {}) => ({ column, type: 'array', ...options });
const json = (column, options = {}) => ({ column, type: 'json', ...options });
const file = (column, options = {}) => ({ column, type: 'file', ...options });
const timestamp = (column, options = {}) => ({ column, type: 'timestamp', ...options });

export const RESOURCES = {
  kordas: {
    table: 'kordas', pk: 'id', pkType: 'slug', label: 'Korda', order: 'sort_order, id',
    fields: {
      label: s('label', { required: true, max: 120 }), region: s('region', { max: 120 }), ketua: s('ketua', { max: 120 }),
      phone: s('phone', { max: 20 }), icon: s('icon', { max: 60 }), sortOrder: intField('sort_order'), isActive: boolField('is_active')
    }
  },
  'motivasi-categories': {
    table: 'motivasi_categories', pk: 'id', pkType: 'slug', label: 'Kategori Motivasi', order: 'sort_order, id',
    fields: {
      title: s('title', { required: true, max: 150 }), subtitle: s('subtitle', { max: 150 }), description: s('description', { max: 500 }),
      icon: s('icon', { max: 60 }), color: s('color', { max: 20 }), gradient: arr('gradient'), quoteTags: arr('quote_tags'),
      sortOrder: intField('sort_order'), isActive: boolField('is_active')
    }
  },
  quotes: {
    table: 'quotes', pk: 'id', pkType: 'uuid', label: 'Quote', order: 'category, created_at', search: ['text', 'author', 'category'],
    fields: {
      text: s('text', { required: true, max: 1000 }), author: s('author', { max: 150 }), category: s('category', { max: 80 }),
      isActive: boolField('is_active')
    }
  },
  articles: {
    table: 'articles', pk: 'id', pkType: 'uuid', label: 'Artikel', order: 'section, category_id, sort_order, published_at DESC',
    search: ['title', 'summary'],
    fields: {
      section: s('section', { enum: ['motivasi', 'artikel'] }), categoryId: s('category_id', { max: 60, nullable: true }),
      title: s('title', { required: true, max: 200 }), summary: s('summary', { max: 600 }), content: text('content'),
      author: s('author', { max: 150 }), readTime: s('read_time', { max: 30 }), icon: s('icon', { max: 60 }),
      coverImage: file('cover_path'), status: s('status', { enum: ['draft', 'published'] }), sortOrder: intField('sort_order'),
      publishedAt: timestamp('published_at')
    }
  },
  doas: {
    table: 'doas', pk: 'id', pkType: 'uuid', label: 'Doa', order: 'sort_order, title', search: ['title', 'meaning', 'category'],
    fields: {
      category: s('category', { required: true, max: 60 }), title: s('title', { required: true, max: 200 }),
      arabic: text('arabic', { nullable: true }), latin: text('latin', { nullable: true }), meaning: text('meaning', { required: true }),
      source: s('source', { max: 150, nullable: true }), icon: s('icon', { max: 60 }), debt: boolField('debt'),
      sortOrder: intField('sort_order'), isActive: boolField('is_active')
    }
  },
  programs: {
    table: 'programs', pk: 'slug', pkType: 'slug', label: 'Program', order: 'grp, sort_order, slug',
    fields: {
      group: s('grp', { enum: ['utama', 'kegiatan'] }), title: s('title', { required: true, max: 150 }), subtitle: s('subtitle', { max: 150 }),
      description: text('description'), icon: s('icon', { max: 60 }), gradient: arr('gradient'), data: json('data'),
      relatedEventType: s('related_event_type', { max: 60, nullable: true }), sortOrder: intField('sort_order'), isActive: boolField('is_active')
    }
  },
  'infaq-programs': {
    table: 'infaq_programs', pk: 'id', pkType: 'slug', label: 'Program Infaq', order: 'sort_order, id',
    fields: {
      title: s('title', { required: true, max: 150 }), shortLabel: s('short_label', { required: true, max: 60 }),
      description: text('description'), icon: s('icon', { max: 60 }), gradient: arr('gradient'),
      bankName: s('bank_name', { required: true, max: 120 }), bankAccount: s('bank_account', { required: true, max: 60 }),
      bankHolder: s('bank_holder', { required: true, max: 120 }), qrisImage: file('qris_path'),
      whatsappConfirm: s('whatsapp_confirm', { max: 20 }), sortOrder: intField('sort_order'), isActive: boolField('is_active')
    }
  },
  'social-links': {
    table: 'social_links', pk: 'id', pkType: 'slug', label: 'Link Sosial', order: 'sort_order, id',
    fields: {
      name: s('name', { required: true, max: 80 }), icon: s('icon', { required: true, max: 60 }), color: s('color', { max: 20 }),
      gradient: arr('gradient'), handle: s('handle', { max: 120 }), url: s('url', { required: true, max: 500 }),
      deepLink: s('deep_link', { max: 500, nullable: true }), cta: s('cta', { max: 30 }), sortOrder: intField('sort_order'),
      isActive: boolField('is_active')
    }
  },
  'social-posts': {
    table: 'social_posts', pk: 'id', pkType: 'uuid', label: 'Post Sosial', order: 'published_at DESC',
    fields: {
      platform: s('platform', { required: true, enum: ['instagram', 'tiktok', 'youtube'] }), type: s('type', { max: 30 }),
      title: s('title', { required: true, max: 200 }), description: s('description', { max: 1000 }),
      thumbnail: file('thumbnail'), url: s('url', { required: true, max: 500 }), deepLink: s('deep_link', { max: 500, nullable: true }),
      publishedAt: timestamp('published_at'), isActive: boolField('is_active')
    }
  },
  'riyadhoh-items': {
    table: 'riyadhoh_items', pk: 'id', pkType: 'slug', label: 'Item Riyadhoh', order: 'sort_order, id', noDelete: true,
    fields: {
      name: s('name', { required: true, max: 120 }), category: s('category', { required: true, max: 80 }), icon: s('icon', { max: 60 }),
      rakaat: intField('rakaat', { nullable: true }), sortOrder: intField('sort_order'), isActive: boolField('is_active')
    }
  },
  'riyadhoh-docs': {
    table: 'riyadhoh_docs', pk: 'id', pkType: 'slug', label: 'Dokumen Riyadhoh', order: 'sort_order, id',
    fields: { title: s('title', { required: true, max: 150 }), body: text('body', { required: true }), sortOrder: intField('sort_order') }
  },
  stories: {
    table: 'stories', pk: 'id', pkType: 'slug', label: 'Kisah', order: 'category, sort_order, id', search: ['title', 'person', 'summary'],
    fields: {
      category: s('category', { required: true, enum: ['rasul', 'nabi', 'sahabat'] }), title: s('title', { required: true, max: 200 }),
      person: s('person', { max: 150 }), summary: s('summary', { max: 600 }), body: text('body', { required: true }),
      sortOrder: intField('sort_order'), isActive: boolField('is_active')
    }
  },
  'quiz-questions': {
    table: 'quiz_questions', pk: 'id', pkType: 'slug', label: 'Soal Kuis', order: 'sort_order, id', search: ['question', 'category', 'answer'],
    fields: {
      category: s('category', { required: true, max: 80 }), question: s('question', { required: true, max: 500 }),
      choices: arr('choices', { required: true }), answer: s('answer', { required: true, max: 200 }),
      explanation: s('explanation', { max: 1000 }), sortOrder: intField('sort_order'), isActive: boolField('is_active')
    }
  },
  books: {
    table: 'books', pk: 'id', pkType: 'slug', label: 'Buku', order: 'sort_order, id', search: ['title', 'description'],
    fields: {
      title: s('title', { required: true, max: 200 }), coverTitle: s('cover_title', { max: 120 }), coverCaption: s('cover_caption', { max: 200 }),
      meta: s('meta', { max: 120 }), description: s('description', { max: 1000 }), coverImage: file('cover_path'),
      url: s('url', { required: true, max: 500 }), sortOrder: intField('sort_order'), isActive: boolField('is_active')
    }
  },
  'worship-groups': {
    table: 'worship_groups', pk: 'id', pkType: 'slug', label: 'Grup Ibadah', order: 'sort_order, id',
    fields: {
      name: s('name', { required: true, max: 120 }), description: s('description', { max: 500 }), schedule: s('schedule', { max: 80 }),
      icon: s('icon', { max: 60 }), color: s('color', { max: 20 }),
      reminderKey: s('reminder_key', { max: 60, nullable: true, enum: ['tahajudCallEnabled', 'dhuhaReminderEnabled', 'taubatReminderEnabled'] }),
      sortOrder: intField('sort_order'), isActive: boolField('is_active')
    }
  },
  'event-types': referenceResource('event_type', 'Tipe Event'),
  'lapak-categories': referenceResource('lapak_category', 'Kategori Lapak'),
  'question-categories': referenceResource('question_category', 'Kategori Tanya'),
  'testimonial-programs': referenceResource('testimonial_program', 'Program Testimoni'),
  'doa-categories': referenceResource('doa_category', 'Kategori Doa')
};

function referenceResource(kind, label) {
  return {
    table: 'reference_items', pk: 'code', pkType: 'code', label, order: 'sort_order, code', fixed: { kind },
    fields: {
      label: s('label', { required: true, max: 120 }), icon: s('icon', { max: 60, nullable: true }),
      color: s('color', { max: 20, nullable: true }), sortOrder: intField('sort_order'), isActive: boolField('is_active')
    }
  };
}

export function serializeResource(request, resource, row) {
  const output = { id: row[resource.pk] };
  for (const [key, field] of Object.entries(resource.fields)) {
    const value = row[field.column];
    output[key] = field.type === 'file' ? fileUrl(request, value) : value;
  }
  return output;
}

export function validateId(resource, value) {
  if (resource.pkType === 'uuid') {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw notFound(`${resource.label} tidak ditemukan.`);
  } else if (resource.pkType === 'slug') {
    if (typeof value !== 'string' || !SLUG_PATTERN.test(value)) throw badRequest('ID harus slug huruf kecil (a-z, 0-9, -).', 'id');
  } else if (typeof value !== 'string' || !value.trim() || value.length > 60) {
    throw badRequest('Kode tidak valid.', 'id');
  }
  return value;
}

// Ubah body (camelCase) jadi pasangan kolom/nilai yang tervalidasi.
export function parseResourceBody(resource, body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Format data tidak valid.');
  const columns = [];
  const values = [];
  for (const [key, field] of Object.entries(resource.fields)) {
    if (!(key in body)) {
      if (field.required && !partial) throw badRequest(`${key} wajib diisi.`, key);
      continue;
    }
    columns.push(field.column);
    values.push(parseValue(key, field, body[key]));
  }
  return { columns, values };
}

function parseValue(key, field, raw) {
  const empty = raw === null || raw === undefined || raw === '';
  if (empty) {
    if (field.required) throw badRequest(`${key} wajib diisi.`, key);
    if (field.type === 'array') return [];
    if (field.type === 'json') return {};
    if (field.type === 'bool') return false;
    if (field.type === 'string' && !field.nullable) return '';
    return null;
  }
  switch (field.type) {
    case 'string': {
      const value = String(raw).trim();
      if (value.length > field.max) throw badRequest(`${key} maksimal ${field.max} karakter.`, key);
      if (field.enum && !field.enum.includes(value)) throw badRequest(`${key} harus salah satu dari: ${field.enum.join(', ')}.`, key);
      return value;
    }
    case 'int': {
      const value = Number(raw);
      if (!Number.isInteger(value)) throw badRequest(`${key} harus angka bulat.`, key);
      return value;
    }
    case 'bool':
      return raw === true || raw === 'true' || raw === 1 || raw === '1';
    case 'array': {
      const list = Array.isArray(raw) ? raw : String(raw).split(',');
      return list.map((item) => String(item).trim()).filter(Boolean);
    }
    case 'json': {
      const value = typeof raw === 'string' ? safeJson(key, raw) : raw;
      if (typeof value !== 'object') throw badRequest(`${key} harus JSON object.`, key);
      return value;
    }
    case 'file': {
      const value = toStoragePath(raw);
      if (!value) throw badRequest(`${key} harus URL hasil upload.`, key);
      return value;
    }
    case 'timestamp': {
      if (Number.isNaN(Date.parse(raw))) throw badRequest(`${key} harus tanggal yang valid.`, key);
      return new Date(raw).toISOString();
    }
    default:
      return raw;
  }
}

function safeJson(key, raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest(`${key} harus JSON yang valid.`, key);
  }
}
