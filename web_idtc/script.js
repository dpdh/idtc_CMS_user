const loginForm = document.querySelector('#login-form');
const emailInput = document.querySelector('#email');
const passwordInput = document.querySelector('#password');
const emailError = document.querySelector('#email-error');
const passwordError = document.querySelector('#password-error');
const fullNameInput = document.querySelector('#full-name');
const passwordConfirmInput = document.querySelector('#password-confirm');
const memberPhotoInput = document.querySelector('#member-photo');
const photoPreview = document.querySelector('#photo-preview');
const photoFile = document.querySelector('#photo-file');
const photoError = document.querySelector('#photo-error');
const formMessage = document.querySelector('.form-message');
const submitButton = loginForm.querySelector('.submit-button');
const authView = document.querySelector('#auth-view');
const accountView = document.querySelector('#account-view');
const accountMessage = document.querySelector('#account-message');
const profileForm = document.querySelector('#profile-form');
const profileMessage = document.querySelector('#profile-message');
const profileSaveButton = document.querySelector('#profile-save-button');
const profilePhotoInput = document.querySelector('#profile-photo-input');
const profilePhotoSaveButton = document.querySelector('#profile-photo-save');
const profilePhotoRemoveButton = document.querySelector('#profile-photo-remove');
const profilePhotoError = document.querySelector('#profile-photo-error');
const passwordChangeDialog = document.querySelector('#password-change-dialog');
const passwordChangeForm = document.querySelector('#password-change-form');
const passwordChangeMessage = document.querySelector('#password-change-message');
let currentMode = 'login';
let photoPreviewUrl = '';
let profilePhotoPreviewUrl = '';
const avatarCharacters = {
  explorer: '🧭',
  engineer: '🧑‍💻',
  scientist: '🧑‍🔬',
  creator: '🎨',
  pioneer: '🚀',
  visionary: '🦾'
};
const oauthProviderLabels = {
  google: 'Google',
  facebook: 'Facebook',
  instagram: 'Instagram',
  apple: 'Apple'
};

async function loadOAuthProviders() {
  try {
    const response = await fetch('/api/auth/providers');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Tidak dapat memuat pilihan login sosial.');
    for (const button of document.querySelectorAll('[data-provider]')) {
      const provider = button.dataset.provider;
      const configured = result.configured?.[provider] === true;
      const linked = result.linked?.includes(provider) === true;
      button.disabled = !configured || (button.hasAttribute('data-link-provider') && linked);
      button.title = !configured
        ? 'Login ini belum dikonfigurasi oleh pengelola IDTC.'
        : linked
          ? `Akun ${oauthProviderLabels[provider]} sudah ditautkan.`
          : '';
      if (button.hasAttribute('data-link-provider')) {
        button.classList.toggle('is-linked', linked);
        button.querySelector(':scope > span:last-child').textContent = linked
          ? `${oauthProviderLabels[provider]} · Tertaut`
          : `Tautkan ${oauthProviderLabels[provider]}`;
      }
    }
  } catch (error) {
    const note = accountView.hidden
      ? document.querySelector('.social-login .social-note')
      : document.querySelector('.account-social .social-note');
    note.textContent = error.message;
    for (const button of document.querySelectorAll('[data-provider]')) button.disabled = true;
  }
}

function handleOAuthResult() {
  const url = new URL(window.location.href);
  const success = url.searchParams.get('social_success');
  const error = url.searchParams.get('auth_error');
  if (!success && !error) return;

  const targetMessage = accountView.hidden ? formMessage : accountMessage;
  targetMessage.classList.remove('error');
  if (success === 'linked') {
    targetMessage.textContent = 'Akun sosial berhasil ditautkan. Anda dapat menggunakannya untuk masuk berikutnya.';
  } else if (success === 'login') {
    targetMessage.textContent = 'Berhasil masuk menggunakan akun sosial.';
  } else {
    const messages = {
      provider_not_configured: 'Login sosial ini belum dikonfigurasi oleh pengelola IDTC.',
      provider_configuration_error: 'Konfigurasi URL login sosial tidak valid. Hubungi pengelola IDTC.',
      login_required_to_link: 'Masuk dengan email dan kata sandi terlebih dahulu untuk menautkan akun sosial.',
      invalid_oauth_state: 'Permintaan login kedaluwarsa atau tidak valid. Silakan coba lagi.',
      provider_cancelled: 'Proses login dibatalkan.',
      provider_authorization_failed: 'Penyedia login tidak memberikan otorisasi.',
      provider_verification_failed: 'Identitas dari penyedia login tidak dapat diverifikasi. Coba lagi.',
      provider_unlinked: 'Akun sosial belum ditautkan. Masuk dengan email dan kata sandi, lalu tautkan dari profil akun.',
      provider_already_linked: 'Akun sosial sudah ditautkan ke akun IDTC lain atau provider ini sudah memiliki tautan.',
      account_pending: 'Akun IDTC Anda masih menunggu persetujuan.',
      account_inactive: 'Akun IDTC tidak aktif. Hubungi administrator.'
    };
    targetMessage.textContent = messages[error] || 'Login sosial tidak berhasil. Silakan coba lagi.';
    targetMessage.classList.add('error');
  }

  url.searchParams.delete('social_success');
  url.searchParams.delete('auth_error');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function setAuthMode(mode) {
  currentMode = mode;
  document.querySelector('.login-heading').hidden = mode !== 'login';
  document.querySelector('.register-heading').hidden = mode !== 'register';
  document.querySelectorAll('.login-only').forEach((element) => { element.hidden = mode !== 'login'; });
  document.querySelectorAll('.register-only').forEach((element) => { element.hidden = mode !== 'register'; });
  submitButton.querySelector('span').textContent = mode === 'login' ? 'Masuk ke portal anggota' : 'Daftar sebagai anggota';
  formMessage.textContent = '';
  formMessage.classList.remove('error');
  document.querySelectorAll('.field-error').forEach((error) => { error.textContent = ''; });
}

function showAccount(user) {
  if (user.mustChangePassword) {
    authView.hidden = true;
    accountView.hidden = true;
    document.body.classList.remove('is-authenticated');
    if (!passwordChangeDialog.open) passwordChangeDialog.showModal();
    return;
  }
  if (passwordChangeDialog.open) passwordChangeDialog.close();
  pilotProjectIsAdmin = user.roleCodes.some((role) => ['super_admin', 'admin'].includes(role));
  const roleLabels = {
    super_admin: 'Super Admin',
    admin: 'Admin',
    membership: 'Membership',
    member: 'Anggota IDTC'
  };
  document.querySelector('#account-name').textContent = user.fullName;
  document.querySelector('#dashboard-greeting').textContent = user.fullName.split(/\s+/)[0];
  document.querySelector('#account-email').textContent = user.email;
  document.querySelector('#account-member-number').textContent = user.memberNumber || 'Belum tersedia';
  document.querySelector('#account-organization').textContent = user.organization || 'Belum diisi';
  document.querySelector('#account-roles').textContent = user.roleCodes.map((role) => roleLabels[role] || role).join(', ');
  document.querySelector('#profile-full-name').value = user.fullName;
  document.querySelector('#profile-email').value = user.email;
  document.querySelector('#profile-organization').value = user.organization || '';
  document.querySelector('#profile-profession').value = user.profession || '';
  const avatarId = avatarCharacters[user.avatarId] ? user.avatarId : 'explorer';
  profileForm.elements.avatarId.value = avatarId;
  document.querySelector('[data-avatar-display] span').textContent = avatarCharacters[avatarId];
  document.querySelector('[data-avatar-display]').dataset.avatar = avatarId;
  document.querySelector('#profile-photo-avatar').textContent = avatarCharacters[avatarId];
  const profilePhoto = document.querySelector('#profile-avatar-photo');
  const photoPreview = document.querySelector('#profile-photo-preview');
  const photoUrl = user.hasPhoto ? `/api/auth/photo?v=${Date.now()}` : '';
  profilePhoto.hidden = !photoUrl;
  photoPreview.hidden = !photoUrl;
  document.querySelector('[data-avatar-display] span').hidden = Boolean(photoUrl);
  document.querySelector('#profile-photo-avatar').hidden = Boolean(photoUrl);
  if (photoUrl) {
    profilePhoto.src = photoUrl;
    photoPreview.src = photoUrl;
    profilePhoto.onerror = () => {
      profilePhoto.hidden = true;
      document.querySelector('[data-avatar-display] span').hidden = false;
    };
    photoPreview.onerror = () => {
      photoPreview.hidden = true;
      document.querySelector('#profile-photo-avatar').hidden = false;
    };
  } else {
    profilePhoto.removeAttribute('src');
    photoPreview.removeAttribute('src');
  }
  profilePhotoInput.value = '';
  profilePhotoSaveButton.disabled = true;
  profilePhotoRemoveButton.hidden = !user.hasPhoto;
  profilePhotoError.textContent = '';
  document.querySelector('#profile-photo-help').textContent = user.hasPhoto
    ? 'Foto anggota Anda digunakan pada profil dan KTA. Pilih foto lain untuk menggantinya.'
    : 'JPG, PNG, atau WEBP. Maksimal 5 MB.';
  document.querySelectorAll('.avatar-option').forEach((option) => {
    option.classList.toggle('is-selected', option.dataset.avatarOption === avatarId);
  });
  document.querySelectorAll('.member-detail').forEach((detail) => {
    detail.hidden = !user.roleCodes.includes('member');
  });
  authView.hidden = true;
  accountView.hidden = false;
  document.body.classList.add('is-authenticated');
  setDashboardTab('overview');
  loadOAuthProviders();
  loadMembershipDocuments();
}

passwordChangeDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
});

passwordChangeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = passwordChangeForm.elements.password.value;
  const passwordConfirmation = passwordChangeForm.elements.passwordConfirmation.value;
  const passwordError = document.querySelector('#new-password-error');
  const confirmationError = document.querySelector('#new-password-confirmation-error');
  passwordError.textContent = '';
  confirmationError.textContent = '';
  passwordChangeMessage.textContent = '';
  if (password.length < 12 || new TextEncoder().encode(password).length > 72) {
    passwordError.textContent = 'Kata sandi harus minimal 12 karakter dan maksimal 72 byte.';
    return;
  }
  if (password !== passwordConfirmation) {
    confirmationError.textContent = 'Konfirmasi kata sandi belum sama.';
    return;
  }

  const button = document.querySelector('#password-change-submit');
  button.disabled = true;
  button.textContent = 'Menyimpan...';
  try {
    const response = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, passwordConfirmation })
    });
    const result = await response.json();
    if (!response.ok) {
      if (result.field === 'password') passwordError.textContent = result.error;
      else if (result.field === 'passwordConfirmation') confirmationError.textContent = result.error;
      else if (result.mustChangePassword) passwordChangeMessage.textContent = result.error;
      else throw new Error(result.error || 'Kata sandi tidak dapat diperbarui.');
      return;
    }
    passwordChangeForm.reset();
    passwordChangeDialog.close();
    showAccount(result.user);
    accountMessage.textContent = result.message;
  } catch (error) {
    passwordChangeMessage.textContent = error.message || 'Tidak dapat terhubung untuk mengganti kata sandi.';
  } finally {
    button.disabled = false;
    button.textContent = 'Simpan kata sandi dan lanjutkan';
  }
});

profilePhotoInput.addEventListener('change', () => {
  profilePhotoError.textContent = '';
  const [file] = profilePhotoInput.files;
  if (!file) {
    profilePhotoSaveButton.disabled = true;
    return;
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    profilePhotoError.textContent = 'Pilih foto dalam format JPG, PNG, atau WEBP.';
    profilePhotoInput.value = '';
    profilePhotoSaveButton.disabled = true;
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    profilePhotoError.textContent = 'Ukuran foto maksimal 5 MB.';
    profilePhotoInput.value = '';
    profilePhotoSaveButton.disabled = true;
    return;
  }
  if (profilePhotoPreviewUrl) URL.revokeObjectURL(profilePhotoPreviewUrl);
  profilePhotoPreviewUrl = URL.createObjectURL(file);
  const preview = document.querySelector('#profile-photo-preview');
  preview.src = profilePhotoPreviewUrl;
  preview.hidden = false;
  document.querySelector('#profile-photo-avatar').hidden = true;
  profilePhotoSaveButton.disabled = false;
});

profilePhotoSaveButton.addEventListener('click', async () => {
  const [file] = profilePhotoInput.files;
  if (!file) return;
  profilePhotoSaveButton.disabled = true;
  profilePhotoRemoveButton.disabled = true;
  profilePhotoError.textContent = '';
  const payload = new FormData();
  payload.set('memberPhoto', file);
  try {
    const response = await fetch('/api/auth/profile/photo', { method: 'POST', body: payload });
    const result = await response.json();
    if (!response.ok) {
      profilePhotoError.textContent = result.error || 'Foto profil tidak dapat disimpan.';
      return;
    }
    if (profilePhotoPreviewUrl) URL.revokeObjectURL(profilePhotoPreviewUrl);
    profilePhotoPreviewUrl = '';
    showAccount(result.user);
    profileMessage.textContent = result.message;
  } catch (error) {
    profilePhotoError.textContent = error.message || 'Tidak dapat terhubung untuk menyimpan foto profil.';
  } finally {
    profilePhotoSaveButton.disabled = !profilePhotoInput.files.length;
    profilePhotoRemoveButton.disabled = false;
  }
});

profilePhotoRemoveButton.addEventListener('click', async () => {
  profilePhotoRemoveButton.disabled = true;
  profilePhotoSaveButton.disabled = true;
  profilePhotoError.textContent = '';
  try {
    const response = await fetch('/api/auth/profile/photo', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatarId: profileForm.elements.avatarId.value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Foto profil tidak dapat dihapus.');
    if (profilePhotoPreviewUrl) URL.revokeObjectURL(profilePhotoPreviewUrl);
    profilePhotoPreviewUrl = '';
    showAccount(result.user);
    profileMessage.textContent = result.message;
  } catch (error) {
    profilePhotoError.textContent = error.message || 'Tidak dapat terhubung untuk menghapus foto profil.';
  } finally {
    profilePhotoRemoveButton.disabled = false;
  }
});

async function loadMembershipDocuments() {
  const content = document.querySelector('#dashboard-documents-content');
  const message = document.querySelector('#dashboard-documents-message');
  const printButtons = [
    document.querySelector('#dashboard-download-qr'),
    document.querySelector('#dashboard-print-kta'),
    document.querySelector('#dashboard-print-certificate')
  ];
  content.hidden = true;
  printButtons.forEach((button) => { button.disabled = true; });
  message.classList.remove('error');
  message.textContent = 'Memuat dokumen keanggotaan...';
  try {
    const response = await fetch('/api/auth/membership-documents');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Dokumen keanggotaan tidak dapat dimuat.');
    if (!result.eligible) {
      message.textContent = result.reason;
      return;
    }
    const { member } = result;
    const initials = member.fullName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    document.querySelector('#dashboard-member-initials').textContent = initials;
    document.querySelector('#dashboard-kta-name').textContent = member.fullName;
    document.querySelector('#dashboard-kta-organization').textContent = member.organization || 'Anggota IDTC';
    document.querySelector('#dashboard-kta-number').textContent = member.memberNumber;
    document.querySelector('#dashboard-kta-back-number').textContent = member.memberNumber;
    document.querySelector('#dashboard-kta-qr').src = result.qrDataUrl;
    document.querySelector('#dashboard-certificate-name').textContent = member.fullName;
    document.querySelector('#dashboard-certificate-number').textContent = member.memberNumber;
    document.querySelector('#dashboard-certificate-organization').textContent = member.organization || '';
    const memberSince = new Date(member.createdAt);
    document.querySelector('#dashboard-certificate-date').textContent = Number.isNaN(memberSince.valueOf())
      ? ''
      : `Terdaftar sejak ${new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }).format(memberSince)}`;
    const photo = document.querySelector('#dashboard-member-photo');
    photo.hidden = true;
    photo.onerror = () => {
      photo.hidden = true;
      document.querySelector('#dashboard-member-initials').hidden = false;
    };
    if (member.hasPhoto) {
      photo.hidden = false;
      document.querySelector('#dashboard-member-initials').hidden = true;
      photo.src = `/api/auth/photo?v=${Date.now()}`;
    } else {
      document.querySelector('#dashboard-member-initials').hidden = false;
      photo.removeAttribute('src');
    }
    content.hidden = false;
    message.textContent = 'KTA dan sertifikat berikut hanya dapat dilihat oleh akun anggota Anda.';
    printButtons.forEach((button) => { button.disabled = false; });
  } catch (error) {
    message.textContent = error.message || 'Tidak dapat terhubung untuk memuat dokumen anggota.';
    message.classList.add('error');
  }
}

function setDashboardTab(tab) {
  document.querySelectorAll('[data-dashboard-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.dashboardPanel !== tab;
  });
  document.querySelectorAll('.dashboard-nav-button').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.dashboardTab === tab);
  });
  if (tab === 'settings') {
    profileMessage.textContent = '';
    profileMessage.classList.remove('error');
  }
  if (tab === 'collaboration') loadCollaborationData();
  if (tab === 'collaboration') loadMemberGreetings();
  if (tab === 'pilot-projects') loadPilotProjectGroups();
}

