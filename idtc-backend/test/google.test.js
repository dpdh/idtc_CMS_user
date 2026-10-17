// Sign in with Google: token ditandatangani kunci uji, JWKS disajikan server lokal (pengganti JWKS Google).
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { startTestServer } from './helpers.js';

const CLIENT_ID = 'android-client.apps.googleusercontent.com';
let ctx;
let api;
let jwksServer;
let privateKey;

async function googleIdToken(claims, { audience = CLIENT_ID, issuer = 'https://accounts.google.com', expiresIn = '10m', key } = {}) {
  return new SignJWT({ email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'uji' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key || privateKey);
}

before(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'uji', alg: 'RS256', use: 'sig' };
  jwksServer = await new Promise((resolve) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  process.env.GOOGLE_JWKS_URL = `http://127.0.0.1:${jwksServer.address().port}/certs`;
  process.env.GOOGLE_CLIENT_IDS = `web-client.apps.googleusercontent.com, ${CLIENT_ID}`;
  ctx = await startTestServer();
  api = ctx.api;
});

after(async () => {
  await ctx?.close();
  await new Promise((resolve) => jwksServer?.close(resolve));
});

describe('login google', () => {
  test('akun baru dibuat tanpa password, login ulang memakai akun yang sama', async () => {
    const idToken = await googleIdToken({ sub: 'g-1001', email: 'Jamaah.Google@Gmail.com', name: 'Jamaah Google', picture: 'https://lh3.googleusercontent.com/a/foto' });
    const first = await api('POST', '/auth/google', { body: { idToken } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.isNewUser, true);
    const user = first.body.data.user;
    assert.equal(user.email, 'jamaah.google@gmail.com');
    assert.equal(user.name, 'Jamaah Google');
    assert.equal(user.authProvider, 'google');
    assert.equal(user.hasPassword, false);
    assert.equal(user.role, 'calon_sahabat');
    assert.equal(user.membershipType, 'free');
    assert.equal(user.avatar, 'https://lh3.googleusercontent.com/a/foto');

    const me = await api('GET', '/auth/me', { token: first.body.data.token });
    assert.equal(me.status, 200);

    const again = await api('POST', '/auth/google', { body: { idToken: await googleIdToken({ sub: 'g-1001', email: 'jamaah.google@gmail.com' }) } });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.isNewUser, false);
    assert.equal(again.body.data.user.id, user.id);

    // Belum punya password: login password ditolak dengan arahan ke Google, lalu password pertama boleh dibuat.
    const passwordLogin = await api('POST', '/auth/login', { body: { identifier: 'jamaah.google@gmail.com', password: 'apa saja' } });
    assert.equal(passwordLogin.status, 401);
    assert.match(passwordLogin.body.error, /Google/);
    const setPassword = await api('PUT', '/auth/password', { token: again.body.data.token, body: { password: 'rahasia123' } });
    assert.equal(setPassword.status, 200, JSON.stringify(setPassword.body));
    const login = await api('POST', '/auth/login', { body: { identifier: 'jamaah.google@gmail.com', password: 'rahasia123' } });
    assert.equal(login.status, 200);
    assert.equal(login.body.data.user.hasPassword, true);
  });

  test('email terverifikasi ditautkan ke akun email yang sudah ada', async () => {
    const registered = await api('POST', '/auth/register', { body: { name: 'Pengguna Lama', email: 'lama@gmail.com', password: 'rahasia123' } });
    assert.equal(registered.status, 201);
    const linked = await api('POST', '/auth/google', { body: { idToken: await googleIdToken({ sub: 'g-2002', email: 'lama@gmail.com', name: 'Nama Google' }) } });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal(linked.body.data.user.id, registered.body.data.user.id);
    assert.equal(linked.body.data.user.name, 'Pengguna Lama');
    assert.equal(linked.body.data.user.authProvider, 'google');
    assert.equal(linked.body.data.user.hasPassword, true);

    // Akun Google lain dengan email yang sama tidak boleh mengambil alih akun ini.
    const other = await api('POST', '/auth/google', { body: { idToken: await googleIdToken({ sub: 'g-2003', email: 'lama@gmail.com' }) } });
    assert.equal(other.status, 409);
  });

  test('token tidak sah ditolak', async () => {
    const cases = [
      await googleIdToken({ sub: 'g-3', email: 'x@gmail.com' }, { audience: 'aplikasi-lain.apps.googleusercontent.com' }),
      await googleIdToken({ sub: 'g-3', email: 'x@gmail.com' }, { issuer: 'https://evil.example.com' }),
      await googleIdToken({ sub: 'g-3', email: 'x@gmail.com' }, { expiresIn: '-1m' }),
      await googleIdToken({ sub: 'g-3', email: 'x@gmail.com' }, { key: (await generateKeyPair('RS256')).privateKey }),
      'bukan.jwt.valid'
    ];
    for (const idToken of cases) {
      const response = await api('POST', '/auth/google', { body: { idToken } });
      assert.equal(response.status, 401, idToken);
    }
    const unverified = await api('POST', '/auth/google', { body: { idToken: await googleIdToken({ sub: 'g-4', email: 'y@gmail.com', email_verified: false }) } });
    assert.equal(unverified.status, 401);
    assert.match(unverified.body.error, /terverifikasi/);
    const missing = await api('POST', '/auth/google', { body: {} });
    assert.equal(missing.status, 400);
  });

  test('akun Google ditangguhkan tidak bisa masuk; hapus akun tanpa password memakai konfirmasi', async () => {
    const created = await api('POST', '/auth/google', { body: { idToken: await googleIdToken({ sub: 'g-5005', email: 'hapus@gmail.com' }) } });
    assert.equal(created.status, 201);
    const token = created.body.data.token;
    const wrong = await api('DELETE', '/me', { token, body: { confirmation: 'ya' } });
    assert.equal(wrong.status, 400);
    const removed = await api('DELETE', '/me', { token, body: { confirmation: 'HAPUS' } });
    assert.equal(removed.status, 204);

    const { pool } = await import('../src/db.js');
    const suspended = await api('POST', '/auth/google', { body: { idToken: await googleIdToken({ sub: 'g-6006', email: 'tangguh@gmail.com' }) } });
    await pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [suspended.body.data.user.id]);
    const blocked = await api('POST', '/auth/google', { body: { idToken: await googleIdToken({ sub: 'g-6006', email: 'tangguh@gmail.com' }) } });
    assert.equal(blocked.status, 403);
  });
});
