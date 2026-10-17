const heading = document.querySelector('#verify-heading');
const description = document.querySelector('#verify-description');
const symbol = document.querySelector('#verify-symbol');
const memberData = document.querySelector('#member-data');

function showInvalid(error) {
  symbol.className = 'verify-symbol invalid';
  symbol.textContent = '!';
  heading.textContent = 'Keanggotaan tidak ditemukan';
  description.textContent = error || 'Kode QR tidak terdaftar di direktori resmi IDTC.';
}

async function verifyMembership() {
  const memberId = window.location.pathname.split('/').filter(Boolean).at(-1);
  if (!memberId) return showInvalid();

  try {
    const response = await fetch(`/api/members/verify/${encodeURIComponent(memberId)}`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) return showInvalid(result.error);

    const member = result.member;
    const isActive = member.status === 'active';
    symbol.className = `verify-symbol ${isActive ? 'active' : 'inactive'}`;
    symbol.textContent = isActive ? 'ID' : '!';
    heading.textContent = isActive ? 'Anggota terverifikasi' : 'Status anggota belum aktif';
    description.textContent = isActive
      ? 'Kartu ini tercatat pada direktori resmi Indonesia Digital Twin Community.'
      : 'Data kartu tercatat, tetapi statusnya belum aktif di direktori IDTC.';
    document.querySelector('#member-name').textContent = member.fullName;
    document.querySelector('#member-number').textContent = member.memberNumber;
    document.querySelector('#member-organization').textContent = member.organization || '—';
    document.querySelector('#member-status').textContent = {
      active: 'Aktif', pending: 'Menunggu verifikasi', suspended: 'Ditangguhkan'
    }[member.status] || member.status;
    document.querySelector('#member-since').textContent = new Intl.DateTimeFormat('id-ID', { dateStyle: 'long' }).format(new Date(member.memberSince));
    memberData.hidden = false;
  } catch {
    showInvalid('Direktori IDTC tidak dapat dihubungi. Periksa koneksi dan coba lagi.');
  }
}

verifyMembership();