const wordcloudStage = document.querySelector('#wordcloud-stage');
const wordcloudSvg = document.querySelector('#wordcloud-svg');
const wordcloudWords = document.querySelector('#wordcloud-words');
const wordcloudOutline = document.querySelector('#wordcloud-outline');
const wordcloudInput = document.querySelector('#wordcloud-input');
const wordcloudStatus = document.querySelector('#wordcloud-status');
const wordcloudCount = document.querySelector('#wordcloud-count');
const cloudSvgNamespace = 'http://www.w3.org/2000/svg';
const cloudWidth = 1000;
const cloudHeight = 620;
const cloudShapes = {
  circle: {
    description: 'lingkaran',
    outline: 'M 500 66 A 434 244 0 1 1 500 554 A 434 244 0 1 1 500 66 Z',
    contains: (x, y) => ((x - 500) / 434) ** 2 + ((y - 310) / 244) ** 2 <= 1
  },
  heart: {
    description: 'hati',
    outline: 'M 500 550 C 442 502 112 292 112 190 C 112 43 303 36 500 210 C 697 36 888 43 888 190 C 888 292 558 502 500 550 Z',
    contains: (x, y) => {
      const heartX = (x - 500) / 390;
      const heartY = (310 - y) / 240;
      return (heartX ** 2 + heartY ** 2 - 1) ** 3 - heartX ** 2 * heartY ** 3 <= 0;
    }
  },
  star: {
    description: 'bintang',
    outline: 'M 500 50 L 606 235 L 822 270 L 666 425 L 704 565 L 500 475 L 296 565 L 334 425 L 178 270 L 394 235 Z',
    contains: (x, y) => {
      const outerRadius = 250;
      const innerRadius = 116;
      const angle = Math.atan2(y - 310, x - 500) + Math.PI / 2;
      const sector = ((angle % (Math.PI / 5)) + Math.PI / 5) % (Math.PI / 5);
      const normalizedAngle = Math.min(sector, Math.PI / 5 - sector);
      const boundary = outerRadius * innerRadius /
        Math.sqrt((innerRadius * Math.cos(normalizedAngle)) ** 2 +
          (outerRadius * Math.sin(normalizedAngle)) ** 2);
      return Math.hypot(x - 500, y - 310) <= boundary;
    }
  },
  cloud: {
    description: 'awan',
    outline: 'M 228 482 C 124 482 84 408 102 337 C 117 278 172 249 232 252 C 245 154 324 93 414 101 C 478 43 584 49 639 120 C 735 91 838 150 843 252 C 928 274 946 347 912 408 C 888 457 847 482 787 482 Z',
    contains: (x, y) => (
      ((x - 272) / 168) ** 2 + ((y - 364) / 133) ** 2 <= 1 ||
      ((x - 464) / 222) ** 2 + ((y - 291) / 197) ** 2 <= 1 ||
      ((x - 678) / 186) ** 2 + ((y - 345) / 152) ** 2 <= 1 ||
      ((x - 500) / 365) ** 2 + ((y - 413) / 82) ** 2 <= 1
    )
  }
};
let activeCloudShape = 'circle';
let activeCloudSource = 'all';
let cloudShuffleSeed = 0;
let collaborationData = null;
let collaborationRequest = null;
let pilotGroupsRequest = null;
let pilotProjectMembers = [];
let pilotProjectIsAdmin = false;
let greetingsRequest = null;
const greetingReactions = {
  love: { icon: '❤️', label: 'mengirimkan love' },
  flower: { icon: '🌸', label: 'mengirimkan bunga' },
  crown: { icon: '👑', label: 'memberikan mahkota' }
};

function readWordcloudInput() {
  const words = [];
  const seen = new Set();
  let invalidCount = 0;
  for (const line of wordcloudInput.value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.lastIndexOf(',');
    const label = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim();
    const weightText = separator === -1 ? '' : trimmed.slice(separator + 1).trim();
    const weight = weightText ? Number(weightText) : 1;
    const key = label.toLocaleLowerCase('id');
    if (!label || label.length > 36 || !Number.isFinite(weight) || weight <= 0 ||
        weight > 100 || seen.has(key)) {
      invalidCount += 1;
      continue;
    }
    seen.add(key);
    words.push({ label, weight });
  }
  return { words: words.sort((first, second) => second.weight - first.weight), invalidCount };
}

function cloudWordBox(label, fontSize, context) {
  context.font = `600 ${fontSize}px "Space Grotesk", "DM Sans", sans-serif`;
  const textWidth = context.measureText(label).width;
  const height = fontSize * 1.4;
  return { width: textWidth + height * 0.68, height, textWidth };
}

function cloudBoxFitsShape(shape, x, y, box) {
  const halfWidth = box.width / 2;
  const halfHeight = box.height / 2;
  return [
    [x - halfWidth, y - halfHeight],
    [x + halfWidth, y - halfHeight],
    [x - halfWidth, y + halfHeight],
    [x + halfWidth, y + halfHeight]
  ].every(([pointX, pointY]) => pointX >= 26 && pointX <= cloudWidth - 26 &&
    pointY >= 22 && pointY <= cloudHeight - 22 && shape.contains(pointX, pointY));
}

function createCloudCandidates(shape) {
  const candidates = [];
  for (let y = 34; y <= cloudHeight - 34; y += 10) {
    for (let x = 34; x <= cloudWidth - 34; x += 10) {
      if (shape.contains(x, y)) {
        const jitter = Math.random() * 4;
        candidates.push({ x, y, score: Math.hypot((x - 500) / 1.15, y - 310) + jitter });
      }
    }
  }
  return candidates.sort((first, second) => first.score - second.score);
}

