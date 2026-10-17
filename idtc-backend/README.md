# IDTC Backend

Backend API dan panel admin (CMS) untuk aplikasi mobile **IDTC / IDTC** (Expo, repo `../NASJAK`).
Arsitektur dan konvensi database mengikuti project `idtc-user`:

- **Node.js ≥ 20** dengan ES Modules, **Express 5**, **PostgreSQL** lewat `pg` dengan SQL mentah. Tidak memakai ORM.
- Skema idempoten di `schema.sql`, dengan UUID primary key, snake_case, `TIMESTAMPTZ`, dan constraint `CHECK`.
- Role disimpan many-to-many (`roles` + `user_roles`).
- Sesi disimpan sebagai **hash SHA-256 token** di `user_sessions`:
  - Aplikasi mobile memakai `Authorization: Bearer <token>`.
  - Panel admin web memakai cookie `HttpOnly` + `SameSite=Strict` dan pemeriksaan same-origin.
- Keamanan:
  - password di-hash dengan `bcryptjs`;
  - header keamanan dengan `helmet` (CSP);
  - pembatasan percobaan login dengan `express-rate-limit`;
  - upload memakai `multer`, dan tipe gambar divalidasi dari isi file dengan `file-type`.
- Format error mengikuti idtc-user: `{ "error": "pesan", "field"?: "nama_field" }`. Respons sukses berbentuk `{ "data": …, "meta"?: … }`.
- Panel admin dibangun dengan **Tailwind CSS v4** (dibuild lewat CLI) dan **Alpine.js** (disajikan dari `node_modules`, tanpa CDN).

## Panel admin (`/admin`)

Untuk tim operasional: Dashboard (angka ringkas + grafik tren DAU/WAU/MAU, anggota baru, riyadhoh, aktivitas komunitas, sebaran korda, event terpopuler), Anggota, Lapak, Event, Registrasi (+ export CSV untuk Excel), Testimoni, Tanya Praktisi, Konten CMS, Membership, Broadcast, Pengaturan App, **Kesehatan Sistem** (database, penyimpanan upload, server, sesi, error terbaru — angka request/error reset saat server restart), dan Audit Log (Super Admin). Grafik memakai Chart.js yang disajikan dari `node_modules`.

## Struktur

```
server.js              entry point: start HTTP, siapkan skema, seed master, bootstrap Super Admin
schema.sql             skema database (idempoten, juga dijalankan otomatis saat start)
database.sql           buat database `idtc_backend` + jalankan schema.sql (psql)
src/
  app.js               setup Express (helmet, CORS dev, static admin/uploads, route, error handler)
  db.js                pool pg, ensureSchema, withTransaction, audit()
  http.js              HttpError, validator, paging, helper tanggal WIB
  auth.js              sesi/token, loadUser + fitur membership efektif, middleware auth/role/fitur
  google.js            verifikasi token Sign in with Google (JWKS Google, audience = GOOGLE_CLIENT_IDS)
  uploads.js           upload gambar (validasi magic bytes) ke uploads/<purpose>/
  notify.js            inbox notifikasi + Expo push (best effort)
  resources.js         definisi konten CMS generik (dipakai endpoint publik & CRUD admin)
  seed.js              seed master/konten/sampel + bootstrap Super Admin
  routes/
    auth.js            register, login, logout, me, ganti password, sesi admin web
    me.js              profil, avatar, stats, hapus akun, upload, preferensi, device, notifikasi
    library.js         bookmark ayat/hadis, progres baca Quran
    riyadhoh.js        item, log harian, sync, ringkasan & streak
    events.js          event & registrasi
    lapak.js           produk lapak
    community.js       testimoni, tanya praktisi
    features.js        kisah nabi & rasul, kuis NAS, buku digital, grup ibadah (gabung/keluar)
    content.js         config, referensi, home, search, motivasi, artikel, doa, program, korda, infaq, sosial
    admin.js           dashboard, user, membership, moderasi, event, registrasi, CRUD konten, broadcast, audit
admin/                 panel admin: index.html + admin.js (Alpine) + admin.input.css → admin.css (Tailwind)
seeds/content.json     konten hasil ekstraksi dari app mobile (motivasi, doa, korda, riyadhoh, program, dll.)
scripts/
  extract-app-content.js  ekstrak konstanta app → seeds/content.json
  extract-feature-content.js  ekstrak kisah, kuis, buku, grup ibadah dari app → seeds/content.json
  seed.js                 isi database dari seeds/content.json
test/                  test integrasi (node:test) memakai DB terpisah idtc_test
```

## Menjalankan lokal

Persyaratan: Node.js 20+ dan PostgreSQL 14+.

