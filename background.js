chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return;

  if (message.action === 'deepread_get_tab_id') {
    try {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      sendResponse({ ok: true, tabId });
    } catch (err) {
      sendResponse({ ok: false, tabId: null, error: String(err && err.message ? err.message : err) });
    }
    return true;
  }

  if (message.action !== 'deepread_send_feishu_webhook') return;

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

chrome.tabs.onRemoved.addListener((tabId) => {
  const key = `deepread_chat_history_tab_${tabId}`;

  try {
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.remove([key]).catch(() => {
        // ignore
      });
    }
  } catch (e) {
    // ignore
  }

  try {
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove([key]).catch(() => {
        // ignore
      });
    }
  } catch (e) {
    // ignore
  }
});
