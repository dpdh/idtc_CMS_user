// Halaman pendaftaran anggota (publik). Menggunakan API yang sama dengan app mobile: POST /api/v1/auth/register.
const form = document.getElementById('register-form');
const errorBox = document.getElementById('error-box');
const submitButton = document.getElementById('submit-button');
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function markInvalid(input, invalid) {
  input.classList.toggle('invalid', invalid);
}

function showError(message, field) {
  errorBox.textContent = message;
  errorBox.style.display = 'block';
  for (const input of form.querySelectorAll('input')) {
    markInvalid(input, Boolean(field) && input.name === field);
  }
}

function clearError() {
  errorBox.style.display = 'none';
  for (const input of form.querySelectorAll('input')) markInvalid(input, false);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  const name = form.name.value.trim();
  const email = form.email.value.trim().toLowerCase();
  const phone = form.phone.value.trim();
  const password = form.password.value;
  const passwordConfirmation = form.passwordConfirmation.value;

  if (!name) return showError('Nama lengkap wajib diisi.', 'name');
  if (!EMAIL_PATTERN.test(email)) return showError('Format email tidak valid.', 'email');
  if (password.length < 6) return showError('Kata sandi minimal 6 karakter.', 'password');
  if (password !== passwordConfirmation) return showError('Konfirmasi kata sandi tidak cocok.', 'passwordConfirmation');

  submitButton.disabled = true;
  submitButton.textContent = 'Mendaftarkan…';
  try {
    const response = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        email,
        ...(phone ? { phone } : {}),
        password,
        passwordConfirmation
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showError(payload.error || 'Pendaftaran gagal. Coba lagi.', payload.field);
      return;
    }
    document.getElementById('success-name').textContent = payload.data.user.name;
    document.getElementById('success-email').textContent = payload.data.user.email;
    document.getElementById('success-number').textContent = payload.data.user.memberNumber || '-';
    document.getElementById('form-panel').style.display = 'none';
    document.getElementById('success-panel').style.display = 'block';
  } catch {
    showError('Tidak dapat terhubung ke server. Periksa koneksi Anda.');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Daftar sekarang';
  }
});