```bash
npm install
cp .env.example .env              # isi DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD
npm run db:setup                  # buat database idtc_backend + tabel (atau biarkan server membuat tabel saat start)
npm run db:seed -- --samples      # konten CMS + event & testimoni contoh (tanpa --samples untuk produksi)
npm run build:css                 # build Tailwind untuk panel admin
npm start                         # http://localhost:3100  → admin: /admin, API: /api/v1
```

- Saat start, server menjalankan `schema.sql`, mengisi data master (fitur dan plan membership, referensi, korda, item riyadhoh), lalu membuat **Super Admin** dari `ADMIN_EMAIL`/`ADMIN_PASSWORD` bila akun itu belum ada.
- `npm run dev` menjalankan server dengan `--watch`. `npm run watch:css` mem-build ulang Tailwind setiap file berubah.
- Agar HP di jaringan yang sama bisa mengakses backend, server listen di `0.0.0.0`. Di app, isi `EXPO_PUBLIC_API_BASE_URL=http://<IP-LAN>:3100/api/v1`.
- Untuk Expo web, tambahkan origin dev (mis. `http://localhost:8081`) ke `CORS_ORIGINS`.
- Lupa password Super Admin: `npm run admin:reset-password` (password diketik tersembunyi, sesi lama dicabut).
- Login Google: isi `GOOGLE_CLIENT_IDS` dengan client ID OAuth app (web, Android, iOS; pisahkan koma). Kosong = login Google nonaktif (`503`).

## Login Google

`POST /api/v1/auth/google` dengan body `{ "idToken": "..." }` (disarankan) atau `{ "accessToken": "..." }`:

- `idToken` diverifikasi tanda tangannya dengan JWKS Google; issuer harus Google dan audience salah satu `GOOGLE_CLIENT_IDS`.
- `accessToken` dicek ke endpoint `tokeninfo` Google (audience/azp harus client ID app), profil dari `userinfo`.
- Email harus sudah diverifikasi Google. Akun ditautkan lewat `sub` Google (tabel `oauth_identities`), bukan email:
  - `sub` sudah tertaut → masuk ke akun itu;
  - belum tertaut tetapi email sudah terdaftar → akun email/HP itu ditautkan ke Google;
  - email terdaftar dan sudah tertaut ke akun Google lain → `409`;
  - belum ada → akun baru (Calon Sahabat, membership free) **tanpa password**, foto profil dari Google.
- Respons sama dengan `/auth/login` ditambah `isNewUser` (`201` untuk akun baru).
- Akun tanpa password ditolak di login password dengan arahan memakai Google, boleh membuat password pertama lewat
  `PUT /auth/password` tanpa `currentPassword`, dan menghapus akun dengan `DELETE /me` body `{ "confirmation": "HAPUS" }`.

## Deploy

- Hostinger Node.js Web App + Supabase: [docs/installation/hostinger-web-app.md](docs/installation/hostinger-web-app.md)

## Test

```bash
npm test
```

Test membuat atau mengosongkan database `idtc_test` sendiri (atur lewat `TEST_DATABASE_URL`), lalu menjalankan server di port acak dan menguji alur berikut:

- auth (termasuk login Google dengan JWKS uji);
- profil dan avatar;
- gating membership;
- event dan kuota;
- moderasi lapak dan testimoni;
- tanya praktisi;
- riyadhoh dan streak;
- bookmark;
- konten publik;
- kisah, kuis, buku, grup ibadah;
- CRUD CMS;
- broadcast;
- audit;
- sesi cookie admin.

## Role & akses

| Role | Keterangan |
|---|---|
| `super_admin` | semua akses, termasuk ubah plan membership, pengaturan app, hapus user, audit log |
| `admin` | kelola anggota non-staf, moderasi lapak/testimoni/tanya, event, registrasi, konten, broadcast |
| `praktisi` | jawaban di Tanya Praktisi ditandai **resmi**; boleh menjawab walau membership free |
| `sahabat`, `calon_sahabat` | anggota |

Fitur membership (`event`, `lapak`, `tanya`, `riyadhoh`, …) **ditegakkan di server**. Fitur yang aktif adalah fitur plan (`membership_plan_features`), ditimpa override per user (`user_feature_overrides`). Request ke fitur yang terkunci dijawab `403 { code: "FEATURE_LOCKED", feature }`.

## Belum dikerjakan (fase berikutnya)

- Login Google (`POST /auth/google`). Tabel `oauth_identities` sudah disiapkan.
- Lupa password via OTP email. Sementara ini admin me-reset password dan user mendapat password sementara.
- Konfirmasi infaq, banner Home, slide onboarding dari CMS, dan asisten Anas di server.

Spesifikasi lengkap: `../NASJAK/.claude/analysis/03-api-docs.md`.
