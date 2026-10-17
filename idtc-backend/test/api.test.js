import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { imageForm, startTestServer, wibDate } from './helpers.js';

let ctx;
let api;
const tokens = {};
const ids = {};

async function register(name, email, extra = {}) {
  const response = await api('POST', '/auth/register', { body: { name, email, password: 'rahasia123', ...extra } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

before(async () => {
  ctx = await startTestServer();
  api = ctx.api;
  const login = await api('POST', '/auth/login', { body: { identifier: 'super@idtc.test', password: 'SuperAdmin123' } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  tokens.super = login.body.data.token;
});

after(async () => {
  await ctx?.close();
});

describe('auth', () => {
  test('register, login email & HP, me, logout', async () => {
    const created = await register('Ahmad Fauzi', 'Ahmad@Example.com', { phone: '+62 812-1111-2222', deviceName: 'test' });
    assert.equal(created.user.email, 'ahmad@example.com');
    assert.equal(created.user.phone, '081211112222');
    assert.equal(created.user.role, 'calon_sahabat');
    assert.equal(created.user.membershipType, 'free');
    assert.equal(created.user.membershipFeatures.quran, true);
    assert.equal(created.user.membershipFeatures.lapak, false);
    ids.ahmad = created.user.id;

    const byPhone = await api('POST', '/auth/login', { body: { identifier: '6281211112222', password: 'rahasia123' } });
    assert.equal(byPhone.status, 200);
    tokens.ahmad = byPhone.body.data.token;

    const me = await api('GET', '/auth/me', { token: tokens.ahmad });
    assert.equal(me.body.data.id, ids.ahmad);

    const temp = await api('POST', '/auth/login', { body: { identifier: 'ahmad@example.com', password: 'rahasia123' } });
    const logout = await api('POST', '/auth/logout', { token: temp.body.data.token });
    assert.equal(logout.status, 204);
    const afterLogout = await api('GET', '/auth/me', { token: temp.body.data.token });
    assert.equal(afterLogout.status, 401);
  });

  test('login google nonaktif bila GOOGLE_CLIENT_IDS kosong (alur lengkap di google.test.js)', async () => {
    const previous = process.env.GOOGLE_CLIENT_IDS;
    delete process.env.GOOGLE_CLIENT_IDS;
    const response = await api('POST', '/auth/google', { body: { idToken: 'x' } });
    if (previous !== undefined) process.env.GOOGLE_CLIENT_IDS = previous;
    assert.equal(response.status, 503);
  });

  test('validasi register & login', async () => {
    const duplicate = await api('POST', '/auth/register', { body: { name: 'X', email: 'ahmad@example.com', password: 'rahasia123' } });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.field, 'email');
    const duplicatePhone = await api('POST', '/auth/register', { body: { name: 'X', email: 'x@example.com', phone: '081211112222', password: 'rahasia123' } });
    assert.equal(duplicatePhone.status, 409);
    assert.equal(duplicatePhone.body.field, 'phone');
    const shortPassword = await api('POST', '/auth/register', { body: { name: 'X', email: 'y@example.com', password: '123' } });
    assert.equal(shortPassword.status, 400);
    assert.equal(shortPassword.body.field, 'password');
    const mismatch = await api('POST', '/auth/register', { body: { name: 'X', email: 'y@example.com', password: 'rahasia123', passwordConfirmation: 'beda' } });
    assert.equal(mismatch.status, 400);
    const wrong = await api('POST', '/auth/login', { body: { identifier: 'ahmad@example.com', password: 'salah' } });
    assert.equal(wrong.status, 401);
    const unknown = await api('POST', '/auth/login', { body: { identifier: 'tidakada@example.com', password: 'rahasia123' } });
    assert.equal(unknown.status, 401);
    assert.match(unknown.body.error, /belum terdaftar/);
  });

  test('ganti password mencabut sesi lain', async () => {
    const other = await api('POST', '/auth/login', { body: { identifier: 'ahmad@example.com', password: 'rahasia123' } });
    const wrongCurrent = await api('PUT', '/auth/password', { token: tokens.ahmad, body: { currentPassword: 'x', password: 'baru12345' } });
    assert.equal(wrongCurrent.status, 400);
    const changed = await api('PUT', '/auth/password', { token: tokens.ahmad, body: { currentPassword: 'rahasia123', password: 'baru12345' } });
    assert.equal(changed.status, 200);
    assert.equal((await api('GET', '/auth/me', { token: other.body.data.token })).status, 401);
    assert.equal((await api('GET', '/auth/me', { token: tokens.ahmad })).status, 200);
    const relogin = await api('POST', '/auth/login', { body: { identifier: 'ahmad@example.com', password: 'baru12345' } });
    assert.equal(relogin.status, 200);
  });
});

describe('profil', () => {
  test('update profil, tanggal lahir DD/MM/YYYY, korda', async () => {
    const response = await api('PATCH', '/me', {
      token: tokens.ahmad,
      body: { name: 'Ahmad F.', city: 'Jakarta Timur', gender: 'laki-laki', birthDate: '17/05/1990', nasuhaRegion: 'jakarta', bio: 'Halo', email: 'hack@x.com', role: 'super_admin' }
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.name, 'Ahmad F.');
    assert.equal(response.body.data.birthDate, '1990-05-17');
    assert.equal(response.body.data.nasuhaRegion, 'jakarta');
    assert.equal(response.body.data.email, 'ahmad@example.com');
    assert.equal(response.body.data.role, 'calon_sahabat');

    const cleared = await api('PATCH', '/me', { token: tokens.ahmad, body: { bio: null } });
    assert.equal(cleared.body.data.bio, null);
    const badRegion = await api('PATCH', '/me', { token: tokens.ahmad, body: { nasuhaRegion: 'mars' } });
    assert.equal(badRegion.status, 400);
    const emptyName = await api('PATCH', '/me', { token: tokens.ahmad, body: { name: '' } });
    assert.equal(emptyName.status, 400);
  });

  test('upload & hapus avatar', async () => {
    const uploaded = await api('POST', '/me/avatar', { token: tokens.ahmad, form: imageForm() });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    assert.match(uploaded.body.data.avatar, /\/uploads\/avatar\/.+\.png$/);
    const file = await fetch(uploaded.body.data.avatar);
    assert.equal(file.status, 200);
    const fake = new FormData();
    fake.append('file', new Blob(['bukan gambar'], { type: 'image/png' }), 'x.png');
    const rejected = await api('POST', '/me/avatar', { token: tokens.ahmad, form: fake });
    assert.equal(rejected.status, 400);
    assert.equal((await api('DELETE', '/me/avatar', { token: tokens.ahmad })).status, 204);
    assert.equal((await api('GET', '/me', { token: tokens.ahmad })).body.data.avatar, null);
  });

  test('preferensi & stats', async () => {
    const saved = await api('PUT', '/me/preferences', { token: tokens.ahmad, body: { theme: 'dark', quranFontSize: 20, junk: 1 } });
    assert.equal(saved.body.data.theme, 'dark');
    assert.equal(saved.body.data.junk, undefined);
    const merged = await api('PUT', '/me/preferences', { token: tokens.ahmad, body: { colorScheme: 'ocean' } });
    assert.equal(merged.body.data.theme, 'dark');
    assert.equal(merged.body.data.colorScheme, 'ocean');
    const stats = await api('GET', '/me/stats', { token: tokens.ahmad });
    assert.equal(stats.status, 200);
    assert.equal(stats.body.data.riyadhoh.todayTotal, 33);
  });
});

describe('admin users & membership', () => {
  test('user biasa tidak bisa akses admin', async () => {
    assert.equal((await api('GET', '/admin/dashboard', { token: tokens.ahmad })).status, 403);
    assert.equal((await api('GET', '/admin/dashboard')).status, 401);
  });

  test('super admin membuat admin; admin dibatasi', async () => {
    const created = await api('POST', '/admin/users', {
      token: tokens.super, body: { name: 'Admin Satu', email: 'admin1@idtc.test', role: 'admin' }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.ok(created.body.data.temporaryPassword);
    ids.admin = created.body.data.user.id;
    const login = await api('POST', '/auth/login', { body: { identifier: 'admin1@idtc.test', password: created.body.data.temporaryPassword } });
    tokens.admin = login.body.data.token;
    assert.equal(login.body.data.user.mustChangePassword, true);

    const superUser = await api('GET', '/auth/me', { token: tokens.super });
    ids.super = superUser.body.data.id;
    const demoteSuper = await api('PATCH', `/admin/users/${ids.super}/role`, { token: tokens.admin, body: { role: 'calon_sahabat' } });
    assert.equal(demoteSuper.status, 403);
    const makeAdmin = await api('PATCH', `/admin/users/${ids.ahmad}/role`, { token: tokens.admin, body: { role: 'admin' } });
    assert.equal(makeAdmin.status, 403);
    const self = await api('PATCH', `/admin/users/${ids.admin}/status`, { token: tokens.admin, body: { isActive: false } });
    assert.equal(self.status, 403);
    const deleteByAdmin = await api('DELETE', `/admin/users/${ids.ahmad}`, { token: tokens.admin });
    assert.equal(deleteByAdmin.status, 403);
  });

  test('membership & override fitur', async () => {
    const upgraded = await api('PATCH', `/admin/users/${ids.ahmad}/membership`, { token: tokens.admin, body: { membershipType: 'sahabat', lbuBatch: 37 } });
    assert.equal(upgraded.status, 200);
    assert.equal(upgraded.body.data.membershipFeatures.lapak, true);
    assert.equal(upgraded.body.data.lbuBatch, 37);
    const override = await api('PATCH', `/admin/users/${ids.ahmad}/features`, { token: tokens.admin, body: { community: false } });
    assert.equal(override.body.data.membershipFeatures.community, false);
    assert.deepEqual(override.body.data.featureOverrides, { community: false });
    const reset = await api('PATCH', `/admin/users/${ids.ahmad}/features`, { token: tokens.admin, body: { community: null } });
    assert.equal(reset.body.data.membershipFeatures.community, true);
    const notifications = await api('GET', '/me/notifications', { token: tokens.ahmad });
    assert.ok(notifications.body.data.some((item) => item.title === 'Membership diperbarui'));
    assert.ok(notifications.body.meta.unread >= 1);
  });

  test('suspend mencabut sesi; reset password; tidak bisa hapus super admin terakhir', async () => {
    const victim = await register('Budi', 'budi@example.com');
    ids.budi = victim.user.id;
    const suspended = await api('PATCH', `/admin/users/${ids.budi}/status`, { token: tokens.admin, body: { isActive: false } });
    assert.equal(suspended.body.data.isActive, false);
    assert.equal((await api('GET', '/auth/me', { token: victim.token })).status, 401);
    const blocked = await api('POST', '/auth/login', { body: { identifier: 'budi@example.com', password: 'rahasia123' } });
    assert.equal(blocked.status, 403);
    await api('PATCH', `/admin/users/${ids.budi}/status`, { token: tokens.admin, body: { isActive: true } });
    const reset = await api('POST', `/admin/users/${ids.budi}/reset-password`, { token: tokens.admin });
    const relogin = await api('POST', '/auth/login', { body: { identifier: 'budi@example.com', password: reset.body.data.temporaryPassword } });
    assert.equal(relogin.status, 200);
    tokens.budi = relogin.body.data.token;

    const demoteLast = await api('PATCH', `/admin/users/${ids.super}/role`, { token: tokens.super, body: { role: 'admin' } });
    assert.equal(demoteLast.status, 403);
    const deleteSelf = await api('DELETE', '/me', { token: tokens.super, body: { password: 'SuperAdmin123' } });
    assert.equal(deleteSelf.status, 400);
  });
});

describe('event', () => {
  test('free user terkunci, admin buat event draft → publish', async () => {
    const draft = await api('POST', '/admin/events', {
      token: tokens.admin,
      body: { title: 'TSN Uji', type: 'TSN', date: wibDate(10), time: '08:00', location: 'Masjid Uji', quota: 2, contactWhatsapp: '0812-3333-4444' }
    });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    assert.equal(draft.body.data.status, 'draft');
    ids.event = draft.body.data.id;
    assert.equal((await api('GET', `/events/${ids.event}`)).status, 404);
    const list = await api('GET', '/events?type=TSN');
    assert.ok(!list.body.data.some((event) => event.id === ids.event));

    const badType = await api('POST', '/admin/events', { token: tokens.admin, body: { title: 'X', type: 'Ngawur', date: wibDate(3), time: '08:00', location: 'X', quota: 5 } });
    assert.equal(badType.status, 400);
    const badTime = await api('POST', '/admin/events', { token: tokens.admin, body: { title: 'X', type: 'TSN', date: wibDate(3), time: '8 pagi', location: 'X', quota: 5 } });
    assert.equal(badTime.status, 400);

    const published = await api('PATCH', `/admin/events/${ids.event}/status`, { token: tokens.admin, body: { status: 'published' } });
    assert.equal(published.body.data.status, 'published');
    const detail = await api('GET', `/events/${ids.event}`, { token: tokens.budi });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.myRegistration, null);

    const locked = await api('POST', `/events/${ids.event}/registrations`, {
      token: tokens.budi, body: { name: 'Budi', email: 'budi@example.com', phone: '081299998888' }
    });
    assert.equal(locked.status, 403);
    assert.equal(locked.body.code, 'FEATURE_LOCKED');
  });

  test('registrasi, duplikat, kuota, batal, konfirmasi admin', async () => {
    const registration = await api('POST', `/events/${ids.event}/registrations`, {
      token: tokens.ahmad, body: { name: 'Ahmad', email: 'ahmad@example.com', phone: '081211112222', korda: 'Korda Jakarta', notes: 'Datang berdua' }
    });
    assert.equal(registration.status, 201, JSON.stringify(registration.body));
    assert.equal(registration.body.data.korda, 'jakarta');
    ids.registration = registration.body.data.id;
    const duplicate = await api('POST', `/events/${ids.event}/registrations`, {
      token: tokens.ahmad, body: { name: 'Ahmad', email: 'ahmad@example.com', phone: '081211112222' }
    });
    assert.equal(duplicate.status, 409);

    await api('PATCH', `/admin/users/${ids.budi}/membership`, { token: tokens.admin, body: { membershipType: 'membership' } });
    const budiRegistration = await api('POST', `/events/${ids.event}/registrations`, {
      token: tokens.budi, body: { name: 'Budi', email: 'budi@example.com', phone: '081299998888' }
    });
    assert.equal(budiRegistration.status, 201);
    const third = await register('Citra', 'citra@example.com');
    const thirdUser = third.user.id;
    await api('PATCH', `/admin/users/${thirdUser}/membership`, { token: tokens.admin, body: { membershipType: 'sahabat' } });
    const full = await api('POST', `/events/${ids.event}/registrations`, {
      token: third.token, body: { name: 'Citra', email: 'citra@example.com', phone: '081277776666' }
    });
    assert.equal(full.status, 400);
    assert.match(full.body.error, /Kuota/);
    const detail = await api('GET', `/events/${ids.event}`, { token: tokens.ahmad });
    assert.equal(detail.body.data.registered, 2);
    assert.equal(detail.body.data.isFull, true);
    assert.equal(detail.body.data.myRegistration.id, ids.registration);

    const lowerQuota = await api('PUT', `/admin/events/${ids.event}`, { token: tokens.admin, body: { quota: 1 } });
    assert.equal(lowerQuota.status, 400);

    const edited = await api('PUT', `/admin/events/${ids.event}`, {
      token: tokens.admin, body: { quota: 5, location: 'Masjid Raya (pindah)', contactWhatsapp: null, image: null }
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.data.quota, 5);
    assert.equal(edited.body.data.location, 'Masjid Raya (pindah)');

    const cancelled = await api('POST', `/event-registrations/${budiRegistration.body.data.id}/cancel`, { token: tokens.budi });
    assert.equal(cancelled.body.data.status, 'cancelled');
    const notMine = await api('POST', `/event-registrations/${ids.registration}/cancel`, { token: tokens.budi });
    assert.equal(notMine.status, 404);
    const again = await api('POST', `/events/${ids.event}/registrations`, {
      token: third.token, body: { name: 'Citra', email: 'citra@example.com', phone: '081277776666' }
    });
    assert.equal(again.status, 201);

    const confirmed = await api('PATCH', `/admin/event-registrations/${ids.registration}`, { token: tokens.admin, body: { status: 'confirmed' } });
    assert.equal(confirmed.body.data.status, 'confirmed');
    const mine = await api('GET', '/me/event-registrations', { token: tokens.ahmad });
    assert.equal(mine.body.data[0].status, 'confirmed');
    assert.equal(mine.body.data[0].event.title, 'TSN Uji');
    const inbox = await api('GET', '/me/notifications?unread=true', { token: tokens.ahmad });
    assert.ok(inbox.body.data.some((item) => item.title === 'Pendaftaran Dikonfirmasi'));
    await api('POST', '/me/notifications/read-all', { token: tokens.ahmad });
    assert.equal((await api('GET', '/me/notifications', { token: tokens.ahmad })).body.meta.unread, 0);

    const csv = await api('GET', `/admin/event-registrations?eventId=${ids.event}&format=csv`, { token: tokens.admin });
    assert.match(csv.body, /TSN Uji/);
    const deleteWithRegs = await api('DELETE', `/admin/events/${ids.event}`, { token: tokens.admin });
    assert.equal(deleteWithRegs.status, 409);
  });
});

describe('lapak', () => {
  test('jual → pending → approve → tampil; edit kembali pending', async () => {
    const free = await api('POST', '/lapak/products', { token: tokens.budi, body: {} });
    assert.equal(free.status, 403);

    const upload = await api('POST', '/uploads', { token: tokens.ahmad, form: imageForm({ purpose: 'product' }) });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    const product = {
      name: 'Madu Hutan 500ml', category: 'makanan', description: 'Madu murni', price: 185000,
      sellerWhatsapp: '0812-1111-2222', photos: [upload.body.data.url],
      specs: { weight: '500 gr', condition: 'Baru', stock: 20, shippingFrom: 'Jakarta Timur' }, tags: 'Halal, Best Seller'
    };
    const noPhoto = await api('POST', '/lapak/products', { token: tokens.ahmad, body: { ...product, photos: [] } });
    assert.equal(noPhoto.status, 400);
    const foreignPhoto = await api('POST', '/lapak/products', { token: tokens.ahmad, body: { ...product, photos: ['https://evil.example/x.jpg'] } });
    assert.equal(foreignPhoto.status, 400);
    const badCategory = await api('POST', '/lapak/products', { token: tokens.ahmad, body: { ...product, category: 'senjata' } });
    assert.equal(badCategory.status, 400);

    const created = await api('POST', '/lapak/products', { token: tokens.ahmad, body: product });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'pending');
    assert.deepEqual(created.body.data.tags, ['Halal', 'Best Seller']);
    assert.equal(created.body.data.sellerWhatsapp, '081211112222');
    ids.product = created.body.data.id;

    assert.equal((await api('GET', `/lapak/products/${ids.product}`)).status, 404);
    assert.equal((await api('GET', `/lapak/products/${ids.product}`, { token: tokens.ahmad })).status, 200);
    const mine = await api('GET', '/me/products', { token: tokens.ahmad });
    assert.equal(mine.body.meta.counts.pending, 1);

    const approved = await api('POST', `/admin/lapak/products/${ids.product}/approve`, { token: tokens.admin });
    assert.equal(approved.body.data.status, 'approved');
    const list = await api('GET', '/lapak/products?category=makanan&q=madu');
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.meta.stats.sellers, 1);

    const hijack = await api('PUT', `/lapak/products/${ids.product}`, { token: tokens.budi, body: product });
    assert.equal(hijack.status, 404);
    const edited = await api('PUT', `/lapak/products/${ids.product}`, { token: tokens.ahmad, body: { ...product, price: 190000 } });
    assert.equal(edited.body.data.status, 'pending');
    assert.equal(edited.body.data.price, 190000);

    const rejected = await api('POST', `/admin/lapak/products/${ids.product}/reject`, { token: tokens.admin, body: { reason: 'Foto kurang jelas' } });
    assert.equal(rejected.body.data.rejectionReason, 'Foto kurang jelas');
    assert.equal((await api('DELETE', `/lapak/products/${ids.product}`, { token: tokens.ahmad })).status, 204);
  });
});

describe('testimoni & tanya', () => {
  test('testimoni dimoderasi', async () => {
    const short = await api('POST', '/testimonials', { token: tokens.budi, body: { program: 'LBU', rating: 5, text: 'pendek' } });
    assert.equal(short.status, 400);
    const created = await api('POST', '/testimonials', {
      token: tokens.ahmad, body: { program: 'LBU', rating: 5, text: 'Alhamdulillah lunas berkat program LBU IDTC.' }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.status, 'pending');
    assert.equal(created.body.data.korda, 'jakarta');
    const before = await api('GET', '/testimonials?program=LBU');
    assert.ok(!before.body.data.some((item) => item.id === created.body.data.id));
    await api('POST', `/admin/testimonials/${created.body.data.id}/approve`, { token: tokens.admin });
    const afterApprove = await api('GET', '/testimonials?korda=jakarta');
    assert.ok(afterApprove.body.data.some((item) => item.id === created.body.data.id));
    assert.equal(afterApprove.body.meta.kordaCounts.jakarta, 1);
  });

  test('tanya praktisi: jawaban resmi & notifikasi', async () => {
    const question = await api('POST', '/questions', {
      token: tokens.ahmad, body: { category: 'Fiqh', title: 'Hukum KPR?', body: 'Bagaimana hukum KPR konvensional?' }
    });
    assert.equal(question.status, 201, JSON.stringify(question.body));
    ids.question = question.body.data.id;
    const praktisi = await register('Praktisi Anas', 'praktisi@example.com');
    await api('PATCH', `/admin/users/${praktisi.user.id}/role`, { token: tokens.admin, body: { role: 'praktisi' } });
    const answer = await api('POST', `/questions/${ids.question}/answers`, { token: praktisi.token, body: { body: 'KPR dengan bunga termasuk riba.' } });
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    assert.equal(answer.body.data.isOfficial, true);
    const detail = await api('GET', `/questions/${ids.question}`);
    assert.equal(detail.body.data.answers.length, 1);
    assert.equal(detail.body.data.hasOfficialAnswer, true);
    const edit = await api('PATCH', `/questions/${ids.question}`, { token: tokens.ahmad, body: { title: 'Ubah' } });
    assert.equal(edit.status, 400);
    const inbox = await api('GET', '/me/notifications?unread=true', { token: tokens.ahmad });
    assert.ok(inbox.body.data.some((item) => item.type === 'tanya'));
    const anonymous = await api('POST', '/questions', {
      token: tokens.ahmad, body: { category: 'Umum', title: 'Rahasia', body: 'Isi', isAnonymous: true }
    });
    assert.equal(anonymous.body.data.userName, 'Hamba Allah');
    const list = await api('GET', '/questions?category=Fiqh');
    assert.equal(list.body.data.length, 1);
  });
});

describe('riyadhoh & library', () => {
  test('toggle, logs, summary, streak, sync', async () => {
    const items = await api('GET', '/riyadhoh/items');
    assert.equal(items.body.data.items.length, 33);
    assert.equal(items.body.data.docs.length, 2);
    const today = wibDate();
    const yesterday = wibDate(-1);
    const locked = await api('PUT', `/me/riyadhoh/logs/${today}/shalat-subuh`, { token: tokens.budi, body: { completed: true } });
    assert.equal(locked.status, 200, 'budi sudah membership → riyadhoh aktif');
    const toggled = await api('PUT', `/me/riyadhoh/logs/${today}/shalat-subuh`, { token: tokens.ahmad, body: { completed: true } });
    assert.equal(toggled.body.data.streak, 1);
    await api('PUT', `/me/riyadhoh/logs/${yesterday}/shalat-dzuhur`, { token: tokens.ahmad, body: { completed: true } });
    const future = await api('PUT', `/me/riyadhoh/logs/${wibDate(1)}/shalat-subuh`, { token: tokens.ahmad, body: { completed: true } });
    assert.equal(future.status, 400);
    const unknown = await api('PUT', `/me/riyadhoh/logs/${today}/terbang`, { token: tokens.ahmad, body: { completed: true } });
    assert.equal(unknown.status, 404);
    const sync = await api('POST', '/me/riyadhoh/logs/sync', {
      token: tokens.ahmad,
      body: { entries: [
        { date: wibDate(-2), itemId: 'shalat-subuh', completed: true },
        { date: wibDate(-30), itemId: 'shalat-isya', completed: true },
        { date: today, itemId: 'ngawur', completed: true }
      ] }
    });
    assert.deepEqual(sync.body.data, { applied: 2, skipped: 1 });
    const logs = await api('GET', `/me/riyadhoh/logs?from=${wibDate(-2)}&to=${today}`, { token: tokens.ahmad });
    assert.deepEqual(logs.body.data[today], ['shalat-subuh']);
    const summary = await api('GET', '/me/riyadhoh/summary', { token: tokens.ahmad });
    assert.equal(summary.body.data.streak.current, 3);
    assert.equal(summary.body.data.today.completed, 1);
    assert.equal(summary.body.data.week.length, 7);
    const untoggled = await api('PUT', `/me/riyadhoh/logs/${today}/shalat-subuh`, { token: tokens.ahmad, body: { completed: false } });
    assert.equal(untoggled.body.data.streak, 2);
  });

  test('bookmark & progres quran', async () => {
    const ayah = await api('POST', '/me/bookmarks', { token: tokens.ahmad, body: { type: 'ayah', ref: '2:255', label: 'Al-Baqarah: 255' } });
    assert.equal(ayah.status, 201);
    const again = await api('POST', '/me/bookmarks', { token: tokens.ahmad, body: { type: 'ayah', ref: '2:255' } });
    assert.equal(again.status, 200);
    const bad = await api('POST', '/me/bookmarks', { token: tokens.ahmad, body: { type: 'ayah', ref: '200:1' } });
    assert.equal(bad.status, 400);
    const sync = await api('POST', '/me/bookmarks/sync', { token: tokens.ahmad, body: { ayahs: ['1:1', '2:255', 'x'], hadiths: ['bukhari:1'] } });
    assert.equal(sync.body.data.length, 3);
    assert.equal((await api('DELETE', `/me/bookmarks/ayah/${encodeURIComponent('1:1')}`, { token: tokens.ahmad })).status, 204);
    const list = await api('GET', '/me/bookmarks?type=ayah', { token: tokens.ahmad });
    assert.deepEqual(list.body.data.map((item) => item.ref), ['2:255']);

    const progress = await api('PUT', '/me/quran/progress', { token: tokens.ahmad, body: { surahId: 2, ayah: 255 } });
    assert.deepEqual(progress.body.data.lastRead.surahId, 2);
    const synced = await api('POST', '/me/quran/progress/sync', { token: tokens.ahmad, body: { perSurah: { 1: 7, 2: 1 } } });
    assert.deepEqual(synced.body.data.perSurah, { 1: 7, 2: 255 });
  });
});

describe('konten publik & CMS', () => {
  test('config, references, home, search', async () => {
    const config = await api('GET', '/config');
    assert.equal(config.body.data.membershipPlans.length, 3);
    const references = await api('GET', '/references');
    assert.equal(references.body.data.kordas.length, 14);
    assert.ok(references.body.data.eventTypes.some((type) => type.id === 'Sosial'));
    const home = await api('GET', '/home', { token: tokens.ahmad });
    assert.ok(home.body.data.quoteOfTheDay.text);
    assert.equal(home.body.data.upcomingEvents[0].title, 'TSN Uji');
    assert.equal(home.body.data.riyadhohToday.total, 33);
    const homeAgain = await api('GET', '/home');
    assert.equal(homeAgain.body.data.quoteOfTheDay.id, home.body.data.quoteOfTheDay.id);
    const search = await api('GET', '/search?q=riba');
    assert.ok(search.body.data.quotes.length > 0);
    assert.equal((await api('GET', '/search?q=a')).status, 400);
  });

  test('motivasi, artikel legacy id, doa, program, korda, infaq, sosial', async () => {
    const categories = await api('GET', '/motivasi/categories');
    assert.equal(categories.body.data.length, 21);
    const aqidah = await api('GET', '/motivasi/categories/aqidah');
    assert.ok(aqidah.body.data.quote);
    assert.ok(aqidah.body.data.articles.length > 0);
    const legacy = await api('GET', '/articles/1001');
    assert.equal(legacy.body.data.title, '500 Afirmasi Magnet Rezeki');
    assert.ok(legacy.body.data.content.length > 1000);
    const doas = await api('GET', '/doas?debt=true');
    assert.ok(doas.body.data.length >= 3 && doas.body.data.every((doa) => doa.debt));
    const lbu = await api('GET', '/programs/lbu');
    assert.equal(lbu.body.data.data.stats.totalLBU, 37);
    const kegiatan = await api('GET', '/programs?group=kegiatan');
    assert.equal(kegiatan.body.data.length, 5);
    assert.ok(kegiatan.body.meta.kegiatanSummary.events > 0);
    assert.equal((await api('GET', '/kordas')).body.data.length, 14);
    assert.equal((await api('GET', '/infaq/programs')).body.data.length, 3);
    assert.equal((await api('GET', '/social/links')).body.data.length, 5);
    assert.equal((await api('GET', '/quotes?category=Hijrah')).body.data.every((quote) => quote.category === 'Hijrah'), true);
  });

  test('CRUD konten admin', async () => {
    const meta = await api('GET', '/admin/content', { token: tokens.admin });
    assert.ok(meta.body.data.some((resource) => resource.key === 'quotes'));
    const created = await api('POST', '/admin/content/quotes', { token: tokens.admin, body: { text: 'Quote baru uji', author: 'Tester', category: 'Uji' } });
    assert.equal(created.status, 201);
    const updated = await api('PUT', `/admin/content/quotes/${created.body.data.id}`, { token: tokens.admin, body: { isActive: false } });
    assert.equal(updated.body.data.isActive, false);
    assert.equal((await api('DELETE', `/admin/content/quotes/${created.body.data.id}`, { token: tokens.admin })).status, 204);

    const korda = await api('POST', '/admin/content/kordas', { token: tokens.admin, body: { id: 'papua', label: 'Korda Papua', sortOrder: 99 } });
    assert.equal(korda.status, 201);
    const duplicate = await api('POST', '/admin/content/kordas', { token: tokens.admin, body: { id: 'papua', label: 'Korda Papua' } });
    assert.equal(duplicate.status, 409);
    const badSlug = await api('POST', '/admin/content/kordas', { token: tokens.admin, body: { id: 'Papua Barat', label: 'X' } });
    assert.equal(badSlug.status, 400);
    const eventType = await api('POST', '/admin/content/event-types', { token: tokens.admin, body: { id: 'Webinar', label: 'Webinar' } });
    assert.equal(eventType.status, 201);
    assert.ok((await api('GET', '/references')).body.data.eventTypes.some((type) => type.id === 'Webinar'));
    const noDelete = await api('DELETE', '/admin/content/riyadhoh-items/shalat-subuh', { token: tokens.admin });
    assert.equal(noDelete.status, 400);
    const program = await api('PUT', '/admin/content/programs/lbu', { token: tokens.admin, body: { data: { stats: { totalLBU: 38 } } } });
    assert.equal(program.body.data.data.stats.totalLBU, 38);
    const config = await api('PUT', '/admin/app-config', { token: tokens.admin, body: { latest_version: '1.1.0' } });
    assert.equal(config.status, 403);
    const configSuper = await api('PUT', '/admin/app-config', { token: tokens.super, body: { latest_version: '1.1.0' } });
    assert.equal(configSuper.body.data.latest_version, '1.1.0');
    assert.equal((await api('GET', '/config')).body.data.app.latestVersion, '1.1.0');
  });

  test('broadcast, dashboard, audit log', async () => {
    const broadcast = await api('POST', '/admin/notifications/broadcast', {
      token: tokens.admin, body: { title: 'TSN dibuka', body: 'Ayo daftar', type: 'event', target: { membershipTypes: ['sahabat'] } }
    });
    assert.equal(broadcast.status, 202);
    assert.ok(broadcast.body.data.recipients >= 2);
    const dashboard = await api('GET', '/admin/dashboard', { token: tokens.admin });
    assert.ok(dashboard.body.data.users.total >= 5);
    assert.equal((await api('GET', '/admin/audit-logs', { token: tokens.admin })).status, 403);
    const audit = await api('GET', '/admin/audit-logs', { token: tokens.super });
    assert.ok(audit.body.data.some((entry) => entry.action === 'notification.broadcast'));
  });
});

describe('sesi admin web (cookie)', () => {
  test('login cookie wajib same-origin', async () => {
    const noOrigin = await api('POST', '/admin/session', { body: { identifier: 'super@idtc.test', password: 'SuperAdmin123' } });
    assert.equal(noOrigin.status, 403);
    const nonStaff = await api('POST', '/admin/session', {
      headers: { Origin: ctx.origin }, body: { identifier: 'budi@example.com', password: 'x' }
    });
    assert.equal(nonStaff.status, 401);
    const login = await api('POST', '/admin/session', {
      headers: { Origin: ctx.origin }, body: { identifier: 'super@idtc.test', password: 'SuperAdmin123' }
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    const dashboard = await api('GET', '/admin/dashboard', { headers: { Cookie: cookie } });
    assert.equal(dashboard.status, 200);
    const crossSite = await api('POST', '/admin/content/quotes', {
      headers: { Cookie: cookie, Origin: 'https://evil.example' }, body: { text: 'x' }
    });
    assert.equal(crossSite.status, 401);
    const sameSite = await api('POST', '/admin/content/quotes', {
      headers: { Cookie: cookie, Origin: ctx.origin }, body: { text: 'dari panel' }
    });
    assert.equal(sameSite.status, 201);
    assert.equal((await api('DELETE', '/admin/session', { headers: { Cookie: cookie } })).status, 204);
    assert.equal((await api('GET', '/admin/dashboard', { headers: { Cookie: cookie } })).status, 401);
  });
});

describe('endpoint tambahan', () => {
  test('preferensi, progres, device, notifikasi tunggal', async () => {
    const prefs = await api('GET', '/me/preferences', { token: tokens.ahmad });
    assert.equal(prefs.body.data.theme, 'dark');
    const progress = await api('GET', '/me/quran/progress', { token: tokens.ahmad });
    assert.equal(progress.body.data.lastRead.surahId, 2);
    assert.equal((await api('POST', '/me/devices', { token: tokens.ahmad, body: { expoPushToken: 'ExponentPushToken[test]', platform: 'android' } })).status, 204);
    const device = await ctx.pool.query('SELECT user_id FROM user_devices WHERE expo_push_token = $1', ['ExponentPushToken[test]']);
    assert.equal(device.rows[0].user_id, ids.ahmad);
    assert.equal((await api('DELETE', `/me/devices/${encodeURIComponent('ExponentPushToken[test]')}`, { token: tokens.ahmad })).status, 204);
    assert.equal((await ctx.pool.query('SELECT 1 FROM user_devices')).rowCount, 0);
    const badDevice = await api('POST', '/me/devices', { token: tokens.ahmad, body: {} });
    assert.equal(badDevice.status, 400);

    await api('POST', '/admin/notifications/broadcast', { token: tokens.admin, body: { title: 'Tes satu', body: 'Isi', target: { all: true } } });
    const unread = await api('GET', '/me/notifications?unread=true', { token: tokens.budi });
    assert.ok(unread.body.data.length >= 1);
    const target = unread.body.data[0];
    assert.equal((await api('POST', `/me/notifications/${target.id}/read`, { token: tokens.budi })).status, 204);
    const after = await api('GET', '/me/notifications', { token: tokens.budi });
    assert.equal(after.body.data.find((item) => item.id === target.id).read, true);
    assert.equal(after.body.meta.unread, unread.body.meta.unread - 1);
    // notifikasi milik orang lain tidak terpengaruh
    await api('POST', `/me/notifications/${target.id}/read`, { token: tokens.ahmad });
  });

  test('konten publik tambahan', async () => {
    const plans = await api('GET', '/membership-plans');
    assert.deepEqual(plans.body.data.map((plan) => plan.type), ['free', 'membership', 'sahabat']);
    const daily = await api('GET', '/quotes/daily');
    assert.ok(daily.body.data.text);
    const articles = await api('GET', '/articles?categoryId=aqidah');
    assert.ok(articles.body.data.length > 0 && articles.body.data.every((article) => article.categoryId === 'aqidah'));
    assert.equal(articles.body.data[0].content, undefined);
    const posts = await api('GET', '/social/posts?platform=instagram&limit=2');
    assert.ok(posts.body.data.length <= 2 && posts.body.data.every((post) => post.platform === 'instagram'));
    assert.equal((await api('GET', '/articles/abc')).status, 404);
    assert.equal((await api('GET', '/motivasi/categories/tidak-ada')).status, 404);
    assert.equal((await api('GET', '/programs/tidak-ada')).status, 404);
  });

  test('testimoni milik sendiri & hapus', async () => {
    const created = await api('POST', '/testimonials', {
      token: tokens.budi, body: { program: 'TSN', rating: 4, text: 'TSN bulan ini sangat bermanfaat sekali.' }
    });
    const mine = await api('GET', '/me/testimonials', { token: tokens.budi });
    assert.ok(mine.body.data.some((item) => item.id === created.body.data.id && item.status === 'pending'));
    assert.equal((await api('DELETE', `/testimonials/${created.body.data.id}`, { token: tokens.ahmad })).status, 404);
    assert.equal((await api('DELETE', `/testimonials/${created.body.data.id}`, { token: tokens.budi })).status, 204);
  });

  test('tanya: hapus pertanyaan & jawaban sendiri', async () => {
    const question = await api('POST', '/questions', { token: tokens.budi, body: { category: 'Umum', title: 'Tes hapus', body: 'Isi' } });
    const answer = await api('POST', `/questions/${question.body.data.id}/answers`, { token: tokens.ahmad, body: { body: 'Jawaban member' } });
    assert.equal(answer.body.data.isOfficial, false);
    assert.equal((await api('DELETE', `/answers/${answer.body.data.id}`, { token: tokens.budi })).status, 404);
    assert.equal((await api('DELETE', `/answers/${answer.body.data.id}`, { token: tokens.ahmad })).status, 204);
    const edited = await api('PATCH', `/questions/${question.body.data.id}`, { token: tokens.budi, body: { title: 'Judul baru' } });
    assert.equal(edited.body.data.title, 'Judul baru');
    assert.equal((await api('DELETE', `/questions/${question.body.data.id}`, { token: tokens.ahmad })).status, 404);
    assert.equal((await api('DELETE', `/questions/${question.body.data.id}`, { token: tokens.budi })).status, 204);
    assert.equal((await api('GET', `/questions/${question.body.data.id}`)).status, 404);
  });

  test('lapak: hitung kontak & admin edit/hapus', async () => {
    const upload = await api('POST', '/uploads', { token: tokens.ahmad, form: imageForm({ purpose: 'product' }) });
    const created = await api('POST', '/lapak/products', {
      token: tokens.ahmad,
      body: { name: 'Gamis Syari', category: 'fashion', description: 'Bahan adem', price: 275000, sellerWhatsapp: '081211112222', photos: [upload.body.data.url] }
    });
    const id = created.body.data.id;
    assert.equal((await api('POST', `/lapak/products/${id}/contact`)).status, 204);
    let row = await ctx.pool.query('SELECT contact_count FROM lapak_products WHERE id = $1', [id]);
    assert.equal(row.rows[0].contact_count, 0, 'produk pending tidak dihitung');
    await api('POST', `/admin/lapak/products/${id}/approve`, { token: tokens.admin });
    await api('POST', `/lapak/products/${id}/contact`);
    row = await ctx.pool.query('SELECT contact_count FROM lapak_products WHERE id = $1', [id]);
    assert.equal(row.rows[0].contact_count, 1);

    const list = await api('GET', '/admin/lapak/products?status=approved', { token: tokens.admin });
    assert.ok(list.body.data.some((item) => item.id === id));
    assert.equal(list.body.meta.counts.approved >= 1, true);
    const edited = await api('PUT', `/admin/lapak/products/${id}`, {
      token: tokens.admin,
      body: { name: 'Gamis Syari Premium', category: 'fashion', description: 'Bahan adem', price: 275000, sellerWhatsapp: '081211112222', photos: [upload.body.data.url] }
    });
    assert.equal(edited.body.data.name, 'Gamis Syari Premium');
    assert.equal(edited.body.data.status, 'approved', 'edit admin tidak mengubah status');
    assert.equal((await api('DELETE', `/admin/lapak/products/${id}`, { token: tokens.ahmad })).status, 403);
    assert.equal((await api('DELETE', `/admin/lapak/products/${id}`, { token: tokens.admin })).status, 204);
    assert.equal((await api('GET', `/lapak/products/${id}`)).status, 404);
  });

  test('admin: user list & detail, event list/detail, plan membership', async () => {
    const users = await api('GET', '/admin/users?q=ahmad', { token: tokens.admin });
    assert.equal(users.body.data.length, 1);
    assert.equal(users.body.data[0].email, 'ahmad@example.com');
    const sahabat = await api('GET', '/admin/users?membershipType=sahabat&role=calon_sahabat', { token: tokens.admin });
    assert.ok(sahabat.body.data.every((user) => user.membershipType === 'sahabat' && user.role === 'calon_sahabat'));
    const detail = await api('GET', `/admin/users/${ids.ahmad}`, { token: tokens.admin });
    assert.equal(detail.body.data.lbuBatch, 37);
    assert.equal((await api('GET', '/admin/users/bukan-uuid', { token: tokens.admin })).status, 404);

    const events = await api('GET', '/admin/events?status=published,draft', { token: tokens.admin });
    assert.ok(events.body.data.some((event) => event.id === ids.event));
    const event = await api('GET', `/admin/events/${ids.event}`, { token: tokens.admin });
    assert.equal(event.body.data.title, 'TSN Uji');

    const plans = await api('GET', '/admin/membership-plans', { token: tokens.admin });
    const free = plans.body.data.find((plan) => plan.type === 'free');
    assert.equal(free.features.find((feature) => feature.id === 'event').enabled, false);
    const byAdmin = await api('PUT', '/admin/membership-plans/free', { token: tokens.admin, body: { features: [{ id: 'event', enabled: true }] } });
    assert.equal(byAdmin.status, 403);
    const bySuper = await api('PUT', '/admin/membership-plans/free', { token: tokens.super, body: { label: 'Free', features: [{ id: 'event', enabled: true }] } });
    assert.equal(bySuper.body.data.features.find((feature) => feature.id === 'event').enabled, true);
    const freeUser = await register('Dewi Free', 'dewi@example.com');
    assert.equal(freeUser.user.membershipFeatures.event, true, 'fitur plan baru berlaku untuk user free');
    await api('PUT', '/admin/membership-plans/free', { token: tokens.super, body: { label: 'Free Member', features: [{ id: 'event', enabled: false }] } });
    ids.dewi = freeUser.user.id;
  });

  test('admin: testimoni manual, tolak, hapus', async () => {
    const created = await api('POST', '/admin/testimonials', {
      token: tokens.admin, body: { name: 'Pak Haji', program: 'LBU', rating: 5, text: 'Alhamdulillah lunas setelah ikut LBU IDTC.', korda: 'bandung', date: '2026-05-01' }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.status, 'approved');
    assert.equal(created.body.data.kordaLabel, 'Korda Bandung');
    const list = await api('GET', '/admin/testimonials?status=approved', { token: tokens.admin });
    assert.ok(list.body.data.some((item) => item.id === created.body.data.id));
    const rejected = await api('POST', `/admin/testimonials/${created.body.data.id}/reject`, { token: tokens.admin, body: { reason: 'Duplikat' } });
    assert.equal(rejected.body.data.status, 'rejected');
    assert.equal(rejected.body.data.rejectionReason, 'Duplikat');
    assert.equal((await api('DELETE', `/admin/testimonials/${created.body.data.id}`, { token: tokens.admin })).status, 204);
  });

  test('admin: kelola pertanyaan & jawaban', async () => {
    const list = await api('GET', '/admin/questions', { token: tokens.admin });
    assert.ok(list.body.data.length >= 2);
    const unanswered = await api('GET', '/admin/questions?answered=false', { token: tokens.admin });
    assert.ok(unanswered.body.data.every((item) => !item.hasOfficialAnswer));
    const closed = await api('PATCH', `/admin/questions/${ids.question}`, { token: tokens.admin, body: { status: 'closed' } });
    assert.equal(closed.body.data.status, 'closed');
    const blocked = await api('POST', `/questions/${ids.question}/answers`, { token: tokens.ahmad, body: { body: 'telat' } });
    assert.equal(blocked.status, 400);
    const detail = await api('GET', `/questions/${ids.question}`);
    assert.equal((await api('DELETE', `/admin/answers/${detail.body.data.answers[0].id}`, { token: tokens.admin })).status, 204);
    assert.equal((await api('DELETE', `/admin/questions/${ids.question}`, { token: tokens.admin })).status, 204);
    assert.equal((await api('GET', `/questions/${ids.question}`)).status, 404);
  });

  test('admin: daftar semua resource konten, app-config, riwayat broadcast', async () => {
    const resources = (await api('GET', '/admin/content', { token: tokens.admin })).body.data;
    for (const resource of resources) {
      const list = await api('GET', `/admin/content/${resource.key}`, { token: tokens.admin });
      assert.equal(list.status, 200, resource.key);
      assert.ok(Array.isArray(list.body.data), resource.key);
    }
    const quotes = await api('GET', '/admin/content/quotes?q=riba', { token: tokens.admin });
    assert.ok(quotes.body.meta.total > 0);
    // Field opsional kosong (null) tidak menimpa default kolom database.
    const post = await api('POST', '/admin/content/social-posts', {
      token: tokens.admin,
      body: { platform: 'instagram', title: 'Post tanpa tanggal', url: 'https://instagram.com/p/x', publishedAt: null, deepLink: null }
    });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    assert.ok(post.body.data.publishedAt, 'published_at memakai default database');
    // Resource tanpa konfigurasi search tetap bisa dicari (kode + kolom teks).
    const kordas = await api('GET', '/admin/content/kordas?q=bandung', { token: tokens.admin });
    assert.deepEqual(kordas.body.data.map((item) => item.id), ['bandung']);
    const noMatch = await api('GET', '/admin/content/kordas?q=tidak-ada-korda', { token: tokens.admin });
    assert.equal(noMatch.body.meta.total, 0);
    assert.equal((await api('GET', '/admin/content/tidak-ada', { token: tokens.admin })).status, 404);
    const config = await api('GET', '/admin/app-config', { token: tokens.admin });
    assert.equal(config.body.data.latest_version, '1.1.0');
    const broadcasts = await api('GET', '/admin/notifications/broadcasts', { token: tokens.admin });
    assert.ok(broadcasts.body.data.length >= 2);
    assert.ok(broadcasts.body.data[0].sentBy);
  });

  test('super admin hapus user & user hapus akun sendiri', async () => {
    assert.equal((await api('DELETE', `/admin/users/${ids.dewi}`, { token: tokens.super })).status, 204);
    assert.equal((await api('GET', `/admin/users/${ids.dewi}`, { token: tokens.admin })).status, 404);
    const temp = await register('Eko Hapus', 'eko@example.com');
    assert.equal((await api('DELETE', '/me', { token: temp.token, body: { password: 'salah' } })).status, 400);
    assert.equal((await api('DELETE', '/me', { token: temp.token, body: { password: 'rahasia123' } })).status, 204);
    assert.equal((await api('POST', '/auth/login', { body: { identifier: 'eko@example.com', password: 'rahasia123' } })).status, 401);
  });
});

describe('statistik & kesehatan sistem', () => {
  test('tren dashboard: rentang hari, DAU dari aktivitas, korda & event', async () => {
    assert.equal((await api('GET', '/admin/stats/trends', { token: tokens.ahmad })).status, 403);
    assert.equal((await api('GET', '/admin/stats/trends?days=3', { token: tokens.admin })).status, 400);
    // Aktivitas dicatat asinkron saat request terautentikasi.
    await api('GET', '/auth/me', { token: tokens.ahmad });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const trends = await api('GET', '/admin/stats/trends?days=7', { token: tokens.admin });
    assert.equal(trends.status, 200);
    const data = trends.body.data;
    assert.equal(data.days, 7);
    assert.equal(data.series.length, 7);
    assert.equal(data.series.at(-1).date, data.to);
    assert.ok(data.summary.dau >= 1, 'user aktif hari ini tercatat');
    assert.ok(data.summary.mau >= data.summary.wau && data.summary.wau >= data.summary.dau);
    const today = data.series.at(-1);
    assert.ok(today.newUsers >= 1);
    assert.ok(today.activeUsers >= 1);
    assert.ok(Array.isArray(data.usersByKorda) && data.usersByKorda.length >= 1);
    assert.ok(Array.isArray(data.topEvents));
    const defaultRange = await api('GET', '/admin/stats/trends', { token: tokens.admin });
    assert.equal(defaultRange.body.data.series.length, 30);
  });

  test('kesehatan sistem: database, penyimpanan, metrik request', async () => {
    assert.equal((await api('GET', '/admin/system/health', { token: tokens.ahmad })).status, 403);
    const health = await api('GET', '/admin/system/health', { token: tokens.admin });
    assert.equal(health.status, 200);
    const data = health.body.data;
    assert.equal(data.status, 'ok');
    assert.equal(data.database.ok, true);
    assert.ok(data.database.sizeBytes > 0);
    assert.ok(data.database.tables.length > 0);
    assert.deepEqual(data.storage.purposes.map((item) => item.purpose), ['avatar', 'product', 'testimonial', 'event', 'content']);
    assert.ok(data.storage.files >= 1, 'upload dari test sebelumnya terhitung');
    assert.ok(data.requests.total > 0);
    assert.ok(data.requests.clientErrors > 0, 'respons 4xx dari test sebelumnya terhitung');
    assert.ok(data.app.mobileSessions >= 1);
    assert.equal(data.server.env.nodeEnv, 'test');
  });
});

describe('kisah, kuis, buku, grup ibadah', () => {
  test('konten publik dari seed', async () => {
    const stories = await api('GET', '/stories');
    assert.equal(stories.status, 200);
    assert.ok(stories.body.data.length >= 20);
    assert.equal(stories.body.data[0].body, undefined, 'daftar kisah tanpa isi lengkap');
    const nabi = await api('GET', '/stories?category=nabi');
    assert.ok(nabi.body.data.length > 0 && nabi.body.data.every((story) => story.category === 'nabi'));
    const detail = await api('GET', `/stories/${nabi.body.data[0].id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.data.body.length > 50);
    assert.equal((await api('GET', '/stories/tidak-ada')).status, 404);

    const quiz = await api('GET', '/quiz-questions');
    assert.ok(quiz.body.data.length >= 20);
    assert.ok(quiz.body.data.every((question) => question.choices.includes(question.answer)));
    const akad = await api('GET', `/quiz-questions?category=${encodeURIComponent('Akad Syariah')}`);
    assert.ok(akad.body.data.length > 0 && akad.body.data.every((question) => question.category === 'Akad Syariah'));

    const books = await api('GET', '/books');
    assert.equal(books.body.data[0].id, 'buku-sakti-lunas-utang');
    assert.match(books.body.data[0].url, /^https:\/\//);
  });

  test('gabung & keluar grup ibadah, jumlah anggota', async () => {
    const guest = await api('GET', '/worship-groups');
    assert.deepEqual(guest.body.data.map((group) => group.id), ['tahajud-call', 'dhuha-call', 'taubat-call']);
    assert.equal(guest.body.data[0].joined, false);
    assert.equal(guest.body.data[0].reminderKey, 'tahajudCallEnabled');
    assert.equal((await api('POST', '/worship-groups/tahajud-call/join')).status, 401);

    const joined = await api('POST', '/worship-groups/tahajud-call/join', { token: tokens.ahmad });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.data.joined, true);
    assert.equal(joined.body.data.memberCount, 1);
    const again = await api('POST', '/worship-groups/tahajud-call/join', { token: tokens.ahmad });
    assert.equal(again.body.data.memberCount, 1, 'gabung dua kali tidak menggandakan');
    await api('POST', '/worship-groups/tahajud-call/join', { token: tokens.admin });
    const list = await api('GET', '/worship-groups', { token: tokens.ahmad });
    assert.equal(list.body.data[0].memberCount, 2);
    assert.equal(list.body.data[0].joined, true);
    assert.equal(list.body.data[1].joined, false);

    const left = await api('DELETE', '/worship-groups/tahajud-call/join', { token: tokens.ahmad });
    assert.equal(left.body.data.joined, false);
    assert.equal(left.body.data.memberCount, 1);
    assert.equal((await api('POST', '/worship-groups/tidak-ada/join', { token: tokens.ahmad })).status, 404);
  });

  test('CMS: soal kuis divalidasi, buku wajib https', async () => {
    const badAnswer = await api('POST', '/admin/content/quiz-questions', {
      token: tokens.admin,
      body: { id: 'uji-kuis', category: 'Uji', question: 'Satu tambah satu?', choices: ['1', '2'], answer: '3' }
    });
    assert.equal(badAnswer.status, 400);
    assert.equal(badAnswer.body.field, 'answer');
    const created = await api('POST', '/admin/content/quiz-questions', {
      token: tokens.admin,
      body: { id: 'uji-kuis', category: 'Uji', question: 'Satu tambah satu?', choices: '1, 2, 3', answer: '2', explanation: 'Dasar.' }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.data.choices, ['1', '2', '3']);
    const book = await api('POST', '/admin/content/books', { token: tokens.admin, body: { id: 'buku-uji', title: 'Buku Uji', url: 'http://contoh.test/buku' } });
    assert.equal(book.status, 400);
    assert.equal(book.body.field, 'url');
    assert.equal((await api('DELETE', '/admin/content/quiz-questions/uji-kuis', { token: tokens.admin })).status, 204);
  });
});

describe('cakupan endpoint', () => {
  test('setiap route API terpanggil minimal sekali', () => {
    const missing = ctx.listRoutes().filter((route) => !ctx.hits.has(route));
    assert.deepEqual(missing, [], `Route belum dites:\n${missing.join('\n')}`);
  });
});
