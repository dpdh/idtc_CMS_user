import { pool } from './db.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// Simpan notifikasi ke inbox user dan kirim push Expo (best effort, tidak memblokir request).
export async function notifyUsers(userIds, { type = 'info', title, body = '', icon = null, data = {} }, { push = true } = {}) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, icon, data)
     SELECT unnest($1::uuid[]), $2, $3, $4, $5, $6`,
    [ids, type, title, body, icon, data]
  );
  if (push && process.env.NODE_ENV !== 'test' && process.env.PUSH_DISABLED !== 'true') {
    sendPush(ids, { title, body, data: { ...data, kind: type } }).catch((error) => {
      console.warn('[push] gagal mengirim:', error.message);
    });
  }
  return ids.length;
}

export async function notifyStaff(payload) {
  const result = await pool.query(
    `SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE r.code IN ('super_admin', 'admin')`
  );
  return notifyUsers(result.rows.map((row) => row.user_id), payload, { push: false });
}

async function sendPush(userIds, { title, body, data }) {
  const devices = await pool.query('SELECT expo_push_token FROM user_devices WHERE user_id = ANY($1::uuid[])', [userIds]);
  const messages = devices.rows
    .filter((row) => row.expo_push_token.startsWith('ExponentPushToken['))
    .map((row) => ({ to: row.expo_push_token, title, body, data, sound: 'default', channelId: 'reminders' }));
  for (let index = 0; index < messages.length; index += 100) {
    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(messages.slice(index, index + 100))
    });
  }
}
