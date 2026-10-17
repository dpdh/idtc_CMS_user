import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const envPath = path.resolve(process.cwd(), '.env');
const token = randomBytes(32).toString('hex');
let content = '';

try {
  content = await readFile(envPath, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const tokenSetting = `SUPER_ADMIN_RESET_TOKEN=${token}`;
if (/^SUPER_ADMIN_RESET_TOKEN=.*$/m.test(content)) {
  content = content.replace(/^SUPER_ADMIN_RESET_TOKEN=.*$/m, tokenSetting);
} else {
  content = `${content.replace(/\s*$/, '')}${content.trim() ? '\n' : ''}${tokenSetting}\n`;
}

await writeFile(envPath, content, { mode: 0o600 });
console.log('Token reset baru tersimpan di .env dan tidak ditampilkan. Mulai ulang server agar aktif.');