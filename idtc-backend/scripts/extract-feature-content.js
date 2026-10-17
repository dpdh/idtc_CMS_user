// Ekstrak konten fitur tambahan app (Kisah, Kuis NAS, Buku, Grup Ibadah) ke seeds/content.json.
// Hanya menimpa kunci stories/quizQuestions/books/worshipGroups; kunci lain dibiarkan.
// Pemakaian: node scripts/extract-feature-content.js [path-app]  (default ../NASJAK)
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.resolve(process.argv[2] || path.join(projectRoot, '..', 'NASJAK'));
const load = (file) => import(pathToFileURL(path.join(appRoot, 'constants', file)).href);

function slugify(value) {
  return value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

const { RASULULLAH_STORIES } = await load('kisah.ts');
const { NABI_STORIES } = await load('kisah-nabi.ts');
const { NAS_GAME_QUESTIONS } = await load('games.ts');

const summaryOf = (body) => {
  const first = body.split(/\n\s*\n/)[0].trim();
  return first.length > 280 ? `${first.slice(0, 277).trimEnd()}...` : first;
};

// Ringkasan kisah Rasulullah & daftar kisah sahabat ditulis langsung di app/kisah/index.tsx.
const RASUL_SUMMARIES = [
  'Meneladani amanah dan kejujuran Rasulullah dalam berdagang dan bermuamalah.',
  'Kelembutan, kesabaran, dan kasih sayang Rasulullah kepada umat dan makhluk hidup.',
  'Pelajaran tentang pemaafan dan kemenangan akhlak dalam perjalanan dakwah.'
];
const SAHABAT_STORIES = [
  { title: 'Abu Bakar dan Kejujuran', person: 'Abu Bakar Ash-Shiddiq RA', summary: 'Keteguhan iman, kelembutan hati, dan keberanian mendampingi Rasulullah.' },
  { title: 'Umar dan Keadilan', person: 'Umar bin Khattab RA', summary: 'Keadilan yang lahir dari rasa takut kepada Allah dan kepedulian kepada rakyat.' },
  { title: 'Bilal dan Keteguhan Tauhid', person: 'Bilal bin Rabah RA', summary: 'Keteguhan mempertahankan iman meski berada dalam tekanan dan siksaan.' }
];

const stories = [
  ...RASULULLAH_STORIES.map((story, index) => ({
    id: `rasul-${slugify(story.title)}`, category: 'rasul', title: story.title, person: story.person,
    summary: RASUL_SUMMARIES[index] || summaryOf(story.body), body: story.body, sortOrder: index + 1
  })),
  ...SAHABAT_STORIES.map((story, index) => ({
    id: `sahabat-${slugify(story.title)}`, category: 'sahabat', title: story.title, person: story.person,
    summary: story.summary, body: story.summary, sortOrder: index + 1
  })),
  ...NABI_STORIES.map((story, index) => ({
    id: `nabi-${slugify(story.title)}`, category: 'nabi', title: story.title, person: story.person,
    summary: story.summary, body: story.body, sortOrder: index + 1
  }))
];

const quizQuestions = NAS_GAME_QUESTIONS.map((question, index) => ({
  id: slugify(question.id), category: question.category, question: question.question, choices: question.choices,
  answer: question.answer, explanation: question.explanation, sortOrder: index + 1
}));

// Buku & grup ibadah ditulis langsung di layar app (JSX/konstanta lokal), jadi disalin di sini.
const books = [{
  id: 'buku-sakti-lunas-utang',
  title: 'Buku Sakti Lunas Utang Komunitas IDTC',
  coverTitle: 'BUKU SAKTI\nLUNAS UTANG',
  coverCaption: 'Panduan syariah untuk melangkah bebas dari utang',
  meta: 'Flipbook resmi • 204 halaman',
  description: 'Materi syariah untuk memahami akad, memetakan pokok dan DBO, bernegosiasi, serta menyusun langkah pelunasan bersama Komunitas IDTC.',
  url: 'https://online.fliphtml5.com/NASUHA_DIGITAL/eulx/',
  sortOrder: 1
}];

const worshipGroups = [
  { id: 'tahajud-call', name: 'Tahajud Call', description: 'Saling membangunkan dan menguatkan untuk shalat Tahajud.', schedule: '02.30', icon: 'moon', color: '#355C7D', reminderKey: 'tahajudCallEnabled', sortOrder: 1 },
  { id: 'dhuha-call', name: 'Dhuha Call', description: 'Mengingatkan waktu Dhuha dan berbagi semangat kebaikan.', schedule: '07.00 - 11.30', icon: 'sunny', color: '#D08B32', reminderKey: 'dhuhaReminderEnabled', sortOrder: 2 },
  { id: 'taubat-call', name: 'Taubat Call', description: 'Menjaga waktu muhasabah dan shalat Taubat bersama.', schedule: '3 kali sehari', icon: 'heart', color: '#2E8B78', reminderKey: 'taubatReminderEnabled', sortOrder: 3 }
];

const file = path.join(projectRoot, 'seeds', 'content.json');
const content = JSON.parse(await readFile(file, 'utf8'));
Object.assign(content, { stories, quizQuestions, books, worshipGroups });
await writeFile(file, `${JSON.stringify(content, null, 2)}\n`);
console.log('Konten fitur diekstrak:', { stories: stories.length, quizQuestions: quizQuestions.length, books: books.length, worshipGroups: worshipGroups.length });
