# Deploy ke Hostinger Node.js Web App + Supabase PostgreSQL

Panduan ini mengikuti pola `idtc-user` (Jalur B). Backend IDTC berjalan sebagai **Node.js Web App** di paket Business/Cloud Hosting Hostinger, database di **Supabase** (panel Hostinger hanya menyediakan MySQL, padahal backend ini wajib PostgreSQL).

Hasil akhirnya:
- API untuk app mobile: `https://api.domainanda.com/api/v1`
- Panel admin web: `https://api.domainanda.com/admin`

> **Perhatian, file upload.** Avatar, foto produk lapak, foto testimoni, dan banner event disimpan di disk server. Di Web App, folder aplikasi bisa diganti saat deploy ulang. Ikuti langkah 4 (folder upload di luar folder aplikasi) dan **uji** di langkah 7 sebelum go-live.

---

## 1. Buat database di Supabase

1. Daftar di <https://supabase.com> → **New project**.
   - **Region**: **Southeast Asia (Singapore)**.
   - **Database password**: buat yang kuat lalu simpan (di bawah disebut `PASSWORD_DB`). Hindari karakter `@ : / ? #`; kalau terpakai, URL-encode di connection string.
2. Buka **Project → Connect** → salin **Session pooler** (port `5432`):

   ```
   postgresql://postgres.<project-ref>:PASSWORD_DB@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
   ```

   - Pakai **Session pooler**, bukan *Direct connection* (hanya IPv6, biasanya tidak terjangkau dari shared hosting).
   - Jangan pakai *Transaction pooler* (port 6543); backend memakai transaksi `BEGIN/COMMIT` dan `SELECT … FOR UPDATE`.
3. Tambahkan `?sslmode=no-verify` di akhir URL untuk dipakai **server** (driver `pg` menganggap `sslmode=require` sebagai verifikasi sertifikat penuh dan gagal di pooler Supabase; `no-verify` tetap terenkripsi).

## 2. Isi tabel & konten awal (sekali, dari laptop)

Tabel dibuat otomatis saat server start, tetapi konten bawaan app (360 quote, 49 artikel, doa, 14 korda, 33 item riyadhoh, program, infaq, sosial) diisi lewat seed. Jalankan dari laptop:

```bash
cd idtc-backend
npm ci
export DATABASE_URL='postgresql://postgres.<project-ref>:PASSWORD_DB@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=no-verify'
export ADMIN_EMAIL='admin@domainanda.com'
export ADMIN_PASSWORD='PasswordKuatMinimal12Karakter'
npm run db:seed
```

Output yang benar: `Seed selesai: { quotes: 360, articles: 49, doas: 34, kordas: 14, riyadhoh_items: 33, programs: 8, … }`.

- Jangan tambahkan `-- --samples` di production (itu event & testimoni contoh).
- Seed aman diulang: konten yang sudah ada (termasuk yang sudah diedit admin) **tidak** ditimpa.
- `database.sql` **tidak** dipakai di Supabase (berisi `CREATE DATABASE` dan `\connect`). Cukup `npm run db:seed`, atau tempel isi `schema.sql` di **Supabase → SQL Editor** bila ingin membuat tabelnya manual.

## 3. Siapkan kode di GitHub

Hostinger men-deploy dari repo GitHub (atau ZIP). Pastikan `.env`, `node_modules/`, dan `uploads/` **tidak** ikut (sudah ada di `.gitignore`). `admin/admin.css` sudah ter-build dan ikut repo, jadi server tidak perlu Tailwind.

Setiap mengubah tampilan panel admin, jalankan `npm run build:css` lalu commit `admin/admin.css`.

## 4. Buat Node.js Web App di hPanel

1. **hPanel → Websites → Add website → Node.js Apps**.
2. **Import Git repository** → pilih repo `idtc-backend`, branch `main` (atau **Upload files** ZIP tanpa `node_modules/`, `.env`, `uploads/`).
3. Pengaturan build:

   | Pengaturan | Nilai |
   | --- | --- |
   | Framework preset | Express / Other |
   | Node.js version | 20.x atau 22.x |
   | Root directory | `/` |
   | Install command | `npm ci --omit=dev` |
   | Build command | *(kosong)* |
   | Entry file / Start command | `server.js` / `npm start` |