function renderWordcloud() {
  if (!wordcloudStage || !wordcloudInput) return;
  const shape = cloudShapes[activeCloudShape];
  const { words, invalidCount } = readWordcloudInput();
  const description = document.querySelector('#wordcloud-svg-description');
  description.textContent = `Visualisasi ${words.length} kata yang bergerak perlahan dalam bentuk ${shape.description}.`;
  wordcloudStage.dataset.shape = activeCloudShape;
  wordcloudOutline.setAttribute('d', shape.outline);
  wordcloudWords.replaceChildren();

  if (!words.length) {
    wordcloudCount.textContent = '0 kata';
    wordcloudStatus.textContent = invalidCount
      ? `${invalidCount} baris tidak valid diabaikan. Masukkan kata dengan bobot 1–100.`
      : 'Data akan dimuat dari profil anggota IDTC.';
    return;
  }

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    wordcloudCount.textContent = '0 kata';
    wordcloudStatus.textContent = 'Browser ini tidak mendukung pembuatan wordcloud.';
    return;
  }
  const weights = words.map((word) => word.weight);
  const maximumWeight = Math.max(...weights);
  const minimumWeight = Math.min(...weights);
  const weightRange = maximumWeight - minimumWeight || 1;
  const candidates = createCloudCandidates(shape);
  const collisionGap = 3;

  let bestLayout = { placed: [], unplaced: words };
  for (const scale of [1, 0.9, 0.8, 0.7, 0.6]) {
    const placed = [];
    const unplaced = [];
    for (const [index, word] of words.entries()) {
      const fontSize = (17 + ((word.weight - minimumWeight) / weightRange) * 30) * scale;
      const box = cloudWordBox(word.label, fontSize, context);
      const position = candidates.find((candidate) => {
        if (!cloudBoxFitsShape(shape, candidate.x, candidate.y, box)) return false;
        return placed.every((item) =>
          Math.abs(candidate.x - item.x) >= (box.width + item.box.width) / 2 + collisionGap ||
          Math.abs(candidate.y - item.y) >= (box.height + item.box.height) / 2 + collisionGap
        );
      });
      if (!position) {
        unplaced.push(word.label);
        continue;
      }
      placed.push({ ...position, box, word, index, fontSize });
    }

    if (placed.length > bestLayout.placed.length) bestLayout = { placed, unplaced };
    if (!unplaced.length) break;
  }

  for (const item of bestLayout.placed) {
    const wrapper = document.createElementNS(cloudSvgNamespace, 'g');
    wrapper.setAttribute('transform', `translate(${item.x} ${item.y})`);
    wrapper.setAttribute('class', 'wordcloud-word-position');
    const bubble = document.createElementNS(cloudSvgNamespace, 'g');
    bubble.setAttribute('class', `wordcloud-word-float wordcloud-tone-${(item.index + cloudShuffleSeed) % 6 + 1}`);
    const background = document.createElementNS(cloudSvgNamespace, 'rect');
    background.setAttribute('x', String(-item.box.width / 2));
    background.setAttribute('y', String(-item.box.height / 2));
    background.setAttribute('width', String(item.box.width));
    background.setAttribute('height', String(item.box.height));
    background.setAttribute('rx', String(item.box.height / 2));
    background.setAttribute('class', 'wordcloud-bubble');
    const text = document.createElementNS(cloudSvgNamespace, 'text');
    text.setAttribute('x', '0');
    text.setAttribute('y', '0');
    text.setAttribute('font-size', String(item.fontSize));
    text.setAttribute('class', 'wordcloud-word-label');
    text.setAttribute('aria-hidden', 'true');
    text.textContent = item.word.label;
    bubble.append(background, text);
    wrapper.append(bubble);
    wordcloudWords.append(wrapper);
  }

  wordcloudCount.textContent = `${bestLayout.placed.length} kata`;
  const layoutStatus = bestLayout.unplaced.length
    ? `${bestLayout.placed.length} kata tampil dalam bentuk ${shape.description}; ${bestLayout.unplaced.length} kata belum tertampung.`
    : `${bestLayout.placed.length} kata disusun berdasarkan bobot dalam bentuk ${shape.description}.`;
  wordcloudStatus.textContent = invalidCount
    ? `${layoutStatus} ${invalidCount} baris tidak valid diabaikan.`
    : layoutStatus;
}

function updateWordcloudSource(source) {
  if (!collaborationData) return;
  activeCloudSource = source;
  document.querySelectorAll('[data-cloud-source]').forEach((button) => {
    const selected = button.dataset.cloudSource === source;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });

  const organization = collaborationData.organization;
  const profession = collaborationData.profession;
  const selectedItems = source === 'organization'
    ? organization
    : source === 'profession'
      ? profession
      : [...organization, ...profession].reduce((combined, item) => {
        const normalizedName = item.name.toLocaleLowerCase('id');
        const existing = combined.find((entry) => entry.normalizedName === normalizedName);
        if (existing) existing.count += item.count;
        else combined.push({ ...item, normalizedName });
        return combined;
      }, []);
  wordcloudInput.value = selectedItems
    .map((item) => `${item.name}, ${item.count}`)
    .join('\n');
  document.querySelector('#wordcloud-editor-title').textContent = source === 'organization'
    ? 'Instansi anggota'
    : source === 'profession'
      ? 'Profesi anggota'
      : 'Instansi dan profesi';
  document.querySelector('#wordcloud-count').textContent = `${selectedItems.length} kategori`;
  document.querySelector('#wordcloud-status').classList.remove('error');
  const emptyMessage = !selectedItems.length
    ? source === 'organization'
      ? 'Belum ada data instansi anggota aktif di database.'
      : source === 'profession'
        ? 'Belum ada data profesi anggota aktif. Lengkapi profesi di Pengaturan profil.'
        : 'Belum ada data instansi atau profesi anggota aktif di database.'
    : '';
  renderWordcloud();
  if (emptyMessage) wordcloudStatus.textContent = emptyMessage;
}

async function loadCollaborationData() {
  if (collaborationRequest) return collaborationRequest;
  const status = document.querySelector('#wordcloud-status');
  status.classList.remove('error');
  status.textContent = 'Memuat instansi dan profesi dari database...';
  collaborationRequest = (async () => {
    try {
      const response = await fetch('/api/auth/collaboration');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Data kolaborasi tidak dapat dimuat.');
      collaborationData = result;
      updateWordcloudSource(activeCloudSource);
    } catch (error) {
      status.textContent = error.message || 'Data kolaborasi tidak dapat dimuat.';
      status.classList.add('error');
    } finally {
      collaborationRequest = null;
    }
  })();
  return collaborationRequest;
}

function renderMemberGreetings(members, greetings) {
  const recipientSelect = document.querySelector('#greeting-recipient');
  const previousRecipient = recipientSelect.value;
  recipientSelect.replaceChildren();
  const prompt = document.createElement('option');
  prompt.value = '';
  prompt.textContent = members.length ? 'Pilih rekan anggota...' : 'Belum ada rekan anggota lain';
  recipientSelect.append(prompt);
  for (const member of members) {
    const option = document.createElement('option');
    option.value = member.id;
    option.textContent = member.organization
      ? `${member.fullName} · ${member.organization}`
      : member.fullName;
    recipientSelect.append(option);
  }
  if (members.some((member) => member.id === previousRecipient)) {
    recipientSelect.value = previousRecipient;
  }
  recipientSelect.disabled = members.length === 0;
  document.querySelector('#greeting-submit').disabled = members.length === 0;

  const feed = document.querySelector('#greeting-feed');
  feed.replaceChildren();
  document.querySelector('#greeting-feed-count').textContent = `${greetings.length} sapaan`;
  document.querySelector('#greeting-feed-message').textContent = greetings.length
    ? ''
    : 'Belum ada sapaan. Kirim apresiasi pertama untuk rekan anggota.';
  for (const greeting of greetings) {
    const reaction = greetingReactions[greeting.reaction];
    if (!reaction) continue;
    const card = document.createElement('article');
    card.className = `greeting-card greeting-card-${greeting.reaction}`;
    const icon = document.createElement('span');
    icon.className = 'greeting-card-icon';
    icon.setAttribute('aria-label', reaction.label);
    icon.textContent = reaction.icon;
    const content = document.createElement('div');
    content.className = 'greeting-card-content';
    const names = document.createElement('p');
    names.className = 'greeting-card-names';
    names.textContent = `${greeting.sender_name} menyapa ${greeting.recipient_name}`;
    const message = document.createElement('p');
    message.className = 'greeting-card-message';
    message.textContent = greeting.message || reaction.label;
    const timestamp = document.createElement('time');
    timestamp.className = 'greeting-card-time';
    const createdAt = new Date(greeting.created_at);
    if (!Number.isNaN(createdAt.valueOf())) {
      timestamp.dateTime = createdAt.toISOString();
      timestamp.textContent = new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(createdAt);
    }
    content.append(names, message, timestamp);
    card.append(icon, content);
    feed.append(card);
  }
}

async function loadMemberGreetings() {
  if (greetingsRequest) return greetingsRequest;
  const status = document.querySelector('#greeting-feed-message');
  status.classList.remove('error');
  status.textContent = 'Memuat sapaan anggota...';
  greetingsRequest = (async () => {
    try {
      const response = await fetch('/api/auth/collaboration/greetings');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Sapaan anggota tidak dapat dimuat.');
      renderMemberGreetings(result.members, result.greetings);
    } catch (error) {
      status.textContent = error.message || 'Sapaan anggota tidak dapat dimuat.';
      status.classList.add('error');
    } finally {
      greetingsRequest = null;
    }
  })();
  return greetingsRequest;
}

