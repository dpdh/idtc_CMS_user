const loginView = document.querySelector('#login-view');
const dashboardView = document.querySelector('#dashboard-view');
const loginForm = document.querySelector('#admin-login-form');
const loginNotice = document.querySelector('#login-notice');
const passwordResetForm = document.querySelector('#admin-password-reset-form');
const passwordResetNotice = document.querySelector('#reset-notice');
const showPasswordResetButton = document.querySelector('#show-password-reset');
const dashboardNotice = document.querySelector('#dashboard-notice');
const logoutButton = document.querySelector('#logout-button');
const tableBody = document.querySelector('#users-table-body');
const filterForm = document.querySelector('#filter-form');
const statusFilter = document.querySelector('#status-filter');
const searchInput = document.querySelector('#search-users');
const photoDialog = document.querySelector('#photo-dialog');
const photoPreview = document.querySelector('#member-photo-preview');
const ktaDialog = document.querySelector('#kta-dialog');
const ktaPhoto = document.querySelector('#kta-photo');
const ktaInitials = document.querySelector('#kta-initials');
const ktaQr = document.querySelector('#kta-qr');
const ktaQrStatus = document.querySelector('#kta-qr-status');
const ktaBackCard = document.querySelector('#kta-card-back');
const ktaFrontCard = document.querySelector('#kta-card');
const ktaDownloadButton = document.querySelector('#download-kta-qr');
const approvalDialog = document.querySelector('#approval-dialog');
const certificateDialog = document.querySelector('#certificate-dialog');
const viewMembersButton = document.querySelector('#view-members');
const addMemberButton = document.querySelector('#add-member');
const memberFormDialog = document.querySelector('#member-form-dialog');
const memberForm = document.querySelector('#member-form');
const memberFormError = document.querySelector('#member-form-error');
const deleteDialog = document.querySelector('#delete-dialog');
const deleteError = document.querySelector('#delete-error');
const adminTabs = document.querySelector('#admin-tabs');
const accountsTab = document.querySelector('#accounts-tab');
const contentTab = document.querySelector('#content-tab');
const accountsTableBody = document.querySelector('#accounts-table-body');
const contentForm = document.querySelector('#content-form');
const contentError = document.querySelector('#content-error');
const roleNames = { super_admin: 'Super Admin', admin: 'Admin', membership: 'Membership', member: 'Free Member' };
const editableContentKeys = [
  'welcome_headline_prefix', 'welcome_headline_emphasis', 'welcome_description',
  'login_heading', 'login_description', 'register_heading', 'register_description'
];
let currentPage = 1;
let currentAdminId = '';
let currentAdminRoles = [];
let currentUsers = [];
let approvedMember = null;
let deletingMemberId = '';
let ktaQrUserId = '';

function setNotice(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle('error', isError);
}

async function requestJson(url, options = {}) {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body && !isFormData ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Permintaan tidak dapat diproses.');
  return result;
}

function showLogin(message = '') {
  currentAdminId = '';
  currentAdminRoles = [];
  loginView.hidden = false;
  dashboardView.hidden = true;
  logoutButton.hidden = true;
  setNotice(loginNotice, message, Boolean(message));
}

async function showDashboard(admin) {
  currentAdminId = admin.id;
  currentAdminRoles = admin.roleCodes || [];
  loginView.hidden = true;
  dashboardView.hidden = false;
  logoutButton.hidden = false;
  const roleLabel = currentAdminRoles.map((role) => roleNames[role] || role).join(', ');
  document.querySelector('#admin-identity').textContent = `${admin.email} · ${roleLabel}`;
  accountsTab.hidden = !currentAdminRoles.includes('super_admin');
  contentTab.hidden = !currentAdminRoles.some((role) => ['super_admin', 'admin'].includes(role));
  adminTabs.hidden = accountsTab.hidden && contentTab.hidden;
  setAdminView('members');
  await loadUsers();
}

function setAdminView(view) {
  if (view === 'accounts' && !currentAdminRoles.includes('super_admin')) return;
  if (view === 'content' && !currentAdminRoles.some((role) => ['super_admin', 'admin'].includes(role))) return;
  document.querySelectorAll('[data-admin-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.adminPanel !== view;
  });
  document.querySelectorAll('[data-admin-view]').forEach((tab) => {
    const selected = tab.dataset.adminView === view;
    tab.classList.toggle('is-selected', selected);
    tab.setAttribute('aria-selected', String(selected));
  });
  if (view === 'accounts') loadAccounts();
  if (view === 'content') loadContent();
}