4. **Environment variables** (isi di hPanel, jangan upload `.env`):

   ```dotenv
   NODE_ENV=production
   DATABASE_URL=postgresql://postgres.<project-ref>:PASSWORD_DB@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=no-verify
   PG_POOL_MAX=5
   PUBLIC_BASE_URL=https://api.domainanda.com
   TRUST_PROXY=true
   ADMIN_EMAIL=admin@domainanda.com
   ADMIN_PASSWORD=PasswordKuatMinimal12Karakter
   ADMIN_NAME=Super Admin IDTC
   UPLOAD_DIR=/home/<user-hostinger>/idtc-uploads
   CORS_ORIGINS=
   GOOGLE_CLIENT_IDS=<web-client-id>.apps.googleusercontent.com,<android-client-id>.apps.googleusercontent.com,<ios-client-id>.apps.googleusercontent.com
   ```

   | Variabel | Keterangan |
   | --- | --- |
   | `PUBLIC_BASE_URL` | Wajib. Dipakai untuk URL foto yang dikirim ke app. Tanpa ini URL foto bisa mengikuti host internal proxy. |
   | `TRUST_PROXY=true` | Wajib di belakang proxy Hostinger: rate limit login memakai IP asli user dan cookie admin `Secure` berfungsi. |
   | `UPLOAD_DIR` | Path **absolut di luar folder aplikasi** agar foto tidak ikut terhapus saat deploy ulang. Lihat path home di **hPanel → File Manager** (biasanya `/home/u123456789/`). Bila Hostinger tidak mengizinkan menulis di luar folder app, kosongkan (default `./uploads`) dan andalkan backup (lihat Risiko). |
   | `PG_POOL_MAX=5` | Pooler Supabase paket gratis membatasi koneksi. |
   | `CORS_ORIGINS` | Kosongkan. App Android/iOS tidak memakai CORS; isi hanya bila ada versi web app di domain lain. |
   | `GOOGLE_CLIENT_IDS` | Client ID OAuth yang sama dengan `EXPO_PUBLIC_GOOGLE_*_CLIENT_ID` di app (pisahkan koma). Token Google untuk client ID lain ditolak. Kosong = tombol Google di app menampilkan "Login Google belum diaktifkan di server". |
   | `PORT` | Jangan diisi; Hostinger menyuntikkan port sendiri. |
   | `ADMIN_PASSWORD` | Hanya dipakai saat akun Super Admin **belum ada**. Mengubahnya kemudian **tidak** mengganti password (pakai langkah 8). |

5. **Deploy**, lalu buka **Logs** dan pastikan muncul:

   ```
   [startup] IDTC backend berjalan di 0.0.0.0:<port> (admin: /admin, API: /api/v1)
   [startup] PostgreSQL siap.
   ```

   Bila muncul `PostgreSQL gagal disiapkan: …`, periksa `DATABASE_URL` (Session pooler, port 5432, `sslmode=no-verify`, password ter-encode).

## 5. Domain & SSL

1. Pengaturan web app → **Domain** → hubungkan `api.domainanda.com`.
2. **hPanel → Security → SSL** → pasang SSL gratis dan aktifkan **Force HTTPS**. App Android rilis menolak HTTP biasa, jadi HTTPS wajib.

## 6. Arahkan app mobile ke server

Di project app `NASJAK`, set URL API production lalu build ulang:

```bash
# .env.production (atau env EAS build)
EXPO_PUBLIC_API_BASE_URL=https://api.domainanda.com/api/v1
```

Lalu build APK/AAB (mis. `eas build -p android`). Nilai `EXPO_PUBLIC_*` ditanam saat build, jadi mengubahnya butuh build ulang.

## 7. Uji sebelum go-live

```bash
curl -s https://api.domainanda.com/api/v1/config | head -c 200      # harus JSON {"data":{"app":…
curl -s https://api.domainanda.com/api/v1/kordas | head -c 200      # 14 korda dari seed
```

Lalu dari app/panel:
1. Login `https://api.domainanda.com/admin` dengan `ADMIN_EMAIL`.
2. Daftar akun baru dari app → upload avatar → pastikan foto tampil (URL diawali `https://api.domainanda.com/uploads/…`).
3. **Uji ketahanan upload:** klik **Redeploy** di hPanel → buka lagi profil tadi. Bila fotonya hilang, `UPLOAD_DIR` masih di dalam folder app: perbaiki langkah 4 atau pindah ke VPS.
4. Upgrade akun uji ke Sahabat dari panel admin → coba jual produk dengan foto → setujui dari panel → produk tampil di Lapak.

## 8. Lupa password Super Admin

Jalankan dari laptop terhadap database production (input password tersembunyi; minimal 12 karakter; semua sesi login akun itu dicabut):

```bash
DATABASE_URL='postgresql://…supabase.com:5432/postgres?sslmode=no-verify' \
ADMIN_EMAIL='admin@domainanda.com' npm run admin:reset-password
```

Untuk akun admin lain: `npm run admin:reset-password -- email@domain.com`. Anggota biasa direset dari panel admin (password sementara).

## Backup

- Database: backup harian dari dashboard Supabase, atau manual dari laptop:

  ```bash
  pg_dump "$DATABASE_URL" -Fc --no-owner -f idtc-$(date +%F).dump
  ```

- Foto upload: download folder `UPLOAD_DIR` via **File Manager** secara rutin.

## Risiko yang perlu diketahui

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Foto upload disimpan di disk aplikasi | Bisa hilang saat deploy ulang bila `UPLOAD_DIR` di dalam folder app | `UPLOAD_DIR` absolut di luar folder app + uji langkah 7.3 + backup rutin. Jangka panjang: VPS atau object storage |
| Database di provider lain | Tambahan latensi ±10–30 ms per query, kuota Supabase gratis terbatas | Region Singapore, `PG_POOL_MAX=5`, pantau kuota |
| Supabase gratis dijeda bila tidak aktif 7 hari | API & login mati | Pakai paket berbayar untuk production |
| Batas ukuran request proxy Hostinger | Upload > batas proxy gagal `413` | Backend membatasi gambar 5 MB; app sudah mengompres foto sebelum upload |
