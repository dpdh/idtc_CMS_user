import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileTypeFromBuffer } from 'file-type';
import multer from 'multer';
import { badRequest } from './http.js';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const uploadRoot = path.resolve(projectRoot, process.env.UPLOAD_DIR || 'uploads');
export const UPLOAD_PURPOSES = ['avatar', 'product', 'testimonial', 'event', 'content'];
const IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);

export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4, parts: 5 }
});

export async function ensureUploadDirectories() {
  await Promise.all(UPLOAD_PURPOSES.map((purpose) => mkdir(path.join(uploadRoot, purpose), { recursive: true })));
}

// Simpan file gambar (validasi berdasarkan isi file, bukan ekstensi) dan catat di tabel uploads.
export async function storeImage(client, file, purpose, userId) {
  if (!file) throw badRequest('File gambar wajib dipilih.', 'file');
  if (!UPLOAD_PURPOSES.includes(purpose)) throw badRequest('Tujuan upload tidak valid.', 'purpose');
  const detected = await fileTypeFromBuffer(file.buffer);
  const extension = detected && IMAGE_TYPES.get(detected.mime);
  if (!extension) throw badRequest('Foto harus berupa JPG, PNG, atau WEBP yang valid.', 'file');

  const filename = `${randomUUID()}.${extension}`;
  const storagePath = `uploads/${purpose}/${filename}`;
  await writeFile(path.join(uploadRoot, purpose, filename), file.buffer, { flag: 'wx' });
  const result = await client.query(
    `INSERT INTO uploads (user_id, purpose, storage_path, mime_type, file_size)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, storage_path, mime_type, file_size`,
    [userId, purpose, storagePath, detected.mime, file.size]
  );
  return result.rows[0];
}

export async function removeStoredFile(storagePath) {
  if (!storagePath || !storagePath.startsWith('uploads/')) return;
  const [, purpose, filename] = storagePath.split('/');
  if (!UPLOAD_PURPOSES.includes(purpose) || !filename || filename.includes('..')) return;
  await unlink(path.join(uploadRoot, purpose, filename)).catch(() => {});
}

// Pastikan setiap path foto adalah hasil upload milik user (admin boleh memakai upload siapa pun).
export async function assertUploads(client, storagePaths, userId, { allowAnyOwner = false, field = 'photos' } = {}) {
  const local = storagePaths.filter((item) => item.startsWith('uploads/'));
  if (local.length !== storagePaths.length) throw badRequest('Foto harus diunggah lewat endpoint /uploads.', field);
  if (!local.length) return;
  const result = await client.query(
    `SELECT storage_path FROM uploads
     WHERE storage_path = ANY($1::varchar[]) AND ($2::boolean OR user_id = $3)`,
    [local, allowAnyOwner, userId]
  );
  if (result.rowCount !== new Set(local).size) throw badRequest('Sebagian foto tidak ditemukan. Unggah ulang foto.', field);
}
