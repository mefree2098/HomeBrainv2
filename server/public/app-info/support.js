(() => {
  'use strict';

  const form = document.getElementById('support-request-form');
  const submitButton = document.getElementById('support-submit');
  const status = document.getElementById('support-status');
  if (!form || !submitButton || !status) return;

  function showStatus(message, type) {
    status.textContent = message;
    status.className = `form-status ${type || ''}`.trim();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showStatus('', '');

    if (!form.reportValidity()) return;

    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    submitButton.disabled = true;
    submitButton.textContent = 'Sending…';

    try {
      const response = await fetch('/api/public/support-requests', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.message || 'Your support request could not be sent. Please try again.');
      }

      form.reset();
      showStatus(result.message || 'Your support request was sent.', 'success');
    } catch (error) {
      showStatus(error.message || 'Your support request could not be sent. Please try again.', 'error');
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Send support request';
    }
  });
})();