function renderPilotProjectGroups(groups) {
  const list = document.querySelector('#pilot-project-list');
  list.replaceChildren();
  for (const group of groups) {
    const card = document.createElement('article');
    card.className = 'pilot-project-card';
    card.dataset.groupCard = group.id;
    const eyebrow = document.createElement('p');
    eyebrow.className = 'pilot-project-card-kicker';
    eyebrow.textContent = 'PROJECT PILOT';
    const heading = document.createElement('h3');
    heading.textContent = group.name;
    const focus = document.createElement('span');
    focus.className = 'pilot-project-focus';
    focus.textContent = group.focus;
    const description = document.createElement('p');
    description.className = 'pilot-project-description';
    description.textContent = group.description || 'Belum ada deskripsi untuk group ini.';
    const footer = document.createElement('p');
    footer.className = 'pilot-project-meta';
    const createdDate = new Date(group.created_at);
    const dateLabel = Number.isNaN(createdDate.valueOf())
      ? ''
      : new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium' }).format(createdDate);
    footer.textContent = [
      group.created_by
        ? `${group.created_by_role === 'admin' ? 'Admin' : group.created_by_role === 'member' ? 'Member' : 'Penggagas'}: ${group.created_by}`
        : '',
      dateLabel
    ]
      .filter(Boolean)
      .join(' · ');
    const people = document.createElement('div');
    people.className = 'pilot-project-people';
    const manager = document.createElement('p');
    manager.className = 'pilot-project-person';
    const managerName = group.projectManager
      ? `${group.projectManager.fullName} · ${group.projectManager.profession || 'Profesi/keahlian belum diisi'}`
      : 'Belum ditetapkan';
    manager.textContent = `Project Manager: ${managerName}`;
    people.append(manager);
    const teamHeading = document.createElement('p');
    teamHeading.className = 'pilot-project-team-heading';
    teamHeading.textContent = `Anggota tim · ${group.members.length}`;
    people.append(teamHeading);
    if (group.members.length) {
      const teamList = document.createElement('ul');
      teamList.className = 'pilot-project-team-list';
      for (const member of group.members) {
        const item = document.createElement('li');
        const name = document.createElement('strong');
        name.textContent = member.fullName;
        const expertise = document.createElement('span');
        expertise.textContent = member.profession || 'Profesi/keahlian belum diisi';
        item.append(name, expertise);
        teamList.append(item);
      }
      people.append(teamList);
    } else {
      const emptyTeam = document.createElement('p');
      emptyTeam.className = 'pilot-project-empty-team';
      emptyTeam.textContent = 'Belum ada anggota tim.';
      people.append(emptyTeam);
    }
    card.append(eyebrow, heading, focus, description, people, footer);
    if (pilotProjectIsAdmin) {
      const settings = document.createElement('details');
      settings.className = 'pilot-project-settings';
      const summary = document.createElement('summary');
      summary.textContent = 'Pengaturan PM & tim';
      const form = document.createElement('form');
      form.className = 'pilot-project-team-form';
      form.dataset.teamSettingsForm = '';
      form.dataset.groupId = group.id;
      const managerLabel = document.createElement('label');
      managerLabel.textContent = 'Project Manager (PM)';
      const managerSelect = document.createElement('select');
      managerSelect.name = 'projectManagerId';
      managerSelect.append(new Option('Belum ditetapkan', ''));
      for (const member of pilotProjectMembers) {
        const organization = member.organization ? ` · ${member.organization}` : '';
        managerSelect.append(new Option(
          `${member.fullName} · ${member.profession || 'Profesi/keahlian belum diisi'}${organization}`,
          member.id
        ));
      }
      managerSelect.value = group.projectManager?.id || '';
      managerLabel.append(managerSelect);
      const teamLabel = document.createElement('label');
      teamLabel.textContent = 'Anggota tim';
      const teamSelect = document.createElement('select');
      teamSelect.name = 'memberIds';
      teamSelect.multiple = true;
      teamSelect.size = Math.min(Math.max(pilotProjectMembers.length, 3), 7);
      teamSelect.setAttribute('aria-label', 'Pilih anggota tim pilot project');
      const groupMemberIds = new Set(group.members.map((member) => member.id));
      for (const member of pilotProjectMembers) {
        const organization = member.organization ? ` · ${member.organization}` : '';
        const option = new Option(
          `${member.fullName} · ${member.profession || 'Profesi/keahlian belum diisi'}${organization}`,
          member.id
        );
        option.selected = groupMemberIds.has(member.id);
        teamSelect.append(option);
      }
      teamLabel.append(teamSelect);
      const help = document.createElement('span');
      help.className = 'pilot-project-team-help';
      help.textContent = 'Profesi/keahlian diambil dari profil anggota. Gunakan Ctrl atau Command untuk memilih beberapa anggota.';
      const error = document.createElement('p');
      error.className = 'pilot-project-team-error';
      error.dataset.teamFormMessage = '';
      error.setAttribute('role', 'status');
      const save = document.createElement('button');
      save.className = 'pilot-project-create-button';
      save.type = 'submit';
      save.textContent = 'Simpan pengaturan';
      form.append(managerLabel, teamLabel, help, error, save);
      settings.append(summary, form);
      card.append(settings);
    }
    list.append(card);
    const shareButton = document.createElement('button');
    shareButton.className = 'pilot-project-share-button';
    shareButton.type = 'button';
    shareButton.dataset.shareGroup = group.id;
    shareButton.textContent = 'Bagikan project';
    focus.after(shareButton);

    const feed = document.createElement('section');
    feed.className = 'pilot-project-feed';
    feed.setAttribute('aria-label', `Aktivitas ${group.name}`);
    const feedHeading = document.createElement('div');
    feedHeading.className = 'pilot-project-feed-heading';
    const feedTitle = document.createElement('h4');
    feedTitle.textContent = 'Aktivitas project';
    const feedStatus = document.createElement('span');
    feedStatus.dataset.postStatus = '';
    feedStatus.textContent = 'Memuat aktivitas...';
    feedHeading.append(feedTitle, feedStatus);
    const postList = document.createElement('div');
    postList.className = 'pilot-project-post-list';
    postList.dataset.postList = '';
    const composer = document.createElement('form');
    composer.className = 'pilot-project-post-composer';
    composer.dataset.postForm = '';
    composer.dataset.groupId = group.id;
    const postContent = document.createElement('textarea');
    postContent.name = 'content';
    postContent.maxLength = 2000;
    postContent.rows = 3;
    postContent.placeholder = 'Bagikan kabar atau perkembangan project...';
    postContent.setAttribute('aria-label', 'Keterangan aktivitas project');
    const postLink = document.createElement('input');
    postLink.type = 'url';
    postLink.name = 'linkUrl';
    postLink.maxLength = 2000;
    postLink.placeholder = 'Bagikan tautan terkait (opsional)';
    postLink.setAttribute('aria-label', 'Tautan terkait project');
    const composerActions = document.createElement('div');
    composerActions.className = 'pilot-project-composer-actions';
    const fileLabel = document.createElement('label');
    fileLabel.className = 'pilot-project-file-label';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.name = 'media';
    fileInput.accept = 'image/jpeg,image/png,image/webp,application/pdf';
    const fileLabelText = document.createElement('span');
    fileLabelText.textContent = 'Tambah foto / PDF';
    const fileName = document.createElement('span');
    fileName.className = 'pilot-project-file-name';
    fileName.dataset.fileName = '';
    fileName.textContent = 'Maks. 10 MB';
    fileLabel.append(fileInput, fileLabelText, fileName);
    const publish = document.createElement('button');
    publish.className = 'pilot-project-create-button';
    publish.type = 'submit';
    publish.textContent = 'Bagikan';
    composerActions.append(fileLabel, publish);
    const composerMessage = document.createElement('p');
    composerMessage.className = 'pilot-project-post-form-message';
    composerMessage.dataset.postFormMessage = '';
    composerMessage.setAttribute('role', 'status');
    composer.append(postContent, postLink, composerActions, composerMessage);
    feed.append(feedHeading, postList, composer);
    card.append(feed);
  }
}

async function loadPilotProjectGroups() {
  if (pilotGroupsRequest) return pilotGroupsRequest;
  const status = document.querySelector('#pilot-project-message');
  status.classList.remove('error');
  status.textContent = 'Memuat group pilot project...';
  pilotGroupsRequest = (async () => {
    try {
      const response = await fetch('/api/auth/pilot-project-groups');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Group pilot project tidak dapat dimuat.');
      pilotProjectIsAdmin = result.isAdmin === true;
      pilotProjectMembers = result.members;
      renderPilotProjectGroups(result.groups);
      await Promise.all(result.groups.map((group) => loadPilotProjectPosts(group.id)));
      status.textContent = result.groups.length
        ? `${result.groups.length} group pilot project`
        : 'Belum ada group pilot project. Jadilah yang pertama membuatnya.';
    } catch (error) {
      status.textContent = error.message || 'Group pilot project tidak dapat dimuat.';
      status.classList.add('error');
    } finally {
      pilotGroupsRequest = null;
    }
  })();
  return pilotGroupsRequest;
}

