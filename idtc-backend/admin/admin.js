// Panel admin IDTC — Alpine.js. Semua data lewat /api/v1 dengan sesi cookie HttpOnly.
const API = '/api/v1';

const STATUS_BADGES = {
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-rose-100 text-rose-700',
  draft: 'bg-slate-100 text-slate-600',
  published: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-rose-100 text-rose-700',
  registered: 'bg-sky-100 text-sky-700',
  confirmed: 'bg-emerald-100 text-emerald-700',
  active: 'bg-emerald-100 text-emerald-700',
  suspended: 'bg-rose-100 text-rose-700',
  open: 'bg-sky-100 text-sky-700',
  closed: 'bg-slate-100 text-slate-600',
  free: 'bg-slate-100 text-slate-600',
  membership: 'bg-teal-100 text-teal-700',
  sahabat: 'bg-amber-100 text-amber-800',
  super_admin: 'bg-violet-100 text-violet-700',
  admin: 'bg-indigo-100 text-indigo-700',
  praktisi: 'bg-emerald-100 text-emerald-700',
  calon_sahabat: 'bg-slate-100 text-slate-600'
};

const STATUS_LABELS = {
  pending: 'Menunggu', approved: 'Disetujui', rejected: 'Ditolak', draft: 'Draft', published: 'Terbit', cancelled: 'Dibatalkan',
  registered: 'Terdaftar', confirmed: 'Dikonfirmasi', active: 'Aktif', suspended: 'Nonaktif', open: 'Terbuka', closed: 'Ditutup'
};

const ROLE_LABELS = {
  super_admin: 'Super Admin', admin: 'Admin', praktisi: 'Praktisi', sahabat: 'Sahabat', calon_sahabat: 'Calon Sahabat'
};

const SITE_CONTENT_LABELS = {
  app_name: 'Nama aplikasi', app_tagline: 'Tagline', latest_version: 'Versi terbaru', min_supported_version: 'Versi minimum',
  store_url_android: 'URL Play Store', store_url_ios: 'URL App Store', release_date: 'Tanggal rilis', author: 'Pembuat',
  organization: 'Organisasi', website: 'Website', contact_whatsapp: 'WhatsApp kontak', contact_email: 'Email kontak',
  contact_instagram: 'Instagram', about_features: 'Daftar fitur (satu fitur per baris)'
};

// Label kolom/field Konten CMS dalam bahasa tim operasional (nama field API tetap camelCase).
const FIELD_LABELS = {
  arabic: 'Teks Arab', author: 'Penulis/Sumber', bankAccount: 'No. rekening', bankHolder: 'Atas nama', bankName: 'Bank',
  body: 'Isi', category: 'Kategori', categoryId: 'Kategori', color: 'Warna', content: 'Konten', coverImage: 'Gambar sampul',
  cta: 'Teks tombol', data: 'Data (JSON)', debt: 'Utang terkait', deepLink: 'Tautan di app', description: 'Deskripsi',
  gradient: 'Gradasi warna', group: 'Grup', handle: 'Akun/handle', icon: 'Ikon', isActive: 'Aktif', ketua: 'Ketua',
  label: 'Nama', latin: 'Latin', meaning: 'Arti', name: 'Nama', phone: 'No. HP', platform: 'Platform',
  publishedAt: 'Tanggal terbit', qrisImage: 'Gambar QRIS', quoteTags: 'Tag quote', rakaat: 'Rakaat', readTime: 'Waktu baca',
  region: 'Wilayah', relatedEventType: 'Tipe event terkait', section: 'Bagian', shortLabel: 'Nama singkat',
  sortOrder: 'Urutan', source: 'Sumber', status: 'Status', subtitle: 'Subjudul', summary: 'Ringkasan', text: 'Teks',
  thumbnail: 'Gambar kecil', title: 'Judul', type: 'Tipe', url: 'URL', whatsappConfirm: 'WhatsApp konfirmasi',
  person: 'Tokoh', question: 'Pertanyaan', choices: 'Pilihan jawaban (pisahkan koma)', answer: 'Jawaban benar',
  explanation: 'Penjelasan', coverTitle: 'Judul sampul', coverCaption: 'Keterangan sampul', meta: 'Info singkat',
  schedule: 'Jadwal', reminderKey: 'Pengingat yang diaktifkan'
};

