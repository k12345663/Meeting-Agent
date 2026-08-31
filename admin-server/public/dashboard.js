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
  const whoami = document.getElementById('whoami');

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

  loadWhoAmI();
  loadFlags();
  loadSettings();
  loadAdmins();
})();