async function loadPilotProjectPosts(groupId) {
  const card = document.querySelector(`[data-group-card="${CSS.escape(groupId)}"]`);
  if (!card) return;
  const status = card.querySelector('[data-post-status]');
  status.classList.remove('error');
  status.textContent = 'Memuat aktivitas...';
  try {
    const response = await fetch(`/api/auth/pilot-project-groups/${encodeURIComponent(groupId)}/posts`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Aktivitas project tidak dapat dimuat.');
    renderPilotProjectPosts(card, groupId, result.posts);
    status.textContent = result.posts.length
      ? `${result.posts.length} aktivitas`
      : 'Belum ada aktivitas';
  } catch (error) {
    status.textContent = error.message || 'Aktivitas project tidak dapat dimuat.';
    status.classList.add('error');
  }
}

function renderPilotProjectPosts(card, groupId, posts) {
  const postList = card.querySelector('[data-post-list]');
  postList.replaceChildren();
  for (const post of posts) {
    const article = document.createElement('article');
    article.className = 'pilot-project-post';
    article.dataset.postId = post.id;
    const heading = document.createElement('div');
    heading.className = 'pilot-project-post-author';
    const identity = document.createElement('div');
    const author = document.createElement('strong');
    author.textContent = post.authorName;
    const profession = document.createElement('span');
    profession.textContent = post.authorProfession || 'Anggota IDTC';
    identity.append(author, profession);
    const postedAt = document.createElement('time');
    const postDate = new Date(post.createdAt);
    if (!Number.isNaN(postDate.valueOf())) {
      postedAt.dateTime = postDate.toISOString();
      postedAt.textContent = new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(postDate);
    }
    heading.append(identity, postedAt);
    article.append(heading);
    if (post.content) {
      const content = document.createElement('p');
      content.className = 'pilot-project-post-content';
      content.textContent = post.content;
      article.append(content);
    }
    if (post.mediaUrl && post.mediaType?.startsWith('image/')) {
      const imageLink = document.createElement('a');
      imageLink.className = 'pilot-project-post-media-link';
      imageLink.href = post.mediaUrl;
      imageLink.target = '_blank';
      imageLink.rel = 'noopener noreferrer';
      const image = document.createElement('img');
      image.className = 'pilot-project-post-image';
      image.src = post.mediaUrl;
      image.alt = post.mediaName || 'Lampiran aktivitas project';
      image.loading = 'lazy';
      imageLink.append(image);
      article.append(imageLink);
    } else if (post.mediaUrl) {
      const documentLink = document.createElement('a');
      documentLink.className = 'pilot-project-post-document';
      documentLink.href = post.mediaUrl;
      documentLink.textContent = `Buka dokumen · ${post.mediaName || 'Lampiran PDF'}`;
      documentLink.target = '_blank';
      documentLink.rel = 'noopener noreferrer';
      article.append(documentLink);
    }
    if (post.linkUrl) {
      const link = document.createElement('a');
      link.className = 'pilot-project-post-link';
      link.href = post.linkUrl;
      link.textContent = post.linkUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      article.append(link);
    }
    const actions = document.createElement('div');
    actions.className = 'pilot-project-post-actions';
    const like = document.createElement('button');
    like.className = 'pilot-project-like-button';
    like.type = 'button';
    like.dataset.likePost = post.id;
    like.dataset.groupId = groupId;
    like.setAttribute('aria-pressed', String(post.likedByMe));
    like.textContent = `${post.likedByMe ? '♥ Disukai' : '♡ Suka'} · ${post.likeCount}`;
    const share = document.createElement('button');
    share.className = 'pilot-project-post-share';
    share.type = 'button';
    share.dataset.sharePost = post.id;
    share.dataset.groupId = groupId;
    share.textContent = 'Bagikan';
    actions.append(like, share);
    article.append(actions);

    const comments = document.createElement('div');
    comments.className = 'pilot-project-comments';
    for (const comment of post.comments) {
      const row = document.createElement('p');
      const name = document.createElement('strong');
      name.textContent = comment.author_name;
      const text = document.createElement('span');
      text.textContent = comment.content;
      row.append(name, text);
      comments.append(row);
    }
    const commentForm = document.createElement('form');
    commentForm.className = 'pilot-project-comment-form';
    commentForm.dataset.commentForm = '';
    commentForm.dataset.groupId = groupId;
    commentForm.dataset.postId = post.id;
    const commentInput = document.createElement('input');
    commentInput.name = 'content';
    commentInput.type = 'text';
    commentInput.maxLength = 1000;
    commentInput.placeholder = 'Tulis komentar...';
    commentInput.setAttribute('aria-label', 'Tulis komentar pada aktivitas project');
    const commentButton = document.createElement('button');
    commentButton.type = 'submit';
    commentButton.textContent = 'Kirim';
    commentForm.append(commentInput, commentButton);
    comments.append(commentForm);
    article.append(comments);
    postList.append(article);
  }
}

async function sharePilotProject(url, title, status) {
  try {
    if (navigator.share) {
      await navigator.share({ title, url });
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      status.textContent = 'Tautan project berhasil disalin.';
    } else {
      throw new Error('Browser ini tidak mendukung berbagi tautan. Salin URL halaman secara manual.');
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    status.textContent = error.message || 'Tautan project tidak dapat dibagikan.';
    status.classList.add('error');
  }
}

document.querySelectorAll('[data-cloud-shape]').forEach((button) => {
  button.addEventListener('click', () => {
    activeCloudShape = button.dataset.cloudShape;
    document.querySelectorAll('[data-cloud-shape]').forEach((shapeButton) => {
      const selected = shapeButton === button;
      shapeButton.classList.toggle('is-selected', selected);
      shapeButton.setAttribute('aria-pressed', String(selected));
    });
    renderWordcloud();
  });
});

document.querySelectorAll('[data-cloud-source]').forEach((button) => {
  button.addEventListener('click', () => updateWordcloudSource(button.dataset.cloudSource));
});

document.querySelector('#wordcloud-generate').addEventListener('click', () => {
  cloudShuffleSeed += 1;
  renderWordcloud();
});

document.querySelector('#wordcloud-apply').addEventListener('click', () => {
  if (collaborationData) renderWordcloud();
  else loadCollaborationData();
});
wordcloudInput.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key === 'Enter') renderWordcloud();
});

document.querySelector('#wordcloud-motion').addEventListener('click', (event) => {
  const button = event.currentTarget;
  const paused = wordcloudStage.classList.toggle('is-paused');
  button.textContent = paused ? 'Putar animasi' : 'Jeda animasi';
  button.setAttribute('aria-pressed', String(!paused));
});

renderWordcloud();

document.querySelector('#greeting-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = document.querySelector('#greeting-submit');
  const status = document.querySelector('#greeting-form-message');
  const reaction = form.elements.reaction.value;
  status.textContent = '';
  status.classList.remove('error');
  submitButton.disabled = true;
  try {
    const response = await fetch('/api/auth/collaboration/greetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientId: form.elements.recipientId.value,
        reaction,
        message: form.elements.message.value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Sapaan tidak dapat dikirim.');
    form.elements.message.value = '';
    status.textContent = result.message || 'Sapaan Anda berhasil dibagikan.';
    await loadMemberGreetings();
  } catch (error) {
    status.textContent = error.message || 'Sapaan tidak dapat dikirim.';
    status.classList.add('error');
  } finally {
    submitButton.disabled = document.querySelector('#greeting-recipient').disabled;
  }
});

document.querySelector('#pilot-project-open-create').addEventListener('click', () => {
  document.querySelector('#pilot-project-form-error').textContent = '';
  document.querySelector('#pilot-project-form').hidden = false;
  document.querySelector('#pilot-project-name').focus();
});

document.querySelector('#pilot-project-close-create').addEventListener('click', () => {
  document.querySelector('#pilot-project-form').hidden = true;
});

