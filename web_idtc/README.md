# Portal Anggota IDTC

## Menjalankan lokal

Persyaratan: Node.js 20 atau lebih baru dan PostgreSQL 14 atau lebih baru.

1. Pastikan server PostgreSQL berjalan.
2. Pasang dependensi dengan `npm install`.
3. Salin `.env.example` menjadi `.env`, lalu sesuaikan `DATABASE_URL` dengan akun PostgreSQL lokal. Jangan commit file `.env`.
4. Isi `ADMIN_EMAIL` dan `ADMIN_PASSWORD` untuk akun admin bootstrap. `SUPER_ADMIN_EMAIL` secara default menunjuk `dani.hd@idtc.org`; akun tersebut akan diaktifkan dan diberi role Super Admin saat ditemukan di database. Password dan profilnya tidak diubah.
5. Jalankan `npm run db:setup` untuk membuat database dan tabel IDTC.
6. Jalankan `npm start`, lalu buka `http://localhost:3000`.

Buka alamat dari server Node tersebut, bukan server file statis, agar form pendaftaran dapat mencapai API.

## Data anggota

Kata sandi disimpan sebagai hash bcrypt. Foto kartu anggota divalidasi sebagai JPG, PNG, atau WEBP maksimal 5 MB, lalu disimpan di `uploads/member-photos`; database hanya menyimpan path-nya. Pendaftar mendapat role `member` dengan status `pending`.

Data lengkap respons pendaftaran yang diimpor disimpan pada `member_applications.response_data` dan ditautkan ke akun dengan email valid. Akun yang dibuat dari formulir calon anggota berstatus `pending`. Respons dengan alamat email tidak valid tetap dipertahankan, tetapi tidak mendapat akun login.

Pendaftaran menggunakan `POST /api/auth/register` dan dibatasi delapan percobaan per 15 menit. Login anggota dan staf menggunakan `POST /api/auth/login`; hanya akun aktif yang dapat masuk. Akun anggota baru harus disetujui terlebih dahulu oleh admin. Sesi disimpan sebagai hash token di `user_sessions`, memakai cookie `HttpOnly`, dan dapat dipulihkan setelah halaman dimuat ulang. Centang **Ingat saya di perangkat ini** untuk mempertahankan sesi hingga 30 hari; tanpa centang, sesi berlaku 8 jam. Gunakan tombol **Keluar dari akun** untuk mencabut sesi.

Setelah masuk, pengguna diarahkan ke dashboard profil. Menu **Pengaturan profil** dapat mengubah nama, instansi/komunitas, mengunggah foto profil (JPG, PNG, atau WEBP maksimal 5 MB), atau menggunakan salah satu dari enam avatar karakter. Foto profil juga ditampilkan pada KTA. Tombol **Gunakan avatar** menghapus foto tersimpan dan menerapkan avatar yang dipilih. Email tidak dapat diubah dari halaman tersebut.

## Pilot Project

Menu **Pilot Project** menampilkan grup beserta admin/penggagas, Project Manager, anggota tim, dan profesi mereka. Anggota yang masuk dapat membagikan perkembangan berupa teks, tautan web, atau satu lampiran JPG, PNG, WEBP, maupun PDF maksimal 10 MB. Lampiran disimpan privat di `uploads/pilot-projects` dan hanya dapat dimuat melalui sesi portal. Feed mendukung like, komentar, serta berbagi tautan ke halaman project. Gift belum aktif karena integrasi inventaris Twini Game memerlukan API atau skema database dari sistem game.

Dashboard anggota aktif juga menampilkan pratinjau KTA dua sisi dan sertifikat keanggotaan. Dokumen diambil berdasarkan sesi akun yang sedang masuk; foto anggota dan QR verifikasi tidak dapat diminta untuk ID pengguna lain melalui portal. Gunakan tombol cetak pada dashboard untuk mencetak KTA dua sisi (masing-masing sisi pada halaman terpisah) atau sertifikat A4 lanskap. Tanggal pada sertifikat mengikuti tanggal pendaftaran anggota, dan sertifikat tetap perlu ditandatangani Ketua IDTC sebelum dibagikan. Akun aktif yang tidak memiliki role `member` tidak dapat melihat dokumen anggota.

## Login sosial

Login Google, Facebook, Instagram, dan Apple tersedia setelah kredensial aplikasi OAuth masing-masing diisi di `.env`; tombol tetap nonaktif untuk provider yang belum dikonfigurasi. Tetapkan `PUBLIC_BASE_URL` ke alamat publik portal, daftarkan URL callback persis berikut di konsol developer masing-masing, lalu mulai ulang server:

- Google: `${PUBLIC_BASE_URL}/auth/google/callback`
- Facebook: `${PUBLIC_BASE_URL}/auth/facebook/callback`
- Instagram: `${PUBLIC_BASE_URL}/auth/instagram/callback`
- Apple: `${PUBLIC_BASE_URL}/auth/apple/callback`