async function loadAccounts() {
  const query = document.querySelector('#account-search').value.trim();
  try {
    const result = await requestJson(`/api/admin/accounts?q=${encodeURIComponent(query)}`);
    accountsTableBody.replaceChildren();
    document.querySelector('#accounts-empty-state').hidden = result.accounts.length > 0;
    for (const account of result.accounts) {
      const row = document.createElement('tr');
      const identityCell = document.createElement('td');
      const name = document.createElement('span');
      name.className = 'member-name';
      name.textContent = account.fullName;
      const email = document.createElement('span');
      email.className = 'member-email';
      email.textContent = account.email;
      identityCell.append(name, email);
      row.append(identityCell);

      const statusCell = document.createElement('td');
      const status = document.createElement('span');
      status.className = `status-tag status-${account.status}`;
      status.textContent = { pending: 'Menunggu', active: 'Aktif', suspended: 'Ditangguhkan' }[account.status] || account.status;
      statusCell.append(status);
      row.append(statusCell);

      const rolesCell = document.createElement('td');
      rolesCell.textContent = account.roles.join(', ') || 'Tanpa role';
      row.append(rolesCell);

      const roleCell = document.createElement('td');
      const roleSelect = document.createElement('select');
      roleSelect.className = 'account-role-select';
      roleSelect.dataset.userId = account.id;
      for (const role of result.roles) {
        const option = document.createElement('option');
        option.value = role.code;
        option.textContent = role.name;
        roleSelect.append(option);
      }
      roleSelect.value = ['super_admin', 'admin', 'membership', 'member'].find((role) => account.roleCodes.includes(role)) || 'member';
      roleCell.append(roleSelect);
      row.append(roleCell);

      const actionCell = document.createElement('td');
      const saveButton = makeAction('Simpan', 'role', account.id, 'edit');
      actionCell.append(saveButton);
      row.append(actionCell);
      accountsTableBody.append(row);
    }
  } catch (error) {
    setNotice(dashboardNotice, error.message, true);
  }
}

async function loadContent() {
  contentError.textContent = '';
  try {
    const result = await requestJson('/api/admin/content');
    for (const key of editableContentKeys) contentForm.elements[key].value = result.content[key] || '';
  } catch (error) {
    contentError.textContent = error.message;
  }
}

function appendCell(row, content, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  if (content instanceof Node) cell.append(content);
  else cell.textContent = content ?? '—';
  row.append(cell);
  return cell;
}

function makeAction(label, action, userId, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `table-action ${className}`.trim();
  button.dataset.action = action;
  button.dataset.userId = userId;
  button.textContent = label;
  return button;
}

function memberNumberLabel(user) {
  return `IDTC-${String(user.memberNumber).padStart(6, '0')}`;
}

async function showKta(user) {
  document.querySelector('#kta-name').textContent = user.fullName;
  document.querySelector('#kta-organization').textContent = user.organization || 'Anggota IDTC';
  document.querySelector('#kta-number').textContent = memberNumberLabel(user);
  document.querySelector('#kta-back-number').textContent = memberNumberLabel(user);
  ktaInitials.textContent = user.fullName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  ktaInitials.hidden = user.hasPhoto;
  ktaPhoto.hidden = !user.hasPhoto;
  ktaPhoto.removeAttribute('src');
  if (user.hasPhoto) ktaPhoto.src = `/api/admin/users/${user.id}/photo`;
  ktaFrontCard.hidden = false;
  ktaBackCard.hidden = true;
  document.querySelectorAll('[data-kta-face]').forEach((button) => {
    const isFront = button.dataset.ktaFace === 'front';
    button.classList.toggle('is-selected', isFront);
    button.setAttribute('aria-pressed', String(isFront));
  });
  const printButton = document.querySelector('#print-kta');
  printButton.disabled = true;
  ktaDownloadButton.disabled = true;
  ktaQrUserId = user.id;
  ktaQr.hidden = true;
  ktaQr.removeAttribute('src');
  ktaQrStatus.classList.remove('has-error');
  ktaQrStatus.textContent = 'Memuat QR...';
  ktaDialog.showModal();
  try {
    const result = await requestJson(`/api/admin/users/${user.id}/qr`);
    ktaQr.src = result.qrDataUrl;
    ktaQr.hidden = false;
    ktaQrStatus.textContent = '';
    ktaDownloadButton.disabled = false;
  } catch (error) {
    ktaQrStatus.textContent = error.message;
    ktaQrStatus.classList.add('has-error');
  } finally {
    printButton.disabled = false;
  }
}

