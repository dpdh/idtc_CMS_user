// Ekstrak konten hardcoded dari project mobile (NASJAK) menjadi seeds/content.json.
// Dijalankan sekali saat migrasi konten: `npm run seed:extract -- ../NASJAK`.
// Node >= 23.6 bisa meng-import file .ts secara langsung (type stripping).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.resolve(process.argv[2] || path.join(projectRoot, '..', 'NASJAK'));

// Ambil literal `const NAME ... = <literal>;` dari file .tsx yang tidak bisa di-import (berisi JSX).
async function extractLocalConst(relativeFile, name) {
  const source = await readFile(path.join(appRoot, relativeFile), 'utf8');
  const start = source.search(new RegExp(`const ${name}\\b`));
  if (start < 0) throw new Error(`${name} tidak ditemukan di ${relativeFile}`);
  const equals = source.indexOf('=', start);
  let index = equals + 1;
  while (/\s/.test(source[index])) index += 1;
  const open = source[index];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let quote = null;
  let end = index;
  for (; end < source.length; end += 1) {
    const char = source[end];
    if (quote) {
      if (char === '\\') { end += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const literal = source.slice(index, end + 1).replace(/\s+as const\b/g, '');
  return new Function(`return (${literal});`)();
}

const data = await import(pathToFileURL(path.join(appRoot, 'constants', 'data.ts')).href);
const doaModule = await import(pathToFileURL(path.join(appRoot, 'constants', 'doa.ts')).href);

const kordaContacts = data.KORDA_CONTACTS;
const kordaLabels = data.NASUHA_KORDA;

function slugify(value) {
  return value.toLowerCase().replace(/^korda\s+/, '').replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Satukan KORDA_CONTACTS (kontak) dan NASUHA_KORDA (label dropdown) menjadi satu master.
const kordas = kordaLabels.map((label, index) => {
  const id = slugify(label);
  const regionKey = label.replace(/^Korda\s+/, '');
  const contact = kordaContacts.find((item) => item.region.toLowerCase() === regionKey.toLowerCase())
    || kordaContacts.find((item) => regionKey.toLowerCase().startsWith(item.region.toLowerCase().split(/[\s/,]/)[0]));
  return {
    id,
    label,
    region: contact?.region || regionKey,
    ketua: contact?.ketua || '',
    phone: contact?.phone || '',
    icon: contact?.icon || 'location',
    sortOrder: index + 1
  };
});
for (const contact of kordaContacts) {
  if (!kordas.some((korda) => korda.region === contact.region)) {
    kordas.push({
      id: slugify(contact.region),
      label: `Korda ${contact.region}`,
      region: contact.region,
      ketua: contact.ketua,
      phone: contact.phone,
      icon: contact.icon,
      sortOrder: kordas.length + 1
    });
  }
}

function kordaIdFromLabel(label) {
  if (!label) return null;
  const normalized = label.toLowerCase();
  const exact = kordas.find((korda) => korda.label.toLowerCase() === normalized);
  if (exact) return exact.id;
  const keyword = normalized.replace(/^korda\s+/, '').split(/[\s(,-]/)[0];
  const aliases = { jogja: 'jateng-diy', yogyakarta: 'jateng-diy' };
  if (aliases[keyword]) return aliases[keyword];
  return kordas.find((korda) => korda.id.startsWith(keyword) || korda.region.toLowerCase().startsWith(keyword))?.id || null;
}

const eventTypes = await extractLocalConst('app/event/add.tsx', 'EVENT_TYPES');
const eventTypeColors = await extractLocalConst('app/admin/index.tsx', 'EVENT_TYPE_COLORS').catch(() => ({}));
const categoryQuoteMap = await extractLocalConst('app/motivasi/[categoryId].tsx', 'CATEGORY_QUOTE_MAP');
const riyadhohDocs = await extractLocalConst('app/(tabs)/riyadhoh.tsx', 'RIYADHOH_DOCS');
const infaqPrograms = await extractLocalConst('app/infaq/index.tsx', 'INFAQ_PROGRAMS');
const socialLinks = await extractLocalConst('app/social/index.tsx', 'SOCIAL_LINKS');
const socialPosts = await extractLocalConst('app/social/index.tsx', 'NASUHA_CONTENT');
const kegiatan = await extractLocalConst('app/kegiatan/index.tsx', 'KEGIATAN');
const kfmTopics = await extractLocalConst('app/kfm/index.tsx', 'KFM_TOPICS');
const kfmTujuan = await extractLocalConst('app/kfm/index.tsx', 'TUJUAN');
const kfmPertanyaan = await extractLocalConst('app/kfm/index.tsx', 'PERTANYAAN_HARTA');
const lbuTimeline = await extractLocalConst('app/lbu/index.tsx', 'TIMELINE_STEPS');
const legacyArticles = await extractLocalConst('app/artikel/index.tsx', 'ARTICLES');

// MOTIVASI_ARTICLES di app punya id ganda (1001) → beri id baru untuk duplikat berikutnya.
function dedupeIds(items) {
  const seen = new Set();
  let next = Math.max(...items.map((item) => item.id)) + 1;
  return items.map((item) => {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      return item;
    }
    const copy = { ...item, id: next };
    next += 1;
    return copy;
  });
}

// Hapus duplikat doa (CORE vs EXTRA) berdasarkan judul.
const seenDoa = new Set();
const doas = doaModule.DOAS.filter((doa) => {
  const key = doa.title.trim().toLowerCase();
  if (seenDoa.has(key)) return false;
  seenDoa.add(key);
  return true;
});

const content = {
  generatedAt: new Date().toISOString(),
  kordas,
  references: {
    event_type: eventTypes.map((code) => ({ code, label: code, color: eventTypeColors[code] || null })),
    lapak_category: data.LAPAK_CATEGORIES.filter((item) => item.id !== 'semua')
      .map((item) => ({ code: item.id, label: item.label, icon: item.icon })),
    question_category: ['Keuangan Syariah', 'Hijrah', 'Fiqh', 'Bisnis', 'Umum'].map((code) => ({ code, label: code })),
    testimonial_program: ['LBU', 'TSN', 'Riyadhoh', 'Kajian', 'Lainnya'].map((code) => ({ code, label: code })),
    doa_category: [...new Set(doas.map((doa) => doa.category))].map((code) => ({ code, label: code }))
  },
  riyadhohItems: data.RIYADHOH_ITEMS,
  riyadhohDocs: Object.entries(riyadhohDocs).map(([id, doc]) => ({ id, title: doc.title, body: doc.body })),
  quotes: data.MOTIVASI_QUOTES,
  motivasiCategories: data.MOTIVASI_CATEGORIES.map((category) => ({
    ...category,
    quoteTags: categoryQuoteMap[category.id] || []
  })),
  articles: [
    ...dedupeIds(data.MOTIVASI_ARTICLES).map((article) => ({ ...article, section: 'motivasi' })),
    ...legacyArticles.map((article) => ({
      id: null,
      section: 'artikel',
      categoryId: null,
      title: article.title,
      summary: article.category,
      content: '',
      author: 'Tim IDTC',
      readTime: article.readTime,
      icon: article.icon,
      status: 'draft'
    }))
  ],
  doas,
  events: data.SAMPLE_EVENTS,
  testimonials: data.SAMPLE_TESTIMONIALS.map((testimonial) => ({
    ...testimonial,
    kordaId: kordaIdFromLabel(testimonial.korda)
  })),
  programs: [
    {
      slug: 'tsn', grp: 'utama', title: data.TSN_INFO.title, subtitle: data.TSN_INFO.subtitle,
      description: data.TSN_INFO.description, icon: 'people', gradient: ['#00B4D8', '#0077B6'],
      relatedEventType: 'TSN', data: { benefits: data.TSN_INFO.benefits }
    },
    {
      slug: 'lbu', grp: 'utama', title: data.LBU_INFO.title, subtitle: data.LBU_INFO.subtitle,
      description: data.LBU_INFO.description, icon: 'trending-up', gradient: ['#D4A853', '#B8860B'],
      relatedEventType: 'LBU',
      data: { steps: lbuTimeline, simpleSteps: data.LBU_INFO.steps, stats: data.LBU_INFO.stats }
    },
    {
      slug: 'kfm', grp: 'utama', title: 'Kelas Financial Mindset', subtitle: 'KFM',
      description: 'Materi Kelas Financial Mindset IDTC.', icon: 'school', gradient: ['#0077B6', '#00B4D8'],
      relatedEventType: 'KFM',
      data: {
        topics: kfmTopics,
        sections: [{ title: 'Tujuan', items: kfmTujuan }, { title: 'Pertanyaan Harta', items: kfmPertanyaan }]
      }
    },
    ...kegiatan.map((item) => ({
      slug: item.id, grp: 'kegiatan', title: item.title, subtitle: item.subtitle,
      description: item.description, icon: item.icon, gradient: item.gradient, relatedEventType: null,
      data: { schedule: item.schedule, howToJoin: item.howToJoin, stats: item.stats }
    }))
  ],
  infaqPrograms: infaqPrograms.map((program, index) => ({
    ...program,
    shortLabel: { app: 'Aplikasi', subuh: 'Sedekah Subuh', air: 'Air Minum' }[program.id] || program.title,
    sortOrder: index + 1
  })),
  socialLinks: socialLinks.map((link, index) => ({ ...link, sortOrder: index + 1 })),
  socialPosts: socialPosts.map((post) => ({
    platform: post.platform, type: post.type, title: post.title, description: post.description,
    url: post.url, deepLink: post.deepLink || null
  })),
  membershipFeatures: [
    { id: 'quran', name: 'Al-Quran', description: 'Baca Al-Quran', icon: 'book-outline' },
    { id: 'hadis', name: 'Hadis', description: 'Baca Hadis', icon: 'document-text-outline' },
    { id: 'motivasi', name: 'Motivasi', description: 'Baca Motivasi', icon: 'heart-outline' },
    { id: 'riyadhoh', name: 'Riyadhoh Tracking', description: 'Track Ibadah Harian', icon: 'checkbox-outline' },
    { id: 'event', name: 'Event', description: 'Daftar Event', icon: 'calendar-outline' },
    { id: 'lapak', name: 'Lapak Penjualan', description: 'Buka Lapak Jualan', icon: 'storefront-outline' },
    { id: 'tanya', name: 'Tanya Praktisi', description: 'Tanya Jawab dengan Praktisi', icon: 'help-circle-outline' },
    { id: 'social', name: 'Media Sosial', description: 'Akses Media Sosial', icon: 'share-social-outline' },
    { id: 'community', name: 'Komunitas', description: 'Akses Forum Komunitas', icon: 'people-outline' }
  ],
  membershipPlans: [
    {
      type: 'free', label: 'Free Member', color: '#999999',
      description: 'Calon Sahabat IDTC atau Member yang belum tergabung dalam Komunitas',
      features: { quran: true, hadis: true, motivasi: true, riyadhoh: false, event: false, lapak: false, tanya: false, social: false, community: false }
    },
    {
      type: 'membership', label: 'Membership', color: '#2EC4B6',
      description: 'Calon Sahabat dengan fitur tambahan',
      features: { quran: true, hadis: true, motivasi: true, riyadhoh: true, event: true, lapak: false, tanya: true, social: false, community: false }
    },
    {
      type: 'sahabat', label: 'Sahabat IDTC', color: '#D4A853',
      description: 'Full Fitur - Member Komunitas IDTC',
      features: { quran: true, hadis: true, motivasi: true, riyadhoh: true, event: true, lapak: true, tanya: true, social: true, community: true }
    }
  ]
};

await mkdir(path.join(projectRoot, 'seeds'), { recursive: true });
await writeFile(path.join(projectRoot, 'seeds', 'content.json'), `${JSON.stringify(content, null, 2)}\n`);
console.log(`seeds/content.json ditulis dari ${appRoot}`);
for (const [key, value] of Object.entries(content)) {
  if (Array.isArray(value)) console.log(`  ${key}: ${value.length}`);
}
