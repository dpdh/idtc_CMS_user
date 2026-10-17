import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { authenticate } from './auth.js';
import { pool } from './db.js';
import { HttpError } from './http.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { communityRoutes } from './routes/community.js';
import { contentRoutes } from './routes/content.js';
import { featureRoutes } from './routes/features.js';
import { eventRoutes } from './routes/events.js';
import { lapakRoutes } from './routes/lapak.js';
import { libraryRoutes } from './routes/library.js';
import { meRoutes } from './routes/me.js';
import { riyadhohRoutes } from './routes/riyadhoh.js';
import { projectRoot, uploadRoot } from './uploads.js';
import { recordServerError, requestMetrics } from './monitor.js';

export const API_PREFIX = '/api/v1';

export function createApp({ onRouteHit } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Alpine.js (build standar) mengevaluasi ekspresi dengan new Function → butuh 'unsafe-eval' di panel admin.
        scriptSrc: ["'self'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'"]
      }
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  }));
  app.use(requestMetrics);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // CORS sederhana untuk Expo web (dev). Mobile native tidak membutuhkan CORS.
  const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  app.use(API_PREFIX, (request, response, next) => {
    const origin = request.get('origin');
    if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
      response.set('Access-Control-Allow-Origin', origin);
      response.set('Vary', 'Origin');
      response.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (request.method === 'OPTIONS') return response.status(204).end();
    return next();
  });

  // File upload publik (avatar, foto produk, dll).
  app.use('/uploads', express.static(uploadRoot, { maxAge: '7d', index: false, fallthrough: false }));

  // Panel admin (Tailwind + Alpine.js).
  const adminDirectory = path.join(projectRoot, 'admin');
  app.get(['/admin', '/admin/'], (_request, response) => response.sendFile(path.join(adminDirectory, 'index.html')));
  app.get('/admin/admin.css', (_request, response) => response.sendFile(path.join(adminDirectory, 'admin.css')));
  app.get('/admin/admin.js', (_request, response) => response.sendFile(path.join(adminDirectory, 'admin.js')));
  app.get('/admin/vendor/chart.js', (_request, response) => response.sendFile(
    path.join(projectRoot, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js'),
    { headers: { 'Content-Type': 'text/javascript' } }
  ));
  app.get('/admin/vendor/alpine.js', (_request, response) => response.sendFile(
    path.join(projectRoot, 'node_modules', 'alpinejs', 'dist', 'cdn.min.js'),
    { headers: { 'Content-Type': 'text/javascript' } }
  ));

  // Halaman pendaftaran anggota (publik; memakai API yang sama dengan app mobile).
  const publicDirectory = path.join(projectRoot, 'public');
  app.get(['/register', '/register/'], (_request, response) => response.sendFile(path.join(publicDirectory, 'register.html')));
  app.get('/register/register.js', (_request, response) => response.sendFile(
    path.join(publicDirectory, 'register.js'),
    { headers: { 'Content-Type': 'text/javascript' } }
  ));

  app.get('/', (_request, response) => response.redirect('/admin'));

  app.get('/api/health', async (_request, response) => {
    try {
      await pool.query('SELECT 1');
      response.json({ status: 'ok', database: 'ok' });
    } catch (error) {
      console.error('[health] database tidak tersedia:', error.message);
      response.status(503).json({ status: 'unavailable', database: 'unavailable' });
    }
  });

  // Hook untuk test: catat route yang terpanggil (dipakai test cakupan endpoint).
  if (onRouteHit) {
    app.use(API_PREFIX, (request, response, next) => {
      response.on('finish', () => {
        if (request.route) onRouteHit(`${request.method} ${request.route.path}`);
      });
      next();
    });
  }
  app.use(API_PREFIX, authenticate);
  app.use(API_PREFIX, authRoutes());
  app.use(API_PREFIX, meRoutes());
  app.use(API_PREFIX, libraryRoutes());
  app.use(API_PREFIX, riyadhohRoutes());
  app.use(API_PREFIX, eventRoutes());
  app.use(API_PREFIX, lapakRoutes());
  app.use(API_PREFIX, communityRoutes());
  app.use(API_PREFIX, contentRoutes());
  app.use(API_PREFIX, featureRoutes());
  app.use(API_PREFIX, adminRoutes());

  app.use(API_PREFIX, (_request, response) => response.status(404).json({ error: 'Endpoint tidak ditemukan.' }));

  app.use((error, request, response, _next) => {
    if (error instanceof HttpError) {
      return response.status(error.status).json({ error: error.message, ...error.extra });
    }
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') return response.status(413).json({ field: 'file', error: 'Ukuran foto maksimal 5 MB.' });
      return response.status(400).json({ field: 'file', error: 'Formulir atau lampiran tidak valid.' });
    }
    if (error?.type === 'entity.parse.failed') return response.status(400).json({ error: 'Body JSON tidak valid.' });
    if (error?.type === 'entity.too.large') return response.status(413).json({ error: 'Body request terlalu besar.' });
    if (error?.status === 404 && error?.expose) return response.status(404).json({ error: 'File tidak ditemukan.' });
    if (error?.code === '23502') {
      return response.status(400).json({ error: `Kolom ${error.column || ''} wajib diisi.`.replace('  ', ' '), field: error.column });
    }
    if (error?.code === '23514') {
      // Pelanggaran CHECK constraint (mis. jawaban kuis harus salah satu pilihan, URL buku harus https).
      const messages = {
        quiz_answer_in_choices: ['Jawaban harus sama persis dengan salah satu pilihan.', 'answer'],
        quiz_questions_choices_check: ['Pilihan jawaban harus 2 sampai 6.', 'choices'],
        books_url_check: ['URL buku harus diawali https://', 'url']
      };
      const [message, field] = messages[error.constraint] || ['Data tidak memenuhi aturan isian.'];
      return response.status(400).json({ error: message, ...(field ? { field } : {}) });
    }
    if (error?.code === '22P02' || error?.code === '22007' || error?.code === '22008') {
      return response.status(400).json({ error: 'Format data tidak valid.' });
    }
    console.error(error);
    recordServerError(request, error);
    return response.status(500).json({ error: 'Terjadi kesalahan pada server IDTC.' });
  });

  return app;
}