document.querySelectorAll('[data-kta-face]').forEach((button) => {
  button.addEventListener('click', () => {
    const showFront = button.dataset.ktaFace === 'front';
    ktaFrontCard.hidden = !showFront;
    ktaBackCard.hidden = showFront;
    document.querySelectorAll('[data-kta-face]').forEach((faceButton) => {
      const selected = faceButton === button;
      faceButton.classList.toggle('is-selected', selected);
      faceButton.setAttribute('aria-pressed', String(selected));
    });
  });
});

function showCertificate(user) {
  document.querySelector('#certificate-member-name').textContent = user.fullName;
  document.querySelector('#certificate-member-number').textContent = memberNumberLabel(user);
  document.querySelector('#certificate-organization').textContent = user.organization || 'Anggota Indonesia Digital Twin Community';
  document.querySelector('#certificate-date').textContent = `Ditetapkan ${new Intl.DateTimeFormat('id-ID', { dateStyle: 'long' }).format(new Date())}`;
  certificateDialog.showModal();
}

function printDocument(target) {
  const clearPrintTarget = () => { delete document.body.dataset.printTarget; };
  document.body.dataset.printTarget = target;
  window.addEventListener('afterprint', clearPrintTarget, { once: true });
  window.print();
}

function showApprovalConfirmation(user) {
  approvedMember = user;
  document.querySelector('#approved-member-name').textContent = user.fullName;
  document.querySelector('#approved-member-number').textContent = memberNumberLabel(user);
  approvalDialog.showModal();
}

function openMemberForm(user = null) {
  memberForm.reset();
  memberFormError.textContent = '';
  const passwordField = document.querySelector('#initial-password-field');
  const statusField = document.querySelector('#initial-status-field');
  const passwordInput = document.querySelector('#member-password');
  const passwordLabel = document.querySelector('#member-password-label');
  const passwordHint = document.querySelector('#member-password-hint');
  memberForm.dataset.memberId = user?.id || '';
  document.querySelector('#member-form-title').textContent = user ? 'Ubah data anggota' : 'Tambah anggota';
  document.querySelector('#save-member').textContent = user ? 'Simpan perubahan' : 'Simpan anggota';
  passwordField.hidden = Boolean(user);
  statusField.hidden = Boolean(user);
  passwordInput.required = !user;
  passwordInput.placeholder = user ? 'Kosongkan bila tidak diubah' : '';
  passwordLabel.textContent = user ? 'Password baru (opsional)' : 'Password awal anggota';
  passwordHint.hidden = !user;
  if (user) {
    memberForm.elements.fullName.value = user.fullName;
    memberForm.elements.email.value = user.email;
    memberForm.elements.organization.value = user.organization || '';
    memberForm.elements.profession.value = user.profession || '';
  }
  memberFormDialog.showModal();
}

function openDeleteConfirmation(user) {
  deletingMemberId = user.id;
  deleteError.textContent = '';
  document.querySelector('#delete-member-name').textContent = user.fullName;
  deleteDialog.showModal();
}

