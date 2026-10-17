# idtc_CMS_user

Monorepo ekosistem **IDTC** — dua aplikasi Node.js/Express + PostgreSQL:

| Folder | Aplikasi | Port | Keterangan |
|---|---|---|---|
| `idtc-backend/` | Backend API & CMS mobile | 3100 | REST API `/api/v1` + panel admin `/admin` untuk aplikasi mobile IDTC (Expo) |
| `web_idtc/` | Portal anggota web | 3000 | Pendaftaran anggota, dashboard profil, KTA + QR, sertifikat, pilot project, CMS `/admin` |

Dokumentasi detail masing-masing aplikasi ada di [idtc-backend/README.md](idtc-backend/README.md) dan [web_idtc/README.md](web_idtc/README.md).

## Persyaratan

- Node.js 20 atau lebih baru
- PostgreSQL 14 atau lebih baru

## Menjalankan lokal

### 1. Pastikan PostgreSQL berjalan

Kedua aplikasi memakai database terpisah (lihat `DATABASE_URL` di `.env` masing-masing): `idtc_backend` untuk backend, `idtc` untuk portal web.

### 2. Backend — port 3100

```bash
cd idtc-backend
npm install
cp .env.example .env   # isi DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD
npm start               # http://localhost:3100
```

Saat start, server otomatis menjalankan `schema.sql` (idempoten), mengisi data master (fitur/plan membership, referensi, korda, item riyadhoh), lalu membuat Super Admin dari `ADMIN_EMAIL`/`ADMIN_PASSWORD` bila belum ada. Gunakan `npm run dev` untuk mode `--watch`.

### 3. Portal anggota — port 3000

```bash
cd web_idtc
npm install
cp .env.example .env   # isi DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD
npm run db:setup        # buat database + tabel IDTC
npm start               # http://localhost:3000
```

Buka alamat dari server Node tersebut (bukan server file statis) agar form pendaftaran dapat mencapai API.

## URL penting

| URL | Keterangan |
|---|---|
| http://localhost:3000 | Portal anggota (login, dashboard, KTA, pilot project) |
| http://localhost:3000/admin | Panel admin portal (keanggotaan, CMS) |
| http://localhost:3100/admin | Panel admin/CMS aplikasi mobile |
| http://localhost:3100/api/v1 | REST API aplikasi mobile |

Agar HP di jaringan yang sama bisa mengakses, backend listen di `0.0.0.0` — pakai `http://<IP-LAN>:3100/api/v1` sebagai `EXPO_PUBLIC_API_BASE_URL` di app.

## Struktur repo

```
idtc_CMS_user/
  idtc-backend/     Backend API & CMS mobile (Express 5, PostgreSQL, Tailwind v4 + Alpine.js)
    server.js       entry point: HTTP + skema + seed + bootstrap Super Admin
    schema.sql      skema database idempoten (juga dijalankan otomatis saat start)
    src/            app, db, auth, routes (auth, me, events, lapak, admin, ...)
    admin/          panel admin web
    test/           test integrasi (node:test, DB terpisah idtc_test)
  web_idtc/         Portal anggota web (Express 5, PostgreSQL)
    server.js       entry point portal + API pendaftaran/anggota
    index.html      halaman utama portal
    admin.html      panel admin portal
    verify.html     verifikasi KTA via QR
    database.sql    setup database + tabel IDTC
```

## Keamanan

- File `.env` (kredensial database, OAuth, token reset) **tidak boleh di-commit** — sudah masuk `.gitignore`. Salin dari `.env.example` lalu isi lokal.
- Kata sandi disimpan sebagai hash bcrypt; sesi disimpan sebagai hash token (cookie `HttpOnly` untuk web, Bearer token untuk app mobile).

## Git

```bash
git checkout -b <branch>   # buat branch fitur
git add .
git commit -m "pesan"
git push -u origin <branch>
```

Branch utama: `main`. Remote: `https://github.com/dpdh/idtc_CMS_user.git`.
