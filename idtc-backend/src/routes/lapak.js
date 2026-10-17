import { Router } from 'express';
import { isStaff, requireAuth, requireFeature } from '../auth.js';
import { pool } from '../db.js';
import {
  assertUuid, badRequest, fileUrl, int, isValidPhone, likePattern, normalizePhone, notFound, oneOf, pageMeta,
  paging, sendData, str, stringArray, toStoragePath
} from '../http.js';
import { notifyStaff } from '../notify.js';
import { assertUploads } from '../uploads.js';

export const PRODUCT_SELECT = `
  SELECT p.*, u.full_name AS seller_name, u.city AS seller_city, u.photo_path AS seller_photo
  FROM lapak_products p JOIN users u ON u.id = p.seller_id`;

export function serializeProduct(request, row) {
  const specs = row.specs || {};
  return {
    id: row.id,
    seller: { id: row.seller_id, name: row.seller_name, city: row.seller_city, avatar: fileUrl(request, row.seller_photo) },
    sellerId: row.seller_id,
    sellerName: row.seller_name,
    sellerCity: specs.shippingFrom || row.seller_city || '',
    sellerWhatsapp: row.seller_whatsapp,
    name: row.name,
    category: row.category,
    description: row.description,
    price: row.price,
    photos: (row.photos || []).map((photo) => fileUrl(request, photo)),
    specs,
    tags: row.tags || [],
    status: row.status,
    rejectionReason: row.rejection_reason,
    rating: row.rating,
    sold: row.sold,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function parseProduct(body, user, { allowAnyOwner = false } = {}) {
  const name = str(body, 'name', { required: true, max: 150, label: 'Nama produk' });
  const category = str(body, 'category', { required: true, max: 60, label: 'Kategori' });
  const categoryCheck = await pool.query(
    `SELECT 1 FROM reference_items WHERE kind = 'lapak_category' AND code = $1 AND is_active`,
    [category]
  );
  if (!categoryCheck.rowCount) throw badRequest('Kategori tidak valid.', 'category');
  const description = str(body, 'description', { required: true, max: 500, label: 'Deskripsi' });
  const price = int(body, 'price', { required: true, min: 1, label: 'Harga' });
  const sellerWhatsapp = normalizePhone(str(body, 'sellerWhatsapp', { required: true, max: 20, label: 'No. WhatsApp' }));
  if (!isValidPhone(sellerWhatsapp)) throw badRequest('Format No. WhatsApp tidak valid.', 'sellerWhatsapp');
  if (!Array.isArray(body.photos) || body.photos.length < 1 || body.photos.length > 5) {
    throw badRequest('Foto produk wajib 1 sampai 5.', 'photos');
  }
  const photos = body.photos.map(toStoragePath);
  if (photos.some((photo) => !photo)) throw badRequest('Foto produk tidak valid.', 'photos');
  await assertUploads(pool, photos, user.id, { allowAnyOwner });

  const rawSpecs = body.specs && typeof body.specs === 'object' ? body.specs : {};
  const specs = {
    weight: str(rawSpecs, 'weight', { max: 40 }) || undefined,
    condition: oneOf(rawSpecs, 'condition', ['Baru', 'Bekas']) || 'Baru',
    stock: int(rawSpecs, 'stock', { min: 0, label: 'Stok' }) ?? undefined,
    minOrder: int(rawSpecs, 'minOrder', { min: 1, label: 'Min. order' }) ?? 1,
    variant: str(rawSpecs, 'variant', { max: 150 }) || undefined,
    shippingFrom: str(rawSpecs, 'shippingFrom', { max: 120 }) || undefined
  };
  const tags = stringArray(body, 'tags', { maxItems: 10, maxLength: 30 }) || [];
  return { name, category, description, price, sellerWhatsapp, photos, specs: JSON.parse(JSON.stringify(specs)), tags };
}

export function lapakRoutes() {
  const router = Router();

  router.get('/lapak/products', async (request, response) => {
    const page = paging(request.query);
    const filters = ["p.status = 'approved'"];
    const values = [];
    if (request.query.category && request.query.category !== 'semua') {
      values.push(String(request.query.category));
      filters.push(`p.category = $${values.length}`);
    }
    if (request.query.sellerId) {
      values.push(assertUuid(String(request.query.sellerId), 'Penjual tidak ditemukan.'));
      filters.push(`p.seller_id = $${values.length}`);
    }
    if (request.query.q) {
      values.push(likePattern(String(request.query.q)));
      const index = values.length;
      filters.push(`(p.name ILIKE $${index} OR u.full_name ILIKE $${index} OR p.description ILIKE $${index})`);
    }
    const sorts = { price: 'p.price', '-price': 'p.price DESC', '-sold': 'p.sold DESC', '-createdAt': 'p.created_at DESC' };
    const order = sorts[request.query.sort] || 'p.created_at DESC';
    const where = filters.join(' AND ');
    const [rows, count, stats] = await Promise.all([
      pool.query(`${PRODUCT_SELECT} WHERE ${where} ORDER BY ${order} LIMIT ${page.perPage} OFFSET ${page.offset}`, values),
      pool.query(`SELECT count(*)::int AS total FROM lapak_products p JOIN users u ON u.id = p.seller_id WHERE ${where}`, values),
      pool.query(`SELECT count(*)::int AS products, count(DISTINCT seller_id)::int AS sellers FROM lapak_products WHERE status = 'approved'`)
    ]);
    return sendData(response, rows.rows.map((row) => serializeProduct(request, row)),
      pageMeta(page, count.rows[0].total, { stats: stats.rows[0] }));
  });

  router.get('/lapak/products/:id', async (request, response) => {
    const id = assertUuid(request.params.id, 'Produk tidak ditemukan.');
    const result = await pool.query(`${PRODUCT_SELECT} WHERE p.id = $1`, [id]);
    const row = result.rows[0];
    const canSeeAll = request.user && (row?.seller_id === request.user.id || isStaff(request.user));
    if (!row || (row.status !== 'approved' && !canSeeAll)) throw notFound('Produk tidak ditemukan.');
    return sendData(response, serializeProduct(request, row));
  });

  router.get('/me/products', requireAuth, async (request, response) => {
    const status = request.query.status ? oneOf(request.query, 'status', ['pending', 'approved', 'rejected']) : null;
    const [rows, counts] = await Promise.all([
      pool.query(
        `${PRODUCT_SELECT} WHERE p.seller_id = $1 AND ($2::varchar IS NULL OR p.status = $2) ORDER BY p.created_at DESC`,
        [request.user.id, status]
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
                count(*) FILTER (WHERE status = 'approved')::int AS approved,
                count(*) FILTER (WHERE status = 'rejected')::int AS rejected
         FROM lapak_products WHERE seller_id = $1`,
        [request.user.id]
      )
    ]);
    return sendData(response, rows.rows.map((row) => serializeProduct(request, row)), { counts: counts.rows[0] });
  });

  router.post('/lapak/products', requireFeature('lapak'), async (request, response) => {
    const product = await parseProduct(request.body || {}, request.user);
    const inserted = await pool.query(
      `INSERT INTO lapak_products (seller_id, name, category, description, price, seller_whatsapp, photos, specs, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [request.user.id, product.name, product.category, product.description, product.price,
        product.sellerWhatsapp, product.photos, product.specs, product.tags]
    );
    await notifyStaff({
      type: 'lapak', title: 'Produk baru menunggu review', body: product.name,
      icon: 'storefront', data: { route: '/admin', productId: inserted.rows[0].id }
    });
    const result = await pool.query(`${PRODUCT_SELECT} WHERE p.id = $1`, [inserted.rows[0].id]);
    return sendData(response, serializeProduct(request, result.rows[0]), undefined, 201);
  });

  router.put('/lapak/products/:id', requireAuth, async (request, response) => {
    const id = assertUuid(request.params.id, 'Produk tidak ditemukan.');
    const current = await pool.query('SELECT seller_id FROM lapak_products WHERE id = $1', [id]);
    if (!current.rowCount || current.rows[0].seller_id !== request.user.id) throw notFound('Produk tidak ditemukan.');
    const product = await parseProduct(request.body || {}, request.user);
    await pool.query(
      `UPDATE lapak_products SET name = $2, category = $3, description = $4, price = $5, seller_whatsapp = $6,
         photos = $7, specs = $8, tags = $9, status = 'pending', rejection_reason = NULL
       WHERE id = $1`,
      [id, product.name, product.category, product.description, product.price, product.sellerWhatsapp,
        product.photos, product.specs, product.tags]
    );
    const result = await pool.query(`${PRODUCT_SELECT} WHERE p.id = $1`, [id]);
    return sendData(response, serializeProduct(request, result.rows[0]));
  });

  router.delete('/lapak/products/:id', requireAuth, async (request, response) => {
    const id = assertUuid(request.params.id, 'Produk tidak ditemukan.');
    const result = await pool.query('DELETE FROM lapak_products WHERE id = $1 AND seller_id = $2', [id, request.user.id]);
    if (!result.rowCount) throw notFound('Produk tidak ditemukan.');
    return response.status(204).end();
  });

  router.post('/lapak/products/:id/contact', async (request, response) => {
    const id = assertUuid(request.params.id, 'Produk tidak ditemukan.');
    await pool.query(`UPDATE lapak_products SET contact_count = contact_count + 1 WHERE id = $1 AND status = 'approved'`, [id]);
    return response.status(204).end();
  });

  return router;
}

export { parseProduct };