function renderUsers(users) {
  currentUsers = users;
  tableBody.replaceChildren();
  document.querySelector('#empty-state').hidden = users.length > 0;

  for (const user of users) {
    const row = document.createElement('tr');
    const memberCell = document.createElement('td');
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = user.fullName;
    const email = document.createElement('span');
    email.className = 'member-email';
    email.textContent = user.email;
    memberCell.append(name, email);
    row.append(memberCell);
    appendCell(row, user.organization || '—');

    const photoCell = document.createElement('td');
    photoCell.append(user.hasPhoto ? makeAction('Lihat foto', 'photo', user.id) : document.createTextNode('—'));
    row.append(photoCell);

    const statusCell = document.createElement('td');
    const status = document.createElement('span');
    status.className = `status-tag status-${user.status}`;
    status.textContent = { pending: 'Menunggu', active: 'Aktif', suspended: 'Ditangguhkan' }[user.status] || user.status;
    statusCell.append(status);
    row.append(statusCell);

    appendCell(row, new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium' }).format(new Date(user.createdAt)));
    const actionCell = document.createElement('td');
    if (user.id !== currentAdminId && user.status !== 'active') actionCell.append(makeAction(user.status === 'pending' ? 'Setujui' : 'Aktifkan', 'status', user.id, 'approve'));
    if (user.id !== currentAdminId && user.status !== 'suspended') actionCell.append(makeAction('Tangguhkan', 'status', user.id, 'suspend'));
    if (!actionCell.childElementCount) actionCell.textContent = user.id === currentAdminId ? 'Admin saat ini' : '—';
    if (user.status === 'active' && user.roleCodes.includes('member')) {
      actionCell.append(makeAction('Buat KTA', 'kta', user.id, 'kta'));
    }
    if (user.roleCodes.includes('member')) {
      actionCell.append(makeAction('Ubah', 'edit', user.id, 'edit'));
      actionCell.append(makeAction('Hapus', 'delete', user.id, 'delete'));
    }
    row.append(actionCell);
    tableBody.append(row);
  }
}

async function loadUsers() {
  setNotice(dashboardNotice, '');
  const params = new URLSearchParams({
    status: statusFilter.value,
    q: searchInput.value.trim(),
    page: String(currentPage)
  });
  try {
    const result = await requestJson(`/api/admin/users?${params}`);
    renderUsers(result.users);
    document.querySelector('#count-total').textContent = result.counts.total;
    document.querySelector('#count-pending').textContent = result.counts.pending;
    document.querySelector('#count-active').textContent = result.counts.active;
    document.querySelector('#count-suspended').textContent = result.counts.suspended;
    const start = result.total ? (result.page - 1) * result.pageSize + 1 : 0;
    const end = Math.min(result.page * result.pageSize, result.total);
    document.querySelector('#results-summary').textContent = `${start}-${end} dari ${result.total} pengguna`;
    document.querySelector('#page-label').textContent = `Halaman ${result.page}`;
    document.querySelector('#previous-page').disabled = result.page <= 1;
    document.querySelector('#next-page').disabled = end >= result.total;
  } catch (error) {
    if (error.message.startsWith('Sesi admin')) return showLogin('Sesi berakhir. Silakan masuk kembali.');
    setNotice(dashboardNotice, error.message, true);
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector('button[type="submit"]');
  button.disabled = true;
  setNotice(loginNotice, 'Memeriksa akun...');
  try {
    const result = await requestJson('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({
        email: loginForm.elements.email.value,
        password: loginForm.elements.password.value
      })
    });
    loginForm.reset();
    await showDashboard(result.admin);
  } catch (error) {
    setNotice(loginNotice, error.message, true);
  } finally {
    button.disabled = false;
  }
});

showPasswordResetButton.addEventListener('click', () => {
  loginForm.hidden = true;
  showPasswordResetButton.hidden = true;
  passwordResetForm.hidden = false;
  passwordResetForm.elements.resetToken.focus();
});

document.querySelector('#cancel-password-reset').addEventListener('click', () => {
  passwordResetForm.reset();
  passwordResetForm.hidden = true;
  loginForm.hidden = false;
  showPasswordResetButton.hidden = false;
  setNotice(passwordResetNotice, '');
});

passwordResetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setNotice(passwordResetNotice, 'Memproses reset password...');
  const submitButton = passwordResetForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const result = await requestJson('/api/admin/reset-password', {
      method: 'POST',
      body: JSON.stringify({
        resetToken: passwordResetForm.elements.resetToken.value,
        newPassword: passwordResetForm.elements.newPassword.value,
        passwordConfirm: passwordResetForm.elements.passwordConfirm.value
      })
    });
    passwordResetForm.reset();
    passwordResetForm.hidden = true;
    loginForm.hidden = false;
    showPasswordResetButton.hidden = false;
    setNotice(loginNotice, result.message);
  } catch (error) {
    setNotice(passwordResetNotice, error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  try {
    await requestJson('/api/admin/logout', { method: 'POST', body: '{}' });
    showLogin('Anda sudah keluar dari panel admin.');
  } catch (error) {
    setNotice(dashboardNotice, error.message, true);
  }
});

