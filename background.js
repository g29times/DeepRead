chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.action !== 'deepread_send_feishu_webhook') return;

  (async () => {
    try {
      const { webhookUrl, payload } = message;
      if (!webhookUrl) throw new Error('Missing webhookUrl');

      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      sendResponse({ ok: true });
    } catch (err) {
      console.warn('DeepRead background: send feishu webhook failed:', err);
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();

  return true;
});
