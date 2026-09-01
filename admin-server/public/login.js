(function () {
  const emailForm = document.getElementById('emailForm');
  const otpForm = document.getElementById('otpForm');
  const emailInput = document.getElementById('email');
  const otpInput = document.getElementById('otp');
  const msgBox = document.getElementById('msgBox');
  const emailBtn = document.getElementById('emailBtn');
  const otpBtn = document.getElementById('otpBtn');
  const resendBtn = document.getElementById('resendBtn');
  const title = document.getElementById('title');
  const subtitle = document.getElementById('subtitle');
  const passwordField = document.getElementById('passwordField');
  const passwordInput = document.getElementById('password');
  const toggleModeBtn = document.getElementById('toggleModeBtn');

  let currentEmail = '';
  let passwordMode = false;

  toggleModeBtn.addEventListener('click', () => {
    passwordMode = !passwordMode;
    passwordField.style.display = passwordMode ? 'block' : 'none';
    passwordInput.required = passwordMode;
    emailBtn.textContent = passwordMode ? 'Sign in' : 'Send code';
    toggleModeBtn.textContent = passwordMode ? 'Use a one-time code instead' : 'Use a password instead';
    clearMsg();
  });

  function showMsg(text, kind) {
    msgBox.innerHTML = `<div class="msg ${kind}">${text}</div>`;
  }
  function clearMsg() {
    msgBox.innerHTML = '';
  }

  async function requestOtp(email) {
    const res = await fetch('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send code');
    return data;
  }

  emailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMsg();
    const email = emailInput.value.trim();

    if (passwordMode) {
      const idleText = 'Sign in';
      emailBtn.disabled = true;
      emailBtn.textContent = 'Signing in…';
      try {
        const res = await fetch('/api/auth/login-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: passwordInput.value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Sign in failed');
        window.location.href = '/dashboard.html';
      } catch (err) {
        showMsg(err.message, 'error');
      } finally {
        emailBtn.disabled = false;
        emailBtn.textContent = idleText;
      }
      return;
    }

    emailBtn.disabled = true;
    emailBtn.textContent = 'Sending…';
    try {
      await requestOtp(email);
      currentEmail = email;
      title.textContent = 'Enter your code';
      subtitle.textContent = `We sent a 6-digit code to ${email}.`;
      emailForm.style.display = 'none';
      otpForm.style.display = 'block';
      otpInput.focus();
    } catch (err) {
      showMsg(err.message, 'error');
    } finally {
      emailBtn.disabled = false;
      emailBtn.textContent = 'Send code';
    }
  });

  otpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMsg();
    otpBtn.disabled = true;
    otpBtn.textContent = 'Verifying…';
    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: currentEmail, code: otpInput.value.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');
      window.location.href = '/dashboard.html';
    } catch (err) {
      showMsg(err.message, 'error');
    } finally {
      otpBtn.disabled = false;
      otpBtn.textContent = 'Verify & Sign In';
    }
  });

  resendBtn.addEventListener('click', async () => {
    clearMsg();
    resendBtn.disabled = true;
    try {
      await requestOtp(currentEmail);
      showMsg('A new code was sent.', 'success');
    } catch (err) {
      showMsg(err.message, 'error');
    } finally {
      resendBtn.disabled = false;
    }
  });
})();