filterForm.addEventListener('submit', (event) => {
  event.preventDefault();
  currentPage = 1;
  loadUsers();
});

viewMembersButton.addEventListener('click', () => {
  setAdminView('members');
  statusFilter.value = 'all';
  searchInput.value = '';
  currentPage = 1;
  loadUsers();
  document.querySelector('.member-management').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
addMemberButton.addEventListener('click', () => openMemberForm());
document.querySelectorAll('[data-admin-view]').forEach((tab) => {
  tab.addEventListener('click', () => setAdminView(tab.dataset.adminView));
});
document.querySelector('#account-search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  loadAccounts();
});
accountsTableBody.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action="role"]');
  if (!button) return;
  const roleSelect = accountsTableBody.querySelector(`select[data-user-id="${button.dataset.userId}"]`);
  button.disabled = true;
  try {
    const result = await requestJson(`/api/admin/accounts/${button.dataset.userId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role: roleSelect.value })
    });
    await Promise.all([loadAccounts(), loadUsers()]);
    setNotice(dashboardNotice, `Role ${result.roleName} berhasil disimpan.`);
  } catch (error) {
    setNotice(dashboardNotice, error.message, true);
  } finally {
    button.disabled = false;
  }
});
contentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  contentError.textContent = '';
  const button = contentForm.querySelector('button[type="submit"]');
  button.disabled = true;
  const content = Object.fromEntries(editableContentKeys.map((key) => [key, contentForm.elements[key].value]));
  try {
    await requestJson('/api/admin/content', { method: 'PUT', body: JSON.stringify({ content }) });
    setNotice(dashboardNotice, 'Konten portal berhasil diperbarui.');
  } catch (error) {
    contentError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
document.querySelector('#close-member-form').addEventListener('click', () => memberFormDialog.close());
document.querySelector('#cancel-member-form').addEventListener('click', () => memberFormDialog.close());

memberForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  memberFormError.textContent = '';
  const memberId = memberForm.dataset.memberId;
  const payload = new FormData();
  for (const field of ['fullName', 'email', 'organization', 'profession']) payload.set(field, memberForm.elements[field].value);
  if (!memberId) {
    payload.set('password', memberForm.elements.password.value);
    payload.set('status', memberForm.elements.status.value);
  } else if (memberForm.elements.password.value) {
    payload.set('password', memberForm.elements.password.value);
  }
  const photo = memberForm.elements.memberPhoto.files[0];
  if (photo) payload.set('memberPhoto', photo);

  const saveButton = document.querySelector('#save-member');
  saveButton.disabled = true;
  try {
    const result = await requestJson(memberId ? `/api/admin/users/${memberId}` : '/api/admin/users', {
      method: memberId ? 'PUT' : 'POST',
      body: payload
    });
    memberFormDialog.close();
    memberForm.reset();
    memberForm.dataset.memberId = '';
    await loadUsers();
    setNotice(dashboardNotice, memberId ? 'Data anggota berhasil diperbarui.' : `Anggota ${result.user.full_name || result.user.fullName} berhasil ditambahkan.`);
  } catch (error) {
    memberFormError.textContent = error.message;
  } finally {
    saveButton.disabled = false;
  }
});

document.querySelector('#cancel-delete').addEventListener('click', () => deleteDialog.close());
deleteDialog.addEventListener('click', (event) => {
  if (event.target === deleteDialog) deleteDialog.close();
});
deleteDialog.addEventListener('close', () => { deletingMemberId = ''; });
document.querySelector('#confirm-delete').addEventListener('click', async (event) => {
  if (!deletingMemberId) return;
  const button = event.currentTarget;
  button.disabled = true;
  deleteError.textContent = '';
  try {
    await requestJson(`/api/admin/users/${deletingMemberId}`, { method: 'DELETE' });
    deleteDialog.close();
    await loadUsers();
    setNotice(dashboardNotice, 'Data anggota dan foto terkait berhasil dihapus.');
  } catch (error) {
    deleteError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#previous-page').addEventListener('click', () => {
  if (currentPage > 1) { currentPage -= 1; loadUsers(); }
});
document.querySelector('#next-page').addEventListener('click', () => {
  currentPage += 1;
  loadUsers();
});

tableBody.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  if (button.dataset.action === 'kta') {
    const user = currentUsers.find((item) => item.id === button.dataset.userId);
    if (user) showKta(user);
    return;
  }
  if (button.dataset.action === 'photo') {
    photoPreview.src = `/api/admin/users/${button.dataset.userId}/photo`;
    photoDialog.showModal();
    return;
  }
  if (button.dataset.action === 'edit' || button.dataset.action === 'delete') {
    const member = currentUsers.find((item) => item.id === button.dataset.userId);
    if (!member) return;
    if (button.dataset.action === 'edit') openMemberForm(member);
    else openDeleteConfirmation(member);
    return;
  }

  const member = currentUsers.find((item) => item.id === button.dataset.userId);
  const nextStatus = button.classList.contains('suspend') ? 'suspended' : 'active';
  button.disabled = true;
  try {
    await requestJson(`/api/admin/users/${button.dataset.userId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: nextStatus })
    });
    if (nextStatus === 'active' && member?.status === 'pending') {
      const approvedMemberData = { ...member, status: 'active' };
      await loadUsers();
      showApprovalConfirmation(approvedMemberData);
      return;
    }
    setNotice(dashboardNotice, nextStatus === 'active' ? 'Status anggota berhasil diaktifkan.' : 'Status anggota berhasil ditangguhkan.');
    await loadUsers();
  } catch (error) {
    button.disabled = false;
    setNotice(dashboardNotice, error.message, true);
  }
});