// Label tampilan untuk nilai enum yang berupa kunci teknis (nilai yang disimpan tetap kuncinya).
const ENUM_LABELS = {
  tahajudCallEnabled: 'Pengingat Tahajud', dhuhaReminderEnabled: 'Pengingat Dhuha', taubatReminderEnabled: 'Pengingat Taubat'
};

const PURPOSE_LABELS = { avatar: 'Foto profil', product: 'Foto produk', testimonial: 'Foto testimoni', event: 'Banner event', content: 'Gambar konten' };

// Instance Chart.js disimpan di luar state Alpine: proxy reaktif Alpine merusak objek internal Chart.js.
const charts = {};

function renderChart(id, config) {
  const canvas = document.getElementById(id);
  if (!canvas || !window.Chart) return;
  charts[id]?.destroy();
  charts[id] = new window.Chart(canvas, config);
}

document.addEventListener('alpine:init', () => {
  window.Alpine.data('admin', () => ({
    ready: false,
    user: null,
    login: { identifier: '', password: '', error: '', loading: false },
    tab: 'dashboard',
    toasts: [],
    dialog: null,
    references: { eventTypes: [], lapakCategories: [], kordas: [] },
    statusBadges: STATUS_BADGES,
    statusLabels: STATUS_LABELS,
    roleLabels: ROLE_LABELS,

    dashboard: null,
    trends: null,
    trendDays: 30,
    health: null,
    healthLoading: false,
    purposeLabels: PURPOSE_LABELS,
    users: { items: [], meta: null, q: '', membershipType: '', status: '', page: 1, loading: false },
    userModal: null,
    newUser: null,
    lapak: { items: [], meta: null, status: 'pending', q: '', page: 1 },
    events: { items: [], meta: null, status: '', q: '' },
    eventForm: null,
    registrations: { items: [], meta: null, eventId: '', status: '', q: '' },
    eventOptions: [],
    testimonials: { items: [], meta: null, status: 'pending' },
    questions: { items: [], meta: null, answered: '' },
    questionModal: null,
    content: { resources: [], key: 'quotes', items: [], meta: null, q: '', page: 1 },
    contentForm: null,
    plans: [],
    broadcast: { title: '', body: '', type: 'info', membershipTypes: [], route: '', history: [] },
    siteConfig: null,
    siteContentLabels: SITE_CONTENT_LABELS,
    audit: { items: [], meta: null, page: 1 },

    get isSuper() {
      return this.user?.roles?.includes('super_admin');
    },

    get navItems() {
      return [
        { id: 'dashboard', label: 'Dashboard', icon: '🏠' },
        { id: 'users', label: 'Anggota', icon: '👥' },
        { id: 'lapak', label: 'Lapak', icon: '🛍️', badge: this.dashboard?.lapak?.pending },
        { id: 'events', label: 'Event', icon: '📅' },
        { id: 'registrations', label: 'Registrasi', icon: '📝', badge: this.dashboard?.registrations?.pending },
        { id: 'testimonials', label: 'Testimoni', icon: '💬', badge: this.dashboard?.testimonials?.pending },
        { id: 'questions', label: 'Tanya Praktisi', icon: '❓', badge: this.dashboard?.questions?.unanswered },
        { id: 'content', label: 'Konten CMS', icon: '📚' },
        { id: 'membership', label: 'Membership', icon: '🎖️' },
        { id: 'broadcast', label: 'Broadcast', icon: '📣' },
        { id: 'settings', label: 'Pengaturan App', icon: '⚙️' },
        { id: 'system', label: 'Kesehatan Sistem', icon: '🩺', badge: this.health && this.health.status !== 'ok' ? '!' : undefined },
        ...(this.isSuper ? [{ id: 'audit', label: 'Audit Log', icon: '🧾' }] : [])
      ];
    },

    get currentResource() {
      return this.content.resources.find((resource) => resource.key === this.content.key);
    },

    async init() {
      try {
        const me = await this.api('GET', '/auth/me', undefined, { silent: true });
        if (me.roles.some((role) => ['admin', 'super_admin'].includes(role))) {
          this.user = me;
          await this.bootstrap();
        }
      } catch {
        this.user = null;
      }
      this.ready = true;
      window.addEventListener('hashchange', () => {
        const target = window.location.hash.replace('#', '');
        if (this.user && target && target !== this.tab && this.navItems.some((item) => item.id === target)) this.go(target);
      });
    },

    async bootstrap() {
      const [references, resources] = await Promise.all([this.api('GET', '/references'), this.api('GET', '/admin/content')]);
      this.references = references;
      this.content.resources = resources;
      const initial = window.location.hash.replace('#', '');
      await this.go(this.navItems.some((item) => item.id === initial) ? initial : 'dashboard');
      this.loadDashboard();
    },

    async api(method, path, body, { silent = false, raw = false } = {}) {
      const init = { method, credentials: 'same-origin', headers: {} };
      if (body instanceof FormData) {
        init.body = body;
      } else if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await fetch(`${API}${path}`, init);
      if (response.status === 401 && this.user) {
        this.user = null;
        this.toast('Sesi berakhir, silakan login kembali.', 'error');
      }
      if (response.status === 204) return null;
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = payload.error || `Terjadi kesalahan (${response.status}).`;
        if (!silent) this.toast(message, 'error');
        const error = new Error(message);
        error.payload = payload;
        throw error;
      }
      return raw ? payload : payload.data;
    },

    // Dialog modal dalam halaman. Mengembalikan true/false (konfirmasi) atau teks/null (input).
    ask({ title, message = '', confirmText = 'Ya', cancelText = 'Batal', danger = false, input = false, value = '', placeholder = '', readonly = false }) {
      this.dialog?.resolve(this.dialog.input ? null : false);
      return new Promise((resolve) => {
        this.dialog = { title, message, confirmText, cancelText, danger, input, value, placeholder, readonly, resolve };
      });
    },

    closeDialog(confirmed) {
      const dialog = this.dialog;
      if (!dialog) return;
      this.dialog = null;
      if (dialog.input) dialog.resolve(confirmed ? dialog.value : null);
      else dialog.resolve(Boolean(confirmed));
    },

    toast(message, type = 'success') {
      const id = Date.now() + Math.random();
      this.toasts.push({ id, message, type });
      setTimeout(() => {
        this.toasts = this.toasts.filter((toast) => toast.id !== id);
      }, 4000);
    },

    async doLogin() {
      this.login.loading = true;
      this.login.error = '';
      try {
        const data = await this.api('POST', '/admin/session', {
          identifier: this.login.identifier, password: this.login.password
        }, { silent: true });
        this.user = data.user;
        this.login.password = '';
        await this.bootstrap();
      } catch (error) {
        this.login.error = error.message;
      } finally {
        this.login.loading = false;
      }
    },

    async logout() {
      await fetch(`${API}/admin/session`, { method: 'DELETE', credentials: 'same-origin' });
      this.user = null;
    },

    async go(tab) {
      this.tab = tab;
      window.location.hash = tab;
      const loaders = {
        dashboard: () => Promise.all([this.loadDashboard(), this.loadTrends()]),
        system: () => this.loadHealth(),
        users: () => this.loadUsers(),
        lapak: () => this.loadLapak(),
        events: () => this.loadEvents(),
        registrations: () => this.loadRegistrations(),
        testimonials: () => this.loadTestimonials(),
        questions: () => this.loadQuestions(),
        content: () => this.loadContent(),
        membership: () => this.loadPlans(),
        broadcast: () => this.loadBroadcasts(),
        settings: () => this.loadSettings(),
        audit: () => this.loadAudit()
      };
      await loaders[tab]?.();
    },

    query(params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== '' && value !== null && value !== undefined) search.set(key, value);
      }
      const text = search.toString();
      return text ? `?${text}` : '';
    },

    formatDate(value, withTime = false) {
      if (!value) return '-';
      const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
      return date.toLocaleDateString('id-ID', {
        day: 'numeric', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {})
      });
    },

    rupiah(value) {
      return `Rp ${Number(value || 0).toLocaleString('id-ID')}`;
    },

    // ---------------- Dashboard ----------------
    async loadDashboard() {
      this.dashboard = await this.api('GET', '/admin/dashboard');
    },

    async loadTrends(days = this.trendDays) {
      this.trendDays = days;
      this.trends = await this.api('GET', `/admin/stats/trends?days=${days}`);
      // Tunggu section tampil agar ukuran canvas benar.
      this.$nextTick(() => this.drawTrendCharts());
    },

    drawTrendCharts() {
      if (!this.trends) return;
      const series = this.trends.series;
      const labels = series.map((item) => new Date(`${item.date}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }));
      const base = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { ticks: { maxTicksLimit: 10 } } },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } }
      };
      const line = (label, key, color) => ({
        label, data: series.map((item) => item[key]), borderColor: color, backgroundColor: `${color}22`, fill: true, tension: 0.3, pointRadius: 2
      });
      renderChart('chart-users', {
        type: 'line',
        data: { labels, datasets: [line('Anggota aktif', 'activeUsers', '#0f766e'), line('Anggota baru', 'newUsers', '#d97706')] },
        options: base
      });
      renderChart('chart-riyadhoh', {
        type: 'line',
        data: { labels, datasets: [line('Anggota mengisi riyadhoh', 'riyadhohUsers', '#7c3aed')] },
        options: base
      });
      const bar = (label, key, color) => ({ label, data: series.map((item) => item[key]), backgroundColor: color, borderRadius: 3 });
      renderChart('chart-activity', {
        type: 'bar',
        data: {
          labels,
          datasets: [
            bar('Registrasi event', 'registrations', '#0284c7'),
            bar('Produk lapak', 'products', '#d97706'),
            bar('Pertanyaan', 'questions', '#e11d48'),
            bar('Testimoni', 'testimonials', '#059669')
          ]
        },
        options: { ...base, scales: { x: { stacked: true, ticks: { maxTicksLimit: 15 } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } }
      });
    },

    percent(value, total) {
      if (!total) return '0%';
      return `${Math.round((value / total) * 100)}%`;
    },

    growthLabel(current, previous) {
      if (current === undefined) return '';
      if (!previous) return current ? 'Naik dari 0 di periode sebelumnya' : 'Sama dengan periode sebelumnya';
      const change = Math.round(((current - previous) / previous) * 100);
      if (change === 0) return 'Sama dengan periode sebelumnya';
      return `${change > 0 ? '▲' : '▼'} ${Math.abs(change)}% dibanding ${previous} periode sebelumnya`;
    },

    growthClass(current, previous) {
      if (current === previous || current === undefined) return 'text-slate-500';
      return current > (previous || 0) ? 'text-emerald-600' : 'text-rose-600';
    },

    barWidth(value, list) {
      const max = Math.max(1, ...list.map((item) => item.total));
      return Math.max(2, Math.round((value / max) * 100));
    },

    // ---------------- Kesehatan sistem ----------------
    async loadHealth() {
      this.healthLoading = true;
      try {
        this.health = await this.api('GET', '/admin/system/health');
      } finally {
        this.healthLoading = false;
      }
    },

    get healthWarnings() {
      const health = this.health;
      if (!health) return [];
      const warnings = [];
      const production = health.server.env.nodeEnv === 'production';
      if (!health.database.ok) warnings.push('Database tidak dapat dihubungi. Periksa DATABASE_URL dan status Supabase.');
      if (health.database.ok && health.database.latencyMs > 300) warnings.push(`Database lambat (${health.database.latencyMs} ms). Periksa region/koneksi database.`);
      if (health.database.ok && health.database.pool.waiting > 0) warnings.push('Ada query yang mengantre koneksi database. Pertimbangkan menaikkan PG_POOL_MAX atau paket database.');
      if (production && !health.server.env.publicBaseUrl) warnings.push('PUBLIC_BASE_URL belum diatur; URL foto bisa salah di app.');
      if (production && !health.server.env.trustProxy) warnings.push('TRUST_PROXY belum true; rate limit login memakai IP proxy, bukan IP user.');
      if (health.storage.disk && health.storage.disk.freeBytes < 1024 ** 3) warnings.push('Sisa disk di bawah 1 GB. Bersihkan atau tambah kapasitas penyimpanan upload.');
      if (health.requests.serverErrors > 0) warnings.push(`${health.requests.serverErrors} error server (5xx) sejak start. Lihat daftar error di bawah.`);
      return warnings;
    },

    bytes(value) {
      const number = Number(value || 0);
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let index = 0;
      let size = number;
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }
      return `${size.toLocaleString('id-ID', { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`;
    },

    duration(seconds) {
      const total = Number(seconds || 0);
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      if (days) return `${days} hari ${hours} jam`;
      if (hours) return `${hours} jam ${minutes} menit`;
      return `${minutes} menit`;
    },

    // ---------------- Users ----------------
    async loadUsers(page = this.users.page) {
      this.users.loading = true;
      this.users.page = page;
      try {
        const payload = await this.api('GET', `/admin/users${this.query({
          q: this.users.q, membershipType: this.users.membershipType, status: this.users.status, page, perPage: 25
        })}`, undefined, { raw: true });
        this.users.items = payload.data;
        this.users.meta = payload.meta;
      } finally {
        this.users.loading = false;
      }
    },

    replaceUser(updated) {
      this.users.items = this.users.items.map((item) => (item.id === updated.id ? updated : item));
      if (this.userModal?.id === updated.id) this.userModal = updated;
    },

    async setRole(user, role) {
      if (role === user.role) return;
      this.replaceUser(await this.api('PATCH', `/admin/users/${user.id}/role`, { role }));
      this.toast(`Role ${user.name} diubah menjadi ${ROLE_LABELS[role]}.`);
    },

    async setMembership(user, membershipType) {
      if (membershipType === user.membershipType) return;
      this.replaceUser(await this.api('PATCH', `/admin/users/${user.id}/membership`, { membershipType }));
      this.toast(`Membership ${user.name} diubah.`);
    },

    async toggleActive(user) {
      if (user.isActive && !await this.ask({ title: 'Nonaktifkan akun?', message: `${user.name} tidak bisa login dan semua sesi login-nya dicabut.`, confirmText: 'Nonaktifkan', danger: true })) return;
      this.replaceUser(await this.api('PATCH', `/admin/users/${user.id}/status`, { isActive: !user.isActive }));
    },

    async setFeature(user, featureId, value) {
      this.replaceUser(await this.api('PATCH', `/admin/users/${user.id}/features`, { [featureId]: value }));
    },

    async resetPassword(user) {
      if (!await this.ask({ title: 'Reset password?', message: `Password sementara akan dibuat untuk ${user.name}, dan semua sesi login-nya dicabut.`, confirmText: 'Reset password' })) return;
      const data = await this.api('POST', `/admin/users/${user.id}/reset-password`);
      await this.ask({
        title: 'Password sementara', message: `Salin dan kirim ke ${user.name}. Password ini hanya ditampilkan sekali dan wajib diganti saat login.`,
        input: true, readonly: true, value: data.temporaryPassword, confirmText: 'Selesai', cancelText: ''
      });
    },

    async deleteUser(user) {
      if (!await this.ask({ title: 'Hapus akun permanen?', message: `${user.name} (${user.email}) beserta datanya akan dihapus dan tidak bisa dikembalikan.`, confirmText: 'Hapus', danger: true })) return;
      await this.api('DELETE', `/admin/users/${user.id}`);
      this.userModal = null;
      this.toast('Akun dihapus.');
      this.loadUsers();
    },

    openNewUser() {
      this.newUser = { name: '', email: '', phone: '', role: 'calon_sahabat', membershipType: 'free', result: null };
    },

    async createUser() {
      const { name, email, phone, role, membershipType } = this.newUser;
      const data = await this.api('POST', '/admin/users', { name, email, phone, role, membershipType });
      this.newUser.result = data.temporaryPassword;
      this.loadUsers(1);
    },

    async openUser(user) {
      if (!this.plans.length) await this.loadPlans();
      this.userModal = user;
    },

    planFeatures(type) {
      return this.plans.find((plan) => plan.type === type)?.features || [];
    },

    // ---------------- Lapak ----------------
    async loadLapak(page = 1) {
      const payload = await this.api('GET', `/admin/lapak/products${this.query({ status: this.lapak.status, q: this.lapak.q, page })}`, undefined, { raw: true });
      this.lapak.items = payload.data;
      this.lapak.meta = payload.meta;
    },

    async moderateProduct(product, action) {
      let body;
      if (action === 'reject') {
        const reason = await this.ask({ title: 'Tolak produk', message: `Alasan penolakan "${product.name}" (opsional, dikirim ke penjual).`, input: true, placeholder: 'mis. Foto kurang jelas', confirmText: 'Tolak', danger: true });
        if (reason === null) return;
        body = { reason };
      }
      await this.api('POST', `/admin/lapak/products/${product.id}/${action}`, body);
      this.toast(action === 'approve' ? 'Produk disetujui.' : 'Produk ditolak.');
      this.loadLapak();
      this.loadDashboard();
    },

    async deleteProduct(product) {
      if (!await this.ask({ title: 'Hapus produk?', message: `"${product.name}" akan dihapus permanen.`, confirmText: 'Hapus', danger: true })) return;
      await this.api('DELETE', `/admin/lapak/products/${product.id}`);
      this.toast('Produk dihapus.');
      this.loadLapak();
    },

    categoryLabel(code) {
      return this.references.lapakCategories.find((category) => category.id === code)?.label || code;
    },

    // ---------------- Events ----------------
    async loadEvents() {
      const payload = await this.api('GET', `/admin/events${this.query({ status: this.events.status, q: this.events.q, perPage: 100 })}`, undefined, { raw: true });
      this.events.items = payload.data;
      this.events.meta = payload.meta;
    },

    openEventForm(event = null) {
      this.eventForm = event
        ? { ...event, contactWhatsapp: event.contactWhatsapp || '', description: event.description || '' }
        : { id: null, title: '', type: this.references.eventTypes[0]?.id || 'TSN', date: '', time: '08:00', location: '', quota: 50, description: '', status: 'draft', contactWhatsapp: '', image: null };
    },

    async uploadTo(target, field, purpose, fileInput) {
      const file = fileInput.files?.[0];
      if (!file) return;
      const form = new FormData();
      form.append('file', file);
      form.append('purpose', purpose);
      const data = await this.api('POST', '/uploads', form);
      target[field] = data.url;
      fileInput.value = '';
      this.toast('Gambar diunggah.');
    },

    async saveEvent() {
      const form = this.eventForm;
      const body = {
        title: form.title, type: form.type, date: form.date, time: form.time, location: form.location,
        quota: Number(form.quota), description: form.description, status: form.status,
        contactWhatsapp: form.contactWhatsapp || null, image: form.image || null
      };
      if (form.id) await this.api('PUT', `/admin/events/${form.id}`, body);
      else await this.api('POST', '/admin/events', body);
      this.toast('Event disimpan.');
      this.eventForm = null;
      this.loadEvents();
    },

    async setEventStatus(event, status) {
      if (status === 'cancelled' && !await this.ask({ title: 'Batalkan event?', message: `"${event.title}" dibatalkan dan semua pendaftar diberi notifikasi.`, confirmText: 'Batalkan event', cancelText: 'Kembali', danger: true })) return;
      await this.api('PATCH', `/admin/events/${event.id}/status`, { status });
      this.toast('Status event diperbarui.');
      this.loadEvents();
    },

    async deleteEvent(event) {
      if (!await this.ask({ title: 'Hapus event?', message: `"${event.title}" akan dihapus permanen.`, confirmText: 'Hapus', danger: true })) return;
      await this.api('DELETE', `/admin/events/${event.id}`);
      this.toast('Event dihapus.');
      this.loadEvents();
    },

    viewRegistrations(event) {
      this.registrations.eventId = event.id;
      this.go('registrations');
    },

    // ---------------- Registrations ----------------
    async loadRegistrations() {
      if (!this.eventOptions.length) {
        this.eventOptions = await this.api('GET', '/admin/events?perPage=100');
      }
      const payload = await this.api('GET', `/admin/event-registrations${this.query({
        eventId: this.registrations.eventId, status: this.registrations.status, q: this.registrations.q, perPage: 200
      })}`, undefined, { raw: true });
      this.registrations.items = payload.data;
      this.registrations.meta = payload.meta;
    },

    exportUrl() {
      return `${API}/admin/event-registrations${this.query({ eventId: this.registrations.eventId, status: this.registrations.status, format: 'csv', perPage: 500 })}`;
    },

    async cancelRegistration(registration) {
      if (!await this.ask({ title: 'Batalkan pendaftaran?', message: `Pendaftaran ${registration.userName} di "${registration.event?.title || 'event ini'}" dibatalkan dan kuotanya dikembalikan.`, confirmText: 'Batalkan pendaftaran', cancelText: 'Kembali', danger: true })) return;
      await this.updateRegistration(registration, { status: 'cancelled' });
    },

    async updateRegistration(registration, patch) {
      const updated = await this.api('PATCH', `/admin/event-registrations/${registration.id}`, patch);
      this.registrations.items = this.registrations.items.map((item) => (item.id === updated.id ? { ...item, ...updated } : item));
      this.loadDashboard();
    },

    // ---------------- Testimonials ----------------
    async loadTestimonials() {
      const payload = await this.api('GET', `/admin/testimonials${this.query({ status: this.testimonials.status })}`, undefined, { raw: true });
      this.testimonials.items = payload.data;
      this.testimonials.meta = payload.meta;
    },

    async moderateTestimonial(item, action) {
      let body;
      if (action === 'reject') {
        const reason = await this.ask({ title: 'Tolak testimoni', message: 'Alasan penolakan (opsional, dikirim ke pengirim).', input: true, confirmText: 'Tolak', danger: true });
        if (reason === null) return;
        body = { reason };
      }
      await this.api('POST', `/admin/testimonials/${item.id}/${action}`, body);
      this.toast('Testimoni diperbarui.');
      this.loadTestimonials();
      this.loadDashboard();
    },

    async deleteTestimonial(item) {
      if (!await this.ask({ title: 'Hapus testimoni?', message: 'Testimoni ini akan dihapus permanen.', confirmText: 'Hapus', danger: true })) return;
      await this.api('DELETE', `/admin/testimonials/${item.id}`);
      this.loadTestimonials();
    },

    // ---------------- Questions ----------------
    async loadQuestions() {
      const payload = await this.api('GET', `/admin/questions${this.query({ answered: this.questions.answered })}`, undefined, { raw: true });
      this.questions.items = payload.data;
      this.questions.meta = payload.meta;
    },

    async openQuestion(question) {
      const detail = await this.api('GET', `/questions/${question.id}`);
      this.questionModal = { ...detail, reply: '' };
    },

    async answerQuestion() {
      await this.api('POST', `/questions/${this.questionModal.id}/answers`, { body: this.questionModal.reply });
      this.toast('Jawaban terkirim.');
      await this.openQuestion(this.questionModal);
      this.loadQuestions();
      this.loadDashboard();
    },

    async deleteAnswer(answer) {
      if (!await this.ask({ title: 'Hapus jawaban?', message: 'Jawaban ini akan dihapus permanen.', confirmText: 'Hapus', danger: true })) return;
      await this.api('DELETE', `/admin/answers/${answer.id}`);
      await this.openQuestion(this.questionModal);
      this.loadQuestions();
      this.loadDashboard();
    },

    async setQuestionStatus(question, status) {
      await this.api('PATCH', `/admin/questions/${question.id}`, { status });
      this.loadQuestions();
    },

    async deleteQuestion(question) {
      if (!await this.ask({ title: 'Hapus pertanyaan?', message: `"${question.title}" beserta semua jawabannya akan dihapus permanen.`, confirmText: 'Hapus', danger: true })) return;
      await this.api('DELETE', `/admin/questions/${question.id}`);
      this.questionModal = null;
      this.loadQuestions();
    },

    // ---------------- Content CMS ----------------
    async loadContent(page = 1) {
      this.content.page = page;
      const payload = await this.api('GET', `/admin/content/${this.content.key}${this.query({ q: this.content.q, page, perPage: 50 })}`, undefined, { raw: true });
      this.content.items = payload.data;
      this.content.meta = payload.meta;
    },

    // Nama yang dikenali operator: judul/nama/label/teks pertama, jatuh ke kode.
    contentItemName(item) {
      const value = ['title', 'label', 'name', 'question', 'text'].map((key) => item[key]).find(Boolean) || item.id;
      const text = String(value);
      return text.length > 80 ? `${text.slice(0, 80)}…` : text;
    },

    kordaLabel(id) {
      return this.references.kordas?.find((korda) => korda.id === id)?.label || id;
    },

    isLinkField(field) {
      return /url|link/i.test(field.name);
    },

    enumLabel(value) {
      return ENUM_LABELS[value] || value;
    },

    fieldLabel(name) {
      return FIELD_LABELS[name] || name.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase());
    },

    // ID UUID tidak bermakna bagi operator; slug/kode tetap ditampilkan.
    get showContentId() {
      return this.currentResource && this.currentResource.pkType !== 'uuid';
    },

    previewFields() {
      const fields = this.currentResource?.fields || [];
      return fields.filter((field) => ['string', 'int', 'bool'].includes(field.type) && (field.max || 0) <= 1000).slice(0, 4);
    },

    displayValue(value) {
      if (value === null || value === undefined || value === '') return '—';
      if (typeof value === 'boolean') return value ? '✓' : '✗';
      const text = String(value);
      return text.length > 90 ? `${text.slice(0, 90)}…` : text;
    },

    openContentForm(item = null) {
      const resource = this.currentResource;
      const values = {};
      for (const field of resource.fields) {
        const value = item ? item[field.name] : undefined;
        if (field.type === 'array') values[field.name] = (value || []).join(', ');
        else if (field.type === 'json') values[field.name] = JSON.stringify(value || {}, null, 2);
        else if (field.type === 'bool') values[field.name] = item ? Boolean(value) : field.name === 'isActive';
        else if (field.type === 'timestamp') values[field.name] = value ? new Date(value).toISOString().slice(0, 16) : '';
        // Dropdown enum menampilkan opsi pertama walau nilainya kosong; isi nilainya agar yang tampil = yang terkirim.
        else if (field.enum?.length) values[field.name] = value ?? (field.required ? field.enum[0] : '');
        else values[field.name] = value ?? '';
      }
      this.contentForm = { id: item?.id ?? '', isNew: !item, values };
    },

    async saveContent() {
      const resource = this.currentResource;
      const body = {};
      for (const field of resource.fields) {
        let value = this.contentForm.values[field.name];
        if (field.type === 'int') value = value === '' ? null : Number(value);
        if (field.type === 'json') {
          try {
            value = JSON.parse(value || '{}');
          } catch {
            this.toast(`${field.name} bukan JSON yang valid.`, 'error');
            return;
          }
        }
        if (field.type === 'file' && !value) value = null;
        body[field.name] = value;
      }
      if (this.contentForm.isNew) {
        if (resource.pkType !== 'uuid') body.id = this.contentForm.id;
        await this.api('POST', `/admin/content/${resource.key}`, body);
      } else {
        await this.api('PUT', `/admin/content/${resource.key}/${encodeURIComponent(this.contentForm.id)}`, body);
      }
      this.toast('Konten disimpan.');
      this.contentForm = null;
      this.loadContent(this.content.page);
    },

    async deleteContent(item) {
      const name = this.contentItemName(item);
      if (!await this.ask({ title: `Hapus ${this.currentResource?.label || 'konten'}?`, message: `"${name}" akan dihapus permanen dari aplikasi.`, confirmText: 'Hapus', danger: true })) return;
      await this.api('DELETE', `/admin/content/${this.content.key}/${encodeURIComponent(item.id)}`);
      this.toast('Konten dihapus.');
      this.loadContent(this.content.page);
    },

    // ---------------- Membership ----------------
    async loadPlans() {
      this.plans = await this.api('GET', '/admin/membership-plans');
    },

    async savePlan(plan) {
      await this.api('PUT', `/admin/membership-plans/${plan.type}`, {
        label: plan.label,
        description: plan.description,
        color: plan.color,
        features: plan.features.map((feature) => ({ id: feature.id, enabled: feature.enabled }))
      });
      this.toast(`Plan ${plan.label} disimpan.`);
    },

    // ---------------- Broadcast ----------------
    async loadBroadcasts() {
      this.broadcast.history = await this.api('GET', '/admin/notifications/broadcasts');
    },

    async sendBroadcast() {
      const target = this.broadcast.membershipTypes.length
        ? { membershipTypes: this.broadcast.membershipTypes } : { all: true };
      if (!await this.ask({ title: 'Kirim notifikasi?', message: `"${this.broadcast.title}" akan dikirim ke ${target.all ? 'semua anggota' : this.broadcast.membershipTypes.join(', ')}. Notifikasi yang terkirim tidak bisa ditarik.`, confirmText: 'Kirim' })) return;
      const data = await this.api('POST', '/admin/notifications/broadcast', {
        title: this.broadcast.title,
        body: this.broadcast.body,
        type: this.broadcast.type,
        target,
        data: this.broadcast.route ? { route: this.broadcast.route } : {}
      });
      this.toast(`Notifikasi terkirim ke ${data.recipients} anggota.`);
      Object.assign(this.broadcast, { title: '', body: '', route: '' });
      this.loadBroadcasts();
    },

    // ---------------- Settings ----------------
    // about_features disimpan sebagai JSON array; di form ditampilkan satu fitur per baris.
    featuresToLines(config) {
      try {
        const list = JSON.parse(config.about_features || '[]');
        if (Array.isArray(list)) return { ...config, about_features: list.join('\n') };
      } catch {
        // Bukan JSON: tampilkan apa adanya.
      }
      return config;
    },

    async loadSettings() {
      this.siteConfig = this.featuresToLines(await this.api('GET', '/admin/app-config'));
    },

    async saveSettings() {
      const lines = String(this.siteConfig.about_features || '').split('\n').map((line) => line.trim()).filter(Boolean);
      const saved = await this.api('PUT', '/admin/app-config', { ...this.siteConfig, about_features: JSON.stringify(lines) });
      this.siteConfig = this.featuresToLines(saved);
      this.toast('Pengaturan aplikasi disimpan.');
    },

    // ---------------- Audit ----------------
    async loadAudit(page = 1) {
      const payload = await this.api('GET', `/admin/audit-logs${this.query({ page })}`, undefined, { raw: true });
      this.audit.items = payload.data;
      this.audit.meta = payload.meta;
      this.audit.page = page;
    }
  }));
});