Buat kredensial OAuth pada [Google Cloud Console](https://console.cloud.google.com/apis/credentials), [Meta for Developers](https://developers.facebook.com/apps/), dan [Apple Developer](https://developer.apple.com/account/resources/identifiers/list). Untuk Instagram, aktifkan produk Instagram API dan Business Login pada aplikasi Meta. Isi `GOOGLE_CLIENT_ID` dan `GOOGLE_CLIENT_SECRET`; `FACEBOOK_APP_ID` dan `FACEBOOK_APP_SECRET`; `INSTAGRAM_APP_ID` dan `INSTAGRAM_APP_SECRET`; serta `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, dan `APPLE_PRIVATE_KEY`. `APPLE_CLIENT_ID` harus berupa Services ID untuk Sign in with Apple. Kunci privat Apple dapat disimpan pada satu baris dengan baris baru ditulis sebagai `\n`. Facebook memakai `FACEBOOK_GRAPH_VERSION` yang dapat diatur, dengan default `v26.0`.

Pengguna harus masuk ke akun IDTC yang sudah ada dengan email/password terlebih dahulu, lalu menautkan provider dari bagian **Login dengan akun sosial** di profil. Setelah ditautkan, tombol provider dapat digunakan untuk login ke akun tersebut. Login sosial tidak membuat akun IDTC baru dan tidak mengaktifkan akun pending/suspended. Instagram Login resmi Meta hanya mendukung akun profesional Business/Creator. Simpan semua client secret dan private key hanya di `.env`, jangan commit atau membagikannya.

## Panel admin dan role

Buka `http://localhost:3000/admin` dan masuk dengan akun aktif. Sesi menggunakan cookie `HttpOnly`, `SameSite=Strict`, dan token yang disimpan sebagai hash.

Role **Super Admin** dapat mengelola role semua akun dan konten portal. Role **Admin** dapat mengelola anggota serta konten portal. Role **Membership** hanya dapat mengelola data anggota. Role internal `member` ditampilkan sebagai **Free Member** dan tidak mendapat akses panel admin. Perubahan role hanya tersedia bagi Super Admin, dan sistem menjaga agar selalu ada minimal satu Super Admin.

Area **Keanggotaan** dapat melihat/filter anggota, meninjau foto, menambah anggota manual, mengubah profil, menyetujui/menangguhkan, serta menghapus data anggota. Akun staf terpisah dari daftar anggota agar tidak terhapus lewat alur tersebut. **Content Management** mengubah teks halaman masuk/pendaftaran dan halaman utama; perubahan disimpan di `site_content` dan langsung dibaca portal.

Untuk mengonfigurasi token reset, jalankan `npm run admin:configure-reset-token`; token acak disimpan ke `.env` tanpa dicetak. Mulai ulang server agar aktif, lalu buka **Reset password Super Admin** di CMS dan masukkan token, password baru, serta konfirmasi. Endpoint membatasi percobaan, menyimpan password sebagai hash, serta mencabut sesi lama. Akun `SUPER_ADMIN_EMAIL` akan dibuat bila belum ada.

Alternatifnya, dengan `DATABASE_URL` terkonfigurasi dan PostgreSQL aktif, jalankan `npm run admin:reset-password` untuk memasukkan password langsung di terminal secara tersembunyi.

Anggota ber-role `member` dengan status `active` memiliki aksi **Buat KTA**. Sisi depan memakai `assets/img/Id_f_01.png` dengan foto, nama, instansi, dan nomor anggota; sisi belakang memakai `assets/img/id_b_02.png` dengan nomor anggota dan QR verifikasi. Pilih Depan/Belakang untuk pratinjau, atau **Cetak dua sisi** untuk mencetak kedua template pada halaman portrait terpisah. Aktifkan opsi cetak latar belakang agar desain ikut tercetak.

KTA menyertakan QR berlogo IDTC di tengahnya untuk membuka `/verify/<id>` pada `PUBLIC_BASE_URL`. QR dirender dengan level koreksi kesalahan **H** agar tetap terbaca setelah dicetak kecil di kartu, dan logo IDTC menutupi sebagian kecil modul QR yang masih tertutup koreksi. Setiap QR yang diminta direkam ke tabel `kta_qr_codes` (satu baris per anggota berisi payload URL verifikasi, `issued_at`, dan `updated_at`); tabel dibuat otomatis saat server start dan juga tersedia di `database.sql` (`npm run db:setup`). Halaman verifikasi hanya menampilkan nama, nomor anggota, instansi, status, dan tanggal terdaftar; email serta password tidak pernah disertakan. Atur `PUBLIC_BASE_URL` ke domain publik sebelum mencetak kartu untuk penggunaan produksi.

QR KTA dapat diunduh sebagai PNG (1024 px, filename `QR-KTA-IDTC-<nomor>.png`) lewat tombol **Unduh QR** — di panel admin (`GET /api/admin/users/<id>/qr/download`) dan di dashboard anggota (`GET /api/auth/kta-qr/download`).

Konfirmasi setelah persetujuan menampilkan pintasan cetak KTA dan sertifikat. Sertifikat dicetak pada A4 lanskap dengan ruang tanda tangan kosong untuk ditandatangani langsung oleh Ketua IDTC sebelum dibagikan.

Anggota hasil impor dengan `users.must_change_password = true` akan melihat dialog wajib ganti kata sandi saat login atau pemulihan sesi. Kata sandi baru minimal 12 karakter dan harus dikonfirmasi; setelah berhasil anggota langsung masuk ke profil. Rute perubahan kata sandi mempertahankan sesi saat ini dan mencabut sesi lainnya. Admin dapat mengatur flag kewajiban ini melalui kolom `users.must_change_password`; mengganti kata sandi lewat CMS tidak dengan sendirinya mengubah flag tersebut.
