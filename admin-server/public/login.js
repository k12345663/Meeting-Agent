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

  let currentEmail = '';

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