document.querySelector('#pilot-project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = document.querySelector('#pilot-project-submit');
  const errorMessage = document.querySelector('#pilot-project-form-error');
  errorMessage.textContent = '';
  submitButton.disabled = true;
  submitButton.textContent = 'Menyimpan...';
  try {
    const response = await fetch('/api/auth/pilot-project-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.elements.name.value,
        focus: form.elements.focus.value,
        description: form.elements.description.value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Group pilot project tidak dapat disimpan.');
    form.reset();
    form.hidden = true;
    await loadPilotProjectGroups();
  } catch (error) {
    errorMessage.textContent = error.message || 'Group pilot project tidak dapat disimpan.';
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Simpan group';
  }
});

document.querySelector('#pilot-project-list').addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-team-settings-form]');
  if (!form) return;
  event.preventDefault();
  const saveButton = form.querySelector('button[type="submit"]');
  const message = form.querySelector('[data-team-form-message]');
  const teamSelect = form.elements.memberIds;
  message.textContent = '';
  message.classList.remove('error');
  saveButton.disabled = true;
  saveButton.textContent = 'Menyimpan...';
  try {
    const response = await fetch(
      `/api/auth/pilot-project-groups/${encodeURIComponent(form.dataset.groupId)}/team`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectManagerId: form.elements.projectManagerId.value,
          memberIds: [...teamSelect.selectedOptions].map((option) => option.value)
        })
      }
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Pengaturan PM dan tim tidak dapat disimpan.');
    message.textContent = result.message;
    await loadPilotProjectGroups();
  } catch (error) {
    message.textContent = error.message || 'Pengaturan PM dan tim tidak dapat disimpan.';
    message.classList.add('error');
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Simpan pengaturan';
  }
});

document.querySelector('#pilot-project-list').addEventListener('change', (event) => {
  const fileInput = event.target.closest('input[type="file"][name="media"]');
  if (!fileInput) return;
  const fileName = fileInput.closest('form').querySelector('[data-file-name]');
  fileName.textContent = fileInput.files[0]?.name || 'Maks. 10 MB';
});

document.querySelector('#pilot-project-list').addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-post-form]');
  if (!form) return;
  event.preventDefault();
  const submitButton = form.querySelector('button[type="submit"]');
  const message = form.querySelector('[data-post-form-message]');
  message.textContent = '';
  message.classList.remove('error');
  submitButton.disabled = true;
  submitButton.textContent = 'Membagikan...';
  try {
    const response = await fetch(
      `/api/auth/pilot-project-groups/${encodeURIComponent(form.dataset.groupId)}/posts`,
      { method: 'POST', body: new FormData(form) }
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Aktivitas project tidak dapat dibagikan.');
    form.reset();
    form.querySelector('[data-file-name]').textContent = 'Maks. 10 MB';
    message.textContent = result.message;
    await loadPilotProjectPosts(form.dataset.groupId);
  } catch (error) {
    message.textContent = error.message || 'Aktivitas project tidak dapat dibagikan.';
    message.classList.add('error');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Bagikan';
  }
});