function closePhotoDialog() {
  photoDialog.close();
  photoPreview.removeAttribute('src');
}

document.querySelector('#close-photo').addEventListener('click', closePhotoDialog);
photoDialog.addEventListener('click', (event) => {
  if (event.target === photoDialog) closePhotoDialog();
});
photoDialog.addEventListener('close', () => photoPreview.removeAttribute('src'));

function closeApprovalDialog() {
  approvalDialog.close();
  approvedMember = null;
}
document.querySelector('#approval-close').addEventListener('click', closeApprovalDialog);
document.querySelector('#approval-kta').addEventListener('click', () => {
  if (!approvedMember) return;
  const member = approvedMember;
  closeApprovalDialog();
  showKta(member);
});
document.querySelector('#approval-certificate').addEventListener('click', () => {
  if (!approvedMember) return;
  const member = approvedMember;
  closeApprovalDialog();
  showCertificate(member);
});
approvalDialog.addEventListener('click', (event) => {
  if (event.target === approvalDialog) closeApprovalDialog();
});

function closeKtaDialog() {
  ktaDialog.close();
  ktaPhoto.removeAttribute('src');
  ktaQr.removeAttribute('src');
  ktaQr.hidden = true;
  ktaDownloadButton.disabled = true;
  ktaQrUserId = '';
}
document.querySelector('#close-kta').addEventListener('click', closeKtaDialog);
document.querySelector('#close-kta-footer').addEventListener('click', closeKtaDialog);
document.querySelector('#print-kta').addEventListener('click', () => printDocument('kta'));
document.querySelector('#download-kta-qr').addEventListener('click', () => {
  if (!ktaQrUserId) return;
  const link = document.createElement('a');
  link.href = `/api/admin/users/${ktaQrUserId}/qr/download`;
  document.body.appendChild(link);
  link.click();
  link.remove();
});
ktaDialog.addEventListener('click', (event) => {
  if (event.target === ktaDialog) closeKtaDialog();
});
ktaDialog.addEventListener('close', () => {
  ktaPhoto.removeAttribute('src');
  ktaQr.removeAttribute('src');
  ktaQr.hidden = true;
  ktaDownloadButton.disabled = true;
  ktaQrUserId = '';
});

function closeCertificateDialog() {
  certificateDialog.close();
}
document.querySelector('#close-certificate').addEventListener('click', closeCertificateDialog);
document.querySelector('#certificate-close-footer').addEventListener('click', closeCertificateDialog);
document.querySelector('#print-certificate').addEventListener('click', () => printDocument('certificate'));
certificateDialog.addEventListener('click', (event) => {
  if (event.target === certificateDialog) closeCertificateDialog();
});

requestJson('/api/admin/me')
  .then((result) => showDashboard(result.admin))
  .catch(() => showLogin());