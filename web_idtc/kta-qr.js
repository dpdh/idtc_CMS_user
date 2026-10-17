// QR KTA (Kartu Tanda Anggota) IDTC: render PNG berlogo IDTC di tengah + record-nya di database.
// Error correction level H dipakai supaya penutupan area logo di tengah tidak merusak hasil scan.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { PNG } from 'pngjs';

const LOGO_RELATIVE_PATH = path.join('assets', 'img', 'IDTC_logo.png');
const QR_COLOR = { dark: '#173453', light: '#FFFFFF' };
const QR_MARGIN = 1;
const LOGO_BOX_RATIO = 0.26;
const LOGO_FILL_RATIO = 0.88;

export const KTA_QR_PREVIEW_WIDTH = 420;
export const KTA_QR_DOWNLOAD_WIDTH = 1024;

let logoPromise = null;

function loadLogo(projectRoot) {
  if (!logoPromise) {
    logoPromise = readFile(path.join(projectRoot, LOGO_RELATIVE_PATH)).then((buffer) => PNG.sync.read(buffer));
  }
  return logoPromise;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function fillWhite(png, x, y, width, height) {
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(png.width, x + width);
  const bottom = Math.min(png.height, y + height);
  for (let row = top; row < bottom; row += 1) {
    for (let col = left; col < right; col += 1) {
      const offset = (row * png.width + col) * 4;
      png.data[offset] = 255;
      png.data[offset + 1] = 255;
      png.data[offset + 2] = 255;
      png.data[offset + 3] = 255;
    }
  }
}

// Gambar logo ke area kotak tengah QR dengan skala bilinear + alpha blending di atas latar putih.
function drawLogo(target, logo, boxX, boxY, boxSize) {
  const maxEdge = boxSize * LOGO_FILL_RATIO;
  const scale = Math.min(maxEdge / logo.width, maxEdge / logo.height);
  const drawWidth = Math.max(1, Math.round(logo.width * scale));
  const drawHeight = Math.max(1, Math.round(logo.height * scale));
  const offsetX = boxX + Math.floor((boxSize - drawWidth) / 2);
  const offsetY = boxY + Math.floor((boxSize - drawHeight) / 2);

  for (let row = 0; row < drawHeight; row += 1) {
    const targetY = offsetY + row;
    if (targetY < 0 || targetY >= target.height) continue;
    const sourceY = clamp((row + 0.5) / scale - 0.5, 0, logo.height - 1);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(y0 + 1, logo.height - 1);
    const fractionY = sourceY - y0;

    for (let col = 0; col < drawWidth; col += 1) {
      const targetX = offsetX + col;
      if (targetX < 0 || targetX >= target.width) continue;
      const sourceX = clamp((col + 0.5) / scale - 0.5, 0, logo.width - 1);
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(x0 + 1, logo.width - 1);
      const fractionX = sourceX - x0;

      const samples = [
        [x0, y0, (1 - fractionX) * (1 - fractionY)],
        [x1, y0, fractionX * (1 - fractionY)],
        [x0, y1, (1 - fractionX) * fractionY],
        [x1, y1, fractionX * fractionY]
      ];
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (const [sampleX, sampleY, weight] of samples) {
        const offset = (sampleY * logo.width + sampleX) * 4;
        const sampleAlpha = (logo.data[offset + 3] / 255) * weight;
        red += logo.data[offset] * sampleAlpha;
        green += logo.data[offset + 1] * sampleAlpha;
        blue += logo.data[offset + 2] * sampleAlpha;
        alpha += sampleAlpha;
      }
      if (alpha <= 0.001) continue;
      const opacity = Math.min(alpha, 1);
      const inverse = 1 - opacity;
      const sourceRed = Math.round(red / alpha);
      const sourceGreen = Math.round(green / alpha);
      const sourceBlue = Math.round(blue / alpha);

      const offset = (targetY * target.width + targetX) * 4;
      target.data[offset] = Math.round(sourceRed * opacity + target.data[offset] * inverse);
      target.data[offset + 1] = Math.round(sourceGreen * opacity + target.data[offset + 1] * inverse);
      target.data[offset + 2] = Math.round(sourceBlue * opacity + target.data[offset + 2] * inverse);
      target.data[offset + 3] = 255;
    }
  }
}

// Render QR berisi payload sebagai PNG Buffer dengan logo IDTC di tengah.
export async function renderKtaQrPng(payload, { projectRoot, width = KTA_QR_PREVIEW_WIDTH }) {
  const qrBuffer = await QRCode.toBuffer(payload, {
    type: 'png',
    errorCorrectionLevel: 'H',
    margin: QR_MARGIN,
    width,
    color: QR_COLOR
  });
  const qr = PNG.sync.read(qrBuffer);
  const logo = await loadLogo(projectRoot);
  const boxSize = Math.round(qr.width * LOGO_BOX_RATIO);
  const boxX = Math.floor((qr.width - boxSize) / 2);
  const boxY = Math.floor((qr.height - boxSize) / 2);
  fillWhite(qr, boxX, boxY, boxSize, boxSize);
  drawLogo(qr, logo, boxX, boxY, boxSize);
  return PNG.sync.write(qr);
}

// Simpan/perbarui record QR KTA satu anggota di tabel kta_qr_codes.
export async function upsertKtaQr(pool, userId, payload) {
  const result = await pool.query(
    `INSERT INTO kta_qr_codes (user_id, payload)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = CURRENT_TIMESTAMP
     RETURNING id, user_id, payload, issued_at, updated_at`,
    [userId, payload]
  );
  return result.rows[0];
}

export function ktaQrDataUrl(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

export function ktaQrFilename(memberNumber) {
  const number = memberNumber === null || memberNumber === undefined ? 'BARU' : String(memberNumber).padStart(6, '0');
  return `QR-KTA-IDTC-${number}.png`;
}