document.querySelector('#pilot-project-list').addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-comment-form]');
  if (!form) return;
  event.preventDefault();
  const submitButton = form.querySelector('button[type="submit"]');
  const input = form.elements.content;
  submitButton.disabled = true;
  try {
    const response = await fetch(
      `/api/auth/pilot-project-groups/${encodeURIComponent(form.dataset.groupId)}/posts/${encodeURIComponent(form.dataset.postId)}/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: input.value })
      }
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Komentar tidak dapat dikirim.');
    input.value = '';
    await loadPilotProjectPosts(form.dataset.groupId);
  } catch (error) {
    const status = form.closest('.pilot-project-feed').querySelector('[data-post-status]');
    status.textContent = error.message || 'Komentar tidak dapat dikirim.';
    status.classList.add('error');
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector('#pilot-project-list').addEventListener('click', async (event) => {
  const sharePostButton = event.target.closest('[data-share-post]');
  const shareGroupButton = event.target.closest('[data-share-group]');
  if (sharePostButton || shareGroupButton) {
    const groupId = sharePostButton?.dataset.groupId || shareGroupButton.dataset.shareGroup;
    const postId = sharePostButton?.dataset.sharePost;
    const shareUrl = new URL('/', window.location.origin);
    shareUrl.searchParams.set('pilotProject', groupId);
    if (postId) shareUrl.searchParams.set('pilotPost', postId);
    shareUrl.hash = 'pilot-projects';
    const status = (sharePostButton || shareGroupButton)
      .closest('.pilot-project-card')
      .querySelector('[data-post-status]');
    await sharePilotProject(shareUrl.toString(), 'Pilot Project IDTC', status);
    return;
  }

  const likeButton = event.target.closest('[data-like-post]');
  if (!likeButton) return;
  const { groupId, likePost: postId } = likeButton.dataset;
  const shouldLike = likeButton.getAttribute('aria-pressed') !== 'true';
  likeButton.disabled = true;
  try {
    const response = await fetch(
      `/api/auth/pilot-project-groups/${encodeURIComponent(groupId)}/posts/${encodeURIComponent(postId)}/like`,
      { method: shouldLike ? 'POST' : 'DELETE' }
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Apresiasi tidak dapat diperbarui.');
    likeButton.setAttribute('aria-pressed', String(result.liked));
    likeButton.textContent = `${result.liked ? '♥ Disukai' : '♡ Suka'} · ${result.likeCount}`;
  } catch (error) {
    const status = likeButton.closest('.pilot-project-feed').querySelector('[data-post-status]');
    status.textContent = error.message || 'Apresiasi tidak dapat diperbarui.';
    status.classList.add('error');
  } finally {
    likeButton.disabled = false;
  }
});

async function loadHomepageContent() {
  try {
    const response = await fetch('/api/content/homepage');
    if (!response.ok) return;
    const result = await response.json();
    for (const element of document.querySelectorAll('[data-content-key]')) {
      const value = result.content?.[element.dataset.contentKey];
      if (typeof value === 'string') element.textContent = value;
    }
  } catch {
    return;
  }
}

document.querySelectorAll('[data-provider]').forEach((button) => {
  button.addEventListener('click', () => {
    const linkAccount = button.hasAttribute('data-link-provider');
    window.location.assign(`/auth/${button.dataset.provider}${linkAccount ? '?link=1' : ''}`);
  });
});

document.querySelectorAll('[data-dashboard-tab]').forEach((button) => {
  button.addEventListener('click', () => setDashboardTab(button.dataset.dashboardTab));
});

document.querySelector('#dashboard-print-kta').addEventListener('click', () => {
  document.body.dataset.printDocument = 'kta';
  window.addEventListener('afterprint', () => { delete document.body.dataset.printDocument; }, { once: true });
  window.print();
});

document.querySelector('#dashboard-download-qr').addEventListener('click', () => {
  const link = document.createElement('a');
  link.href = '/api/auth/kta-qr/download';
  document.body.appendChild(link);
  link.click();
  link.remove();
});

document.querySelector('#dashboard-print-certificate').addEventListener('click', () => {
  document.body.dataset.printDocument = 'certificate';
  window.addEventListener('afterprint', () => { delete document.body.dataset.printDocument; }, { once: true });
  window.print();
});

profileForm.querySelectorAll('input[name="avatarId"]').forEach((input) => {
  input.addEventListener('change', () => {
    const avatarId = input.value;
    document.querySelector('[data-avatar-display] span').textContent = avatarCharacters[avatarId];
    document.querySelector('[data-avatar-display]').dataset.avatar = avatarId;
    document.querySelectorAll('.avatar-option').forEach((option) => {
      option.classList.toggle('is-selected', option.dataset.avatarOption === avatarId);
    });
    document.querySelector('#profile-photo-avatar').textContent = avatarCharacters[avatarId];
    const hasPhoto = !document.querySelector('#profile-photo-remove').hidden;
    document.querySelector('#profile-photo-avatar').hidden = hasPhoto;
    if (!hasPhoto) document.querySelector('#profile-photo-preview').hidden = true;
  });
});

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  profileMessage.textContent = '';
  profileMessage.classList.remove('error');
  const fullName = profileForm.elements.fullName.value.trim();
  const organization = profileForm.elements.organization.value.trim();
  const profession = profileForm.elements.profession.value.trim();
  const avatarId = profileForm.elements.avatarId.value;
  if (!fullName || fullName.length > 150) {
    document.querySelector('#profile-name-error').textContent = 'Nama wajib diisi dan maksimal 150 karakter.';
    return;
  }
  if (organization.length > 180) {
    document.querySelector('#profile-organization-error').textContent = 'Instansi maksimal 180 karakter.';
    return;
  }
  if (profession.length > 180) {
    document.querySelector('#profile-profession-error').textContent = 'Profesi atau jabatan maksimal 180 karakter.';
    return;
  }
  document.querySelector('#profile-name-error').textContent = '';
  document.querySelector('#profile-organization-error').textContent = '';
  document.querySelector('#profile-profession-error').textContent = '';
  profileSaveButton.disabled = true;
  profileSaveButton.textContent = 'Menyimpan...';
  try {
    const response = await fetch('/api/auth/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName, organization, profession, avatarId })
    });
    const result = await response.json();
    if (!response.ok) {
      if (result.field === 'fullName') document.querySelector('#profile-name-error').textContent = result.error;
      else if (result.field === 'organization') document.querySelector('#profile-organization-error').textContent = result.error;
      else if (result.field === 'profession') document.querySelector('#profile-profession-error').textContent = result.error;
      else throw new Error(result.error || 'Pengaturan profil tidak dapat disimpan.');
      return;
    }
    showAccount(result.user);
    accountMessage.textContent = result.message;
  } catch (error) {
    profileMessage.textContent = error.message || 'Tidak dapat terhubung untuk menyimpan profil.';
    profileMessage.classList.add('error');
  } finally {
    profileSaveButton.disabled = false;
    profileSaveButton.textContent = 'Simpan pengaturan';
  }
});

loadHomepageContent();

memberPhotoInput.addEventListener('change', () => {
  photoError.textContent = '';
  photoFile.textContent = '';
  photoPreview.hidden = true;
  if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
  photoPreviewUrl = '';
  const [file] = memberPhotoInput.files;
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    photoError.textContent = 'Pilih foto dalam format JPG, PNG, atau WEBP.';
    memberPhotoInput.value = '';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    photoError.textContent = 'Ukuran foto maksimal 5 MB.';
    memberPhotoInput.value = '';
    return;
  }
  photoPreviewUrl = URL.createObjectURL(file);
  photoPreview.src = photoPreviewUrl;
  photoPreview.hidden = false;
  photoFile.textContent = file.name;
});

document.querySelectorAll('.password-toggle').forEach((toggle) => {
  toggle.addEventListener('click', () => {
    const input = toggle.closest('.password-field').querySelector('input');
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    toggle.classList.toggle('is-visible', isPassword);
    toggle.setAttribute('aria-pressed', String(isPassword));
    toggle.setAttribute('aria-label', isPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi');
  });
});

document.querySelectorAll('[data-mode]').forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    setAuthMode(link.dataset.mode);
  });
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  document.querySelectorAll('.field-error').forEach((error) => { error.textContent = ''; });
  formMessage.textContent = '';
  formMessage.classList.remove('error');
  let isValid = true;
  if (!emailInput.value.trim() || !emailInput.validity.valid) { emailError.textContent = 'Masukkan alamat email yang valid.'; isValid = false; }
  if (passwordInput.value.length < 8) { passwordError.textContent = 'Kata sandi minimal 8 karakter.'; isValid = false; }
  if (currentMode === 'register') {
    if (!fullNameInput.value.trim()) { document.querySelector('#full-name-error').textContent = 'Masukkan nama lengkap Anda.'; isValid = false; }
    if (passwordConfirmInput.value !== passwordInput.value) { document.querySelector('#password-confirm-error').textContent = 'Konfirmasi kata sandi belum sama.'; isValid = false; }
    if (!memberPhotoInput.files.length) { photoError.textContent = 'Lampirkan foto untuk kartu anggota IDTC.'; isValid = false; }
  }
  if (!isValid) { formMessage.textContent = 'Periksa kembali data yang Anda masukkan.'; formMessage.classList.add('error'); return; }

  submitButton.disabled = true;
  submitButton.querySelector('span').textContent = currentMode === 'login' ? 'Memeriksa akun...' : 'Mengirim pendaftaran...';
  try {
    const response = currentMode === 'login'
      ? await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: emailInput.value.trim(),
          password: passwordInput.value,
          remember: loginForm.elements.remember.checked
        })
      })
      : await fetch('/api/auth/register', {
        method: 'POST',
        body: new FormData(loginForm)
      });
    const result = await response.json();
    if (!response.ok) {
      if (currentMode === 'login') {
        formMessage.textContent = result.error || 'Tidak dapat masuk. Coba lagi.';
        formMessage.classList.add('error');
        return;
      }
      const errorTargets = {
        email: emailError,
        fullName: document.querySelector('#full-name-error'),
        memberPhoto: photoError,
        organization: document.querySelector('#organization-error'),
        profession: document.querySelector('#profession-error'),
        password: passwordError,
        passwordConfirm: document.querySelector('#password-confirm-error')
      };
      if (result.field && errorTargets[result.field]) errorTargets[result.field].textContent = result.error;
      formMessage.textContent = result.field ? 'Periksa kembali data yang Anda masukkan.' : result.error;
      formMessage.classList.add('error');
      return;
    }

    if (currentMode === 'login') {
      loginForm.reset();
      accountMessage.textContent = '';
      showAccount(result.user);
      return;
    }

    formMessage.textContent = result.message;
    loginForm.reset();
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    photoPreviewUrl = '';
    photoPreview.removeAttribute('src');
    photoPreview.hidden = true;
    photoFile.textContent = '';
  } catch {
    formMessage.textContent = currentMode === 'login'
      ? 'Tidak dapat terhubung ke layanan masuk. Coba lagi.'
      : 'Tidak dapat terhubung ke layanan pendaftaran. Coba lagi.';
    formMessage.classList.add('error');
  } finally {
    submitButton.disabled = false;
    submitButton.querySelector('span').textContent = currentMode === 'login' ? 'Masuk ke portal anggota' : 'Daftar sebagai anggota';
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  const button = document.querySelector('#logout-button');
  button.disabled = true;
  accountMessage.textContent = '';
  accountMessage.classList.remove('error');
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Tidak dapat keluar dari akun.');
    accountView.hidden = true;
    authView.hidden = false;
    pilotProjectIsAdmin = false;
    pilotProjectMembers = [];
    document.body.classList.remove('is-authenticated');
    loginForm.reset();
    setAuthMode('login');
  } catch (error) {
    accountMessage.textContent = error.message;
    accountMessage.classList.add('error');
  } finally {
    button.disabled = false;
  }
});

async function restoreSession() {
  try {
    const response = await fetch('/api/auth/me');
    if (response.status === 401) return;
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Tidak dapat memeriksa sesi masuk.');
    showAccount(result.user);
  } catch (error) {
    formMessage.textContent = error.message || 'Tidak dapat memeriksa sesi masuk.';
    formMessage.classList.add('error');
  }
}

async function initializeAuthentication() {
  await Promise.all([loadOAuthProviders(), restoreSession()]);
  const url = new URL(window.location.href);
  if (!accountView.hidden && url.hash === '#pilot-projects' && url.searchParams.has('pilotProject')) {
    setDashboardTab('pilot-projects');
    await loadPilotProjectGroups();
    const postId = url.searchParams.get('pilotPost');
    if (postId) {
      document.querySelector(`[data-post-id="${CSS.escape(postId)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  handleOAuthResult();
}

initializeAuthentication();

const idCard = document.querySelector('#id-card');
const supportsCardTilt = window.matchMedia(
  '(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)'
);

if (idCard && supportsCardTilt.matches) {
  idCard.addEventListener('pointermove', (event) => {
    const bounds = idCard.getBoundingClientRect();
    const horizontal = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
    const vertical = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;
    const column = horizontal < -0.25 ? 'west' : horizontal > 0.25 ? 'east' : '';
    const row = vertical < -0.25 ? 'north' : vertical > 0.25 ? 'south' : '';
    idCard.classList.remove(
      'tilt-north', 'tilt-northeast', 'tilt-east', 'tilt-southeast',
      'tilt-south', 'tilt-southwest', 'tilt-west', 'tilt-northwest'
    );
    const tilt = row && column ? `${row}${column}` : row || column;
    if (tilt) idCard.classList.add(`tilt-${tilt}`);
  });

  idCard.addEventListener('pointerleave', () => {
    idCard.classList.remove(
      'tilt-north', 'tilt-northeast', 'tilt-east', 'tilt-southeast',
      'tilt-south', 'tilt-southwest', 'tilt-west', 'tilt-northwest'
    );
  });
}