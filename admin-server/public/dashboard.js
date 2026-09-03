(function () {
  // Known config fields the desktop/web app actually reads. Rendered even if
  // never saved yet, so the admin sees the full shape of what's configurable
  // rather than an empty list that only grows as things get touched once.
  const KNOWN_SETTINGS = [
    { key: 'gemini_api_key', label: 'Gemini API Key', secret: true, placeholder: 'AIza…' },
    { key: 'azure_speech_key', label: 'Azure Speech Key', secret: true, placeholder: 'optional' },
    { key: 'azure_speech_region', label: 'Azure Speech Region', secret: false, placeholder: 'e.g. eastus' },
    { key: 'whisper_model', label: 'Whisper Model', secret: false, placeholder: 'tiny / base / small / medium / large' },
    { key: 'whisper_language', label: 'Whisper Language', secret: false, placeholder: 'en' }
  ];

  const flagsList = document.getElementById('flagsList');
  const settingsList = document.getElementById('settingsList');
  const adminsList = document.getElementById('adminsList');
  const usersList = document.getElementById('usersList');
  const whoami = document.getElementById('whoami');
  const passwordStatus = document.getElementById('passwordStatus');
  const setPasswordForm = document.getElementById('setPasswordForm');
  const newPasswordInput = document.getElementById('newPassword');
  const setPasswordBtn = document.getElementById('setPasswordBtn');
  const passwordMsg = document.getElementById('passwordMsg');
  const clearPasswordBtn = document.getElementById('clearPasswordBtn');

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    if (res.status === 401) {
      window.location.href = '/index.html';
      throw new Error('Not signed in');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function loadWhoAmI() {
    try {
      const data = await api('/api/auth/me');
      whoami.textContent = data.email;
      passwordStatus.textContent = data.hasPassword
        ? 'A password is set — you can sign in with either it or a one-time code.'
        : 'No password set yet — you sign in with a one-time code only.';
      setPasswordBtn.textContent = data.hasPassword ? 'Change password' : 'Set password';
      clearPasswordBtn.style.display = data.hasPassword ? 'inline' : 'none';
    } catch (e) { /* redirected already */ }
  }

  async function loadFlags() {
    const { flags } = await api('/api/admin/feature-flags');
    flagsList.innerHTML = '';
    flags.forEach((flag) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div>
          <div class="row-label">${flag.label}</div>
          <div class="row-sub">${flag.key}</div>
        </div>
        <div class="toggle ${flag.enabled ? 'on' : ''}" data-key="${flag.key}"><div class="knob"></div></div>
      `;
      flagsList.appendChild(row);
    });
    flagsList.querySelectorAll('.toggle').forEach((toggle) => {
      toggle.addEventListener('click', async () => {
        const key = toggle.dataset.key;
        const enabled = !toggle.classList.contains('on');
        toggle.classList.toggle('on', enabled);
        try {
          await api(`/api/admin/feature-flags/${key}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
        } catch (e) {
          toggle.classList.toggle('on', !enabled); // revert on failure
          alert('Failed to update: ' + e.message);
        }
      });
    });
  }

  async function loadSettings() {
    const { settings, emailConfigured } = await api('/api/admin/settings');
    const byKey = Object.fromEntries(settings.map((s) => [s.key, s]));

    settingsList.innerHTML = '';
    if (!emailConfigured) {
      const warn = document.createElement('div');
      warn.className = 'msg error';
      warn.style.marginBottom = '16px';
      warn.textContent = 'Zoho SMTP isn’t configured yet — OTP codes are only printed to the server console. Set ZOHO_SMTP_USER / ZOHO_SMTP_PASS in admin-server/.env to send real emails.';
      settingsList.appendChild(warn);
    }

    KNOWN_SETTINGS.forEach((field) => {
      const saved = byKey[field.key];
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div>
          <div class="row-label">${field.label}</div>
          <div class="row-sub">${saved ? 'Last updated ' + saved.updated_at + (saved.updated_by ? ' by ' + saved.updated_by : '') : 'Not set'}</div>
        </div>
        <div class="settings-input-row">
          <input type="${field.secret ? 'password' : 'text'}" data-key="${field.key}"
                 placeholder="${saved && saved.value ? saved.value : field.placeholder}" />
          <button class="btn-sm save-setting" data-key="${field.key}">Save</button>
        </div>
      `;
      settingsList.appendChild(row);
    });

    settingsList.querySelectorAll('.save-setting').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.key;
        const input = settingsList.querySelector(`input[data-key="${key}"]`);
        const value = input.value.trim();
        if (!value) return;
        btn.textContent = 'Saving…';
        btn.disabled = true;
        try {
          await api(`/api/admin/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) });
          input.value = '';
          await loadSettings();
        } catch (e) {
          alert('Failed to save: ' + e.message);
        } finally {
          btn.textContent = 'Save';
          btn.disabled = false;
        }
      });
    });
  }

  async function loadAdmins() {
    const { admins } = await api('/api/admin/admins');
    adminsList.innerHTML = '';
    admins.forEach((admin) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div>
          <div class="row-label">${admin.email}</div>
          <div class="row-sub">Added ${admin.created_at}</div>
        </div>
        <button class="btn-sm danger" data-id="${admin.id}">Remove</button>
      `;
      adminsList.appendChild(row);
    });
    adminsList.querySelectorAll('button[data-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this admin?')) return;
        try {
          await api(`/api/admin/admins/${btn.dataset.id}`, { method: 'DELETE' });
          await loadAdmins();
        } catch (e) {
          alert('Failed to remove: ' + e.message);
        }
      });
    });
  }

  async function loadUsers() {
    const { users } = await api('/api/admin/users');
    usersList.innerHTML = '';
    if (!users.length) {
      usersList.innerHTML = '<div class="row-sub">No app users yet — add one below.</div>';
    }
    users.forEach((user) => {
      const row = document.createElement('div');
      row.className = 'row';
      const lastLogin = user.last_login_at ? `Last login ${user.last_login_at}` : 'Never logged in';
      row.innerHTML = `
        <div>
          <div class="row-label">${user.email}</div>
          <div class="row-sub">Added ${user.created_at} · ${lastLogin}</div>
        </div>
        <div style="display:flex; align-items:center; gap:12px;">
          <div class="toggle ${user.enabled ? 'on' : ''}" data-id="${user.id}" title="Enabled"><div class="knob"></div></div>
          <button class="btn-sm danger" data-remove-id="${user.id}">Remove</button>
        </div>
      `;
      usersList.appendChild(row);
    });
    usersList.querySelectorAll('.toggle[data-id]').forEach((toggle) => {
      toggle.addEventListener('click', async () => {
        const id = toggle.dataset.id;
        const enabled = !toggle.classList.contains('on');
        toggle.classList.toggle('on', enabled);
        try {
          await api(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
          await loadUsers();
        } catch (e) {
          toggle.classList.toggle('on', !enabled);
          alert('Failed to update: ' + e.message);
        }
      });
    });
    usersList.querySelectorAll('button[data-remove-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this user? They will no longer be able to sign into the app.')) return;
        try {
          await api(`/api/admin/users/${btn.dataset.removeId}`, { method: 'DELETE' });
          await loadUsers();
        } catch (e) {
          alert('Failed to remove: ' + e.message);
        }
      });
    });
  }

  document.getElementById('addUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('newUserEmail');
    try {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ email: input.value.trim() }) });
      input.value = '';
      await loadUsers();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('addAdminForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('newAdminEmail');
    try {
      await api('/api/admin/admins', { method: 'POST', body: JSON.stringify({ email: input.value.trim() }) });
      input.value = '';
      await loadAdmins();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = '/index.html';
  });

  setPasswordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    passwordMsg.innerHTML = '';
    const idleText = setPasswordBtn.textContent;
    setPasswordBtn.disabled = true;
    setPasswordBtn.textContent = 'Saving…';
    try {
      await api('/api/auth/set-password', { method: 'POST', body: JSON.stringify({ password: newPasswordInput.value }) });
      newPasswordInput.value = '';
      passwordMsg.innerHTML = '<div class="msg success">Password saved.</div>';
      await loadWhoAmI();
    } catch (err) {
      passwordMsg.innerHTML = `<div class="msg error">${err.message}</div>`;
    } finally {
      setPasswordBtn.disabled = false;
      setPasswordBtn.textContent = idleText;
    }
  });

  clearPasswordBtn.addEventListener('click', async () => {
    if (!confirm('Remove your password? You will only be able to sign in with a one-time code afterward.')) return;
    try {
      await api('/api/auth/clear-password', { method: 'POST' });
      await loadWhoAmI();
    } catch (err) {
      alert(err.message);
    }
  });

  loadWhoAmI();
  loadFlags();
  loadSettings();
  loadUsers();
  loadAdmins();
})();
