let activeTabId = null;
let lastConceptName = '';
let lastConceptExplanation = '';
let lastSummary = '';
let lastSeenTabUrl = '';
let __localChatHistory = [];
let __selectedImages = [];
let __selectedFiles = [];
let __analysisCollapsed = false;
let __chatSearchQuery = '';
let __chatSearchHits = [];
let __chatSearchIndex = -1;
let __chatSearchMarks = [];
const DRSP_FONT_SIZE_KEY = 'deepread_sp_font_size_px';
const DRSP_FONT_SIZE_OPTIONS = [12, 14, 16, 18];

function qs(id) {
  return document.getElementById(id);
}

function setSectionCollapsed(sectionBodyId, collapsed) {
  const body = qs(sectionBodyId);
  if (!body) return;
  body.style.display = collapsed ? 'none' : '';
}

function updateToggleButton(btnId, collapsed) {
  const btn = qs(btnId);
  if (!btn) return;
  btn.textContent = collapsed ? '展开' : '折叠';
}

function toggleAnalysis() {
  __analysisCollapsed = !__analysisCollapsed;
  setSectionCollapsed('drsp-analysis-body', __analysisCollapsed);
  updateToggleButton('drsp-toggle-analysis', __analysisCollapsed);
}

function normalizeFontSizePx(px) {
  const n = Number(px);
  if (!Number.isFinite(n)) return 14;
  const v = Math.round(n);
  if (DRSP_FONT_SIZE_OPTIONS.includes(v)) return v;
  // 找最近档位
  let best = 14;
  let bestDist = Infinity;
  for (const opt of DRSP_FONT_SIZE_OPTIONS) {
    const d = Math.abs(opt - v);
    if (d < bestDist) {
      bestDist = d;
      best = opt;
    }
  }
  return best;
}

function applyFontSizePx(px) {
  const v = normalizeFontSizePx(px);
  document.documentElement.style.setProperty('--drsp-font-size', `${v}px`);
  const sel = qs('drsp-font-select');
  if (sel) sel.value = String(v);
  return v;
}

async function loadFontSizeSetting() {
  applyFontSizePx(14);
  try {
    const obj = await chrome.storage.local.get([DRSP_FONT_SIZE_KEY]);
    const px = obj && obj[DRSP_FONT_SIZE_KEY];
    applyFontSizePx(px);
  } catch (e) {
    applyFontSizePx(14);
  }
}

let __saveFontTimer = null;
function scheduleSaveFontSize(px) {
  try {
    if (__saveFontTimer) clearTimeout(__saveFontTimer);
    __saveFontTimer = setTimeout(async () => {
      try {
        await chrome.storage.local.set({ [DRSP_FONT_SIZE_KEY]: px });
      } catch (e) {
        // ignore
      }
    }, 120);
  } catch (e) {
    // ignore
  }
}

function bindTabSyncEvents() {
  try {
    chrome.tabs.onActivated.addListener(async () => {
      await forceUpdateActiveTabId();
      try {
        lastSeenTabUrl = await getActiveTabUrl();
      } catch (e) {
        // ignore
      }
      await refreshState();
    });

    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
      // 当前活动 tab 导航完成后刷新；避免加载中频繁刷新
      if (typeof activeTabId !== 'number' || tabId !== activeTabId) return;
      if (changeInfo && changeInfo.status === 'complete') {
        await forceUpdateActiveTabId();
        await refreshState();
      }
    });
  } catch (e) {
    // ignore
  }
}

function startUrlWatcher() {
  try {
    setInterval(async () => {
      try {
        const url = await getActiveTabUrl();
        if (url && url !== lastSeenTabUrl) {
          lastSeenTabUrl = url;
          await hardRefresh();
        }
      } catch (e) {
        // ignore
      }
    }, 900);
  } catch (e) {
    // ignore
  }
}

let __configChangedTimer = null;
function bindConfigAutoRefresh() {
  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') return;
      if (!changes) return;
      const keys = Object.keys(changes);
      const watched = new Set([
        'deepread_api_key',
        'deepread_model',
        'deepread_thinking_level',
        'deepread_feishu_webhook_url',
      ]);
      const hit = keys.some((k) => watched.has(k));
      if (!hit) return;

      if (__configChangedTimer) clearTimeout(__configChangedTimer);
      __configChangedTimer = setTimeout(async () => {
        try {
          await refreshState();
        } catch (e) {
          // ignore
        }
      }, 180);
    });
  } catch (e) {
    // ignore
  }
}

async function insertSummaryToChat() {
  if (!lastSummary) {
    alert('当前没有可插入的全文解释。');
    return;
  }
  const rawMessage = `全文解释：\n${lastSummary}`;
  const resp = await sendToContent('deepread_sp_append_chat_message', { role: 'assistant', rawMessage });
  if (resp && resp.ok) {
    renderChat(resp.chatHistory || []);
  } else {
    await refreshState();
  }
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  activeTabId = tab && typeof tab.id === 'number' ? tab.id : null;
  return activeTabId;
}

async function forceUpdateActiveTabId() {
  activeTabId = null;
  return await getActiveTabId();
}

async function getActiveTabUrl() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  const url = tab && tab.url ? String(tab.url) : '';
  return url;
}

async function sendToContent(action, payload = {}) {
  const tabId = await getActiveTabId();
  if (typeof tabId !== 'number') throw new Error('No active tab');

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action, ...payload }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function extractHttpErrorMessage(input) {
  const raw = (input == null) ? '' : String(input);
  const s = raw.trim();
  if (!s) return '';
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed) && parsed[0] && parsed[0].error && parsed[0].error.message) {
      return String(parsed[0].error.message);
    }
    if (parsed && parsed.error && parsed.error.message) {
      return String(parsed.error.message);
    }
  } catch (e) {
    // ignore
  }
  return s;
}

function showErrorDialog(title, detail) {
  const msg = extractHttpErrorMessage(detail);
  const head = title ? String(title) : '请求失败';
  const body = msg ? `\n\n${msg}` : '';
  alert(`${head}${body}`);
}

let __drspShowdownConverter = null;
function getShowdownConverter() {
  try {
    if (__drspShowdownConverter) return __drspShowdownConverter;
    if (typeof showdown === 'undefined') return null;
    __drspShowdownConverter = new showdown.Converter({
      tables: true,
      simplifiedAutoLink: true,
      strikethrough: true,
      tasklists: true,
    });
    return __drspShowdownConverter;
  } catch (e) {
    return null;
  }
}

function renderMarkdownToHtml(mdText) {
  const s = String(mdText || '');
  const conv = getShowdownConverter();
  if (conv) {
    try {
      return conv.makeHtml(s);
    } catch (e) {
      // ignore
    }
  }
  return escapeHtml(s).replaceAll('\n', '<br/>');
}

function renderMeta(meta) {
  const el = qs('drsp-meta');
  if (!el) return;
  if (!meta) {
    el.textContent = '';
    return;
  }
  const title = meta.title ? String(meta.title) : '';
  const url = meta.url ? String(meta.url) : '';
  el.innerHTML = `${escapeHtml(title)}<br/>${escapeHtml(url)}`;
}

function renderChat(history) {
  const container = qs('drsp-messages');
  if (!container) return;
  container.innerHTML = '';
  (history || []).forEach((m) => {
    const messageId = m && m.messageId ? String(m.messageId) : '';
    const raw = String(m.rawMessage || m.message || '');

    const div = document.createElement('div');
    div.className = `drsp-msg ${m.role === 'user' ? 'drsp-msg-user' : 'drsp-msg-assistant'}`;

    const content = document.createElement('div');
    content.className = 'drsp-msg-content';
    if (m.role === 'assistant') {
      content.innerHTML = renderMarkdownToHtml(raw);
    } else {
      content.textContent = raw;
    }
    div.appendChild(content);

    const hasImages = m && Array.isArray(m.images) && m.images.length;
    const hasFiles = m && Array.isArray(m.attachments) && m.attachments.length;
    if (hasImages || hasFiles) {
      const attWrap = document.createElement('div');
      attWrap.className = 'drsp-msg-attachments';

      if (hasImages) {
        const imgs = document.createElement('div');
        imgs.className = 'drsp-msg-images';
        m.images.forEach((img) => {
          if (!img || !img.data) return;
          const item = document.createElement('div');
          item.className = 'drsp-msg-image-item';
          const el = document.createElement('img');
          el.src = img.data;
          el.alt = img.name || 'image';
          item.appendChild(el);
          imgs.appendChild(item);
        });
        attWrap.appendChild(imgs);
      }

      if (hasFiles) {
        const files = document.createElement('div');
        files.className = 'drsp-msg-files';
        m.attachments.forEach((f) => {
          if (!f || !f.name) return;
          const chip = document.createElement('div');
          chip.className = 'drsp-msg-file-chip';
          chip.textContent = f.name;
          files.appendChild(chip);
        });
        attWrap.appendChild(files);
      }

      div.appendChild(attWrap);
    }

    const actions = document.createElement('div');
    actions.className = 'drsp-msg-actions';
    // 加个“重试”按钮

    if (messageId) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'drsp-msg-action';
      retryBtn.textContent = '重试';
      retryBtn.addEventListener('click', async () => {
        try {
          const resp = await sendToContent('deepread_sp_chat_retry', { messageId });
          if (resp && resp.ok) {
            __localChatHistory = resp.chatHistory || [];
            renderChat(__localChatHistory);
          } else {
            showErrorDialog('重试失败', resp && resp.error ? resp.error : '');
            await refreshState();
          }
        } catch (e) {
          showErrorDialog('重试失败', e && e.message ? e.message : String(e));
        }
      });
      actions.appendChild(retryBtn);
    }

    const copyBtn = document.createElement('button');
    copyBtn.className = 'drsp-msg-action';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', async () => {
      await writeToClipboardWithFallback(raw);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'drsp-msg-action';
    delBtn.textContent = '删除';
    delBtn.disabled = !messageId;
    delBtn.addEventListener('click', async () => {
      if (!messageId) return;
      const ok = confirm('确认删除这条消息？');
      if (!ok) return;
      const resp = await sendToContent('deepread_sp_delete_chat_message', { messageId });
      if (resp && resp.ok) {
        renderChat(resp.chatHistory || []);
      } else {
        await refreshState();
      }
    });

    actions.appendChild(copyBtn);
    actions.appendChild(delBtn);
    div.appendChild(actions);

    container.appendChild(div);
  });
  try {
    container.scrollTop = container.scrollHeight;
  } catch (e) {
    // ignore
  }

  applyChatSearchHighlight();
}

function normalizeSearchText(s) {
  return String(s || '').toLowerCase();
}

function getChatMessageElements() {
  const container = qs('drsp-messages');
  if (!container) return [];
  return Array.from(container.querySelectorAll('.drsp-msg'));
}

function clearChatSearchMarks() {
  (__chatSearchMarks || []).forEach((mark) => {
    try {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
      parent.normalize();
    } catch (e) {
      // ignore
    }
  });
  __chatSearchMarks = [];
}

function applyChatSearchHighlight() {
  const q = normalizeSearchText(__chatSearchQuery);
  const els = getChatMessageElements();
  clearChatSearchMarks();

  const marks = [];
  els.forEach((el) => {
    el.classList.remove('drsp-msg-search-hit', 'drsp-msg-search-active');
    if (!q) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node && node.nodeValue && node.nodeValue.trim()) {
        textNodes.push(node);
      }
    }
    let hasHit = false;
    textNodes.forEach((node) => {
      const original = node.nodeValue;
      const lower = normalizeSearchText(original);
      let idx = lower.indexOf(q);
      if (idx === -1) return;
      hasHit = true;
      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      while (idx !== -1) {
        if (idx > lastIndex) {
          frag.appendChild(document.createTextNode(original.slice(lastIndex, idx)));
        }
        const span = document.createElement('span');
        span.className = 'drsp-search-mark';
        span.textContent = original.slice(idx, idx + q.length);
        frag.appendChild(span);
        marks.push(span);
        lastIndex = idx + q.length;
        idx = lower.indexOf(q, lastIndex);
      }
      if (lastIndex < original.length) {
        frag.appendChild(document.createTextNode(original.slice(lastIndex)));
      }
      node.parentNode.replaceChild(frag, node);
    });
    if (hasHit) {
      el.classList.add('drsp-msg-search-hit');
    }
  });

  __chatSearchMarks = marks;
  __chatSearchHits = marks;
  if (!marks.length) {
    __chatSearchIndex = -1;
  } else if (__chatSearchIndex < 0 || __chatSearchIndex >= marks.length) {
    __chatSearchIndex = 0;
  }
  updateChatSearchActive();
  updateChatSearchButtons();
}

function updateChatSearchActive() {
  (__chatSearchHits || []).forEach((el, idx) => {
    const parentMsg = el.closest('.drsp-msg');
    if (idx === __chatSearchIndex) {
      el.classList.add('drsp-search-mark-active');
      if (parentMsg) parentMsg.classList.add('drsp-msg-search-active');
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) {
        // ignore
      }
    } else {
      el.classList.remove('drsp-search-mark-active');
      if (parentMsg) parentMsg.classList.remove('drsp-msg-search-active');
    }
  });
}

function updateChatSearchButtons() {
  const prevBtn = qs('drsp-chat-search-prev');
  const nextBtn = qs('drsp-chat-search-next');
  const hasHits = __chatSearchHits && __chatSearchHits.length > 0;
  const disabled = !hasHits;
  if (prevBtn) prevBtn.disabled = disabled;
  if (nextBtn) nextBtn.disabled = disabled;
}

function performChatSearch(query) {
  __chatSearchQuery = String(query || '');
  applyChatSearchHighlight();
}

function gotoNextSearchHit(delta) {
  if (!__chatSearchHits || !__chatSearchHits.length) return;
  const len = __chatSearchHits.length;
  __chatSearchIndex = (__chatSearchIndex + delta + len) % len;
  updateChatSearchActive();
  updateChatSearchButtons();
}

function renderUploadPreview() {
  const container = qs('drsp-upload-preview');
  if (!container) return;

  const hasAny = (__selectedImages && __selectedImages.length) || (__selectedFiles && __selectedFiles.length);
  if (!hasAny) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';
  container.innerHTML = '';

  (__selectedImages || []).forEach((img) => {
    const wrap = document.createElement('div');
    wrap.className = 'drsp-preview-image';

    const el = document.createElement('img');
    el.src = img.data;
    wrap.appendChild(el);

    const rm = document.createElement('button');
    rm.className = 'drsp-preview-remove';
    rm.textContent = '×';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      __selectedImages = (__selectedImages || []).filter((x) => x.id !== img.id);
      renderUploadPreview();
    });
    wrap.appendChild(rm);

    container.appendChild(wrap);
  });

  (__selectedFiles || []).forEach((f) => {
    const chip = document.createElement('div');
    chip.className = 'drsp-preview-file';
    chip.title = f.name;
    chip.textContent = f.name;

    const rm = document.createElement('button');
    rm.className = 'drsp-preview-remove';
    rm.textContent = '×';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      __selectedFiles = (__selectedFiles || []).filter((x) => x.id !== f.id);
      renderUploadPreview();
    });
    chip.appendChild(rm);

    container.appendChild(chip);
  });
}

function resetUploads() {
  __selectedImages = [];
  __selectedFiles = [];
  renderUploadPreview();
}

function addImagesFromInput(files) {
  if (!files || !files.length) return;
  Array.from(files).forEach((file) => {
    if (!file || !file.type || !String(file.type).startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const id = `spimg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      __selectedImages.push({ id, data: String(e && e.target ? e.target.result : ''), name: file.name || '' });
      renderUploadPreview();
    };
    reader.readAsDataURL(file);
  });
}

function addImagesFromBlobs(blobs) {
  if (!blobs || !blobs.length) return;
  blobs.forEach((blob) => {
    if (!blob || !blob.type || !String(blob.type).startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const id = `spimg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const name = blob.name || 'pasted-image';
      __selectedImages.push({ id, data: String(e && e.target ? e.target.result : ''), name });
      renderUploadPreview();
    };
    reader.readAsDataURL(blob);
  });
}

function addFilesFromInput(files) {
  if (!files || !files.length) return;
  Array.from(files).forEach((file) => {
    if (!file) return;
    const id = `spfile_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    __selectedFiles.push({ id, name: file.name || 'file', file });
  });
  renderUploadPreview();
}

async function readSelectedFilesAsText() {
  const out = [];
  for (const it of (__selectedFiles || [])) {
    try {
      const file = it.file;
      if (!file) continue;
      const sizeLimit = 20 * 1024 * 1024; // 20MB
      if (typeof file.size === 'number' && file.size > sizeLimit) {
        const mb = (file.size / (1024 * 1024)).toFixed(2);
        out.push({ name: it.name, text: `[文件大小 ${mb}MB 过大（上限20MB），已跳过]` });
        continue;
      }
      const text = await file.text();
      out.push({ name: it.name, text: String(text || '') });
    } catch (e) {
      out.push({ name: it.name, text: '[读取失败]' });
    }
  }
  return out;
}

function renderParagraphs(containerId, paragraphs) {
  const container = qs(containerId);
  if (!container) return;
  container.innerHTML = '';

  (paragraphs || []).forEach((p) => {
    const pid = p && typeof p === 'object' ? p.id : String(p);
    const reason = p && typeof p === 'object' ? (p.reason || '') : '';
    const score = p && typeof p === 'object' ? p.relevanceScore : null;

    const wrap = document.createElement('div');
    wrap.className = 'drsp-paragraph';

    const top = document.createElement('div');
    top.className = 'drsp-paragraph-top';

    const left = document.createElement('div');
    left.className = 'drsp-paragraph-id';
    left.textContent = pid;

    const right = document.createElement('div');
    right.className = 'drsp-paragraph-score';
    if (typeof score === 'number') {
      right.textContent = `相关度 ${(Math.max(0, Math.min(1, score)) * 100).toFixed(0)}%`;
    }

    top.appendChild(left);
    top.appendChild(right);

    const reasonEl = document.createElement('div');
    reasonEl.className = 'drsp-paragraph-reason';
    reasonEl.textContent = String(reason || '');

    const actions = document.createElement('div');
    actions.className = 'drsp-paragraph-actions';

    const navBtn = document.createElement('button');
    navBtn.className = 'drsp-btn';
    navBtn.textContent = '跳转';
    navBtn.addEventListener('click', async () => {
      await sendToContent('deepread_sp_navigate', { paragraphId: pid });
    });

    const explainBtn = document.createElement('button');
    explainBtn.className = 'drsp-btn';
    explainBtn.textContent = '解释此段';
    explainBtn.addEventListener('click', async () => {
      await explainConcept(String(pid));
    });

    actions.appendChild(navBtn);
    actions.appendChild(explainBtn);

    wrap.appendChild(top);
    if (reason) wrap.appendChild(reasonEl);
    wrap.appendChild(actions);

    container.appendChild(wrap);
  });
}

function renderAnalysis(analysis) {
  lastSummary = (analysis && analysis.summary) ? String(analysis.summary) : '';
  qs('drsp-summary').textContent = lastSummary;

  const keyterms = qs('drsp-keyterms');
  if (keyterms) {
    keyterms.innerHTML = '';
    (analysis && analysis.keyTerms ? analysis.keyTerms : []).forEach((t) => {
      const chip = document.createElement('button');
      chip.className = 'drsp-chip';
      chip.textContent = String(t);
      chip.addEventListener('click', async () => {
        await explainConcept(String(t));
      });
      keyterms.appendChild(chip);
    });
  }

  renderParagraphs('drsp-keyparagraphs', analysis && analysis.keyParagraphs ? analysis.keyParagraphs : []);
}

function clearAnalysisUI() {
  lastSummary = '';
  lastConceptName = '';
  lastConceptExplanation = '';
  qs('drsp-summary').textContent = '';
  qs('drsp-keyterms').innerHTML = '';
  qs('drsp-keyparagraphs').innerHTML = '';
  qs('drsp-concept-title').textContent = '';
  qs('drsp-concept').textContent = '';
  qs('drsp-relatedparagraphs').innerHTML = '';
}

function openManualAnalyzeModal() {
  const overlay = document.createElement('div');
  overlay.className = 'drsp-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'drsp-modal';

  const title = document.createElement('div');
  title.className = 'drsp-modal-title';
  title.textContent = '手动分析';

  const desc = document.createElement('div');
  desc.className = 'drsp-modal-desc';
  desc.textContent = '适用于视频字幕、图片内容等页面无法提取正文的场景：把字幕/文本粘贴到下面，确认后将调用模型进行全文解读。';

  const textarea = document.createElement('textarea');
  textarea.className = 'drsp-modal-textarea';
  textarea.placeholder = '在此粘贴字幕或文本…';

  const actions = document.createElement('div');
  actions.className = 'drsp-modal-actions';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'drsp-btn';
  closeBtn.textContent = '关闭';

  const okBtn = document.createElement('button');
  okBtn.className = 'drsp-btn drsp-primary';
  okBtn.textContent = '确认分析';

  actions.appendChild(closeBtn);
  actions.appendChild(okBtn);

  modal.appendChild(title);
  modal.appendChild(desc);
  modal.appendChild(textarea);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const cleanup = () => {
    try { document.body.removeChild(overlay); } catch (e) { /* no-op */ }
  };

  closeBtn.addEventListener('click', cleanup);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup();
  });

  okBtn.addEventListener('click', async () => {
    const text = String(textarea.value || '').trim();
    if (!text) {
      alert('请输入要分析的文本。');
      return;
    }
    okBtn.disabled = true;
    closeBtn.disabled = true;
    okBtn.textContent = '分析中...';

    try {
      const resp = await sendToContent('deepread_sp_analyze_text', { text });
      if (resp && resp.ok) {
        if (resp.analysisResult) {
          renderAnalysis(resp.analysisResult);
        }
        await refreshState();
        cleanup();
      } else {
        alert(resp && resp.error ? String(resp.error) : '分析失败');
        okBtn.disabled = false;
        closeBtn.disabled = false;
        okBtn.textContent = '确认分析';
      }
    } catch (e) {
      alert(String(e && e.message ? e.message : e));
      okBtn.disabled = false;
      closeBtn.disabled = false;
      okBtn.textContent = '确认分析';
    }
  });

  setTimeout(() => {
    try { textarea.focus(); } catch (e) { /* no-op */ }
  }, 0);
}

function renderConcept(conceptName, resp) {
  qs('drsp-concept-title').textContent = conceptName ? String(conceptName) : '';
  qs('drsp-concept').textContent = resp && resp.explanation ? String(resp.explanation) : '';
  lastConceptName = conceptName ? String(conceptName) : '';
  lastConceptExplanation = resp && resp.explanation ? String(resp.explanation) : '';
  renderParagraphs('drsp-relatedparagraphs', resp && resp.relatedParagraphs ? resp.relatedParagraphs : []);
}

async function refreshState() {
  const resp = await sendToContent('deepread_sp_get_state');
  if (resp && resp.ok) {
    renderMeta(resp.pageMeta);
    __localChatHistory = resp.chatHistory || [];
    renderChat(__localChatHistory);
    if (resp.analysisResult) {
      renderAnalysis(resp.analysisResult);
    } else {
      clearAnalysisUI();
    }
  }
}

async function hardRefresh() {
  await forceUpdateActiveTabId();
  try {
    lastSeenTabUrl = await getActiveTabUrl();
  } catch (e) {
    // ignore
  }
  await refreshState();
}

let __configWindowId = null;
async function openConfigWindow() {
  try {
    if (typeof __configWindowId === 'number') {
      try {
        await chrome.windows.update(__configWindowId, { focused: true });
        return;
      } catch (e) {
        __configWindowId = null;
      }
    }

    const url = chrome.runtime.getURL('popup.html');
    const w = await chrome.windows.create({
      url,
      type: 'popup',
      width: 380,
      height: 640,
      focused: true,
    });
    __configWindowId = w && typeof w.id === 'number' ? w.id : null;
  } catch (e) {
    alert(String(e && e.message ? e.message : e));
  }
}

async function analyzeFull() {
  const resp = await sendToContent('deepread_sp_analyze_full');
  if (resp && resp.ok) {
    renderAnalysis(resp.analysisResult);
    await refreshState();
  }
}

async function explainConcept(conceptName) {
  const resp = await sendToContent('deepread_sp_explain', { conceptName });
  if (resp && resp.ok) {
    renderConcept(conceptName, resp.conceptResult);
    await refreshState();
  }
}

async function sendChatMessage(text, opts = {}) {
  const hasUploads = (__selectedImages && __selectedImages.length) || (__selectedFiles && __selectedFiles.length);
  const allowUploads = !opts || !opts.disableUploads;
  const trimmed = String(text || '').trim();
  if (!trimmed && !(allowUploads && hasUploads)) return;

  const pendingId = `sp_pending_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const uploadHintParts = [];
  if (allowUploads && __selectedImages && __selectedImages.length) uploadHintParts.push(`${__selectedImages.length}张图片`);
  if (allowUploads && __selectedFiles && __selectedFiles.length) {
    const names = __selectedFiles.map((f) => f.name || '文件');
    uploadHintParts.push(`${__selectedFiles.length}个文件：${names.join('，')}`);
  }
  const uploadHint = uploadHintParts.length ? `（附带${uploadHintParts.join('，')}）` : '';
  const optimisticText = `${trimmed}${uploadHint}`.trim();

  __localChatHistory = Array.isArray(__localChatHistory) ? __localChatHistory.slice() : [];
  const optimisticMsg = {
    role: 'user',
    rawMessage: optimisticText,
    message: optimisticText,
    messageId: pendingId,
    images: allowUploads ? (__selectedImages || []).map((x) => ({ id: x.id, data: x.data, name: x.name })) : [],
    attachments: [],
  };
  __localChatHistory.push(optimisticMsg);
  renderChat(__localChatHistory);

  let images = [];
  let composed = trimmed;
  let attachments = [];
  if (allowUploads) {
    images = (__selectedImages || []).map((x) => ({ id: x.id, data: x.data }));
    // 不再将文件内容拼接到消息，仅提示文件名，将内容通过 attachments 传给后台
    const fileTexts = await readSelectedFilesAsText();
    attachments = fileTexts || [];
    if (optimisticMsg) optimisticMsg.attachments = attachments;
    if (attachments && attachments.length) {
      const names = attachments.map((f) => f.name || '文件');
      if (!composed) composed = `[附件] ${names.join('，')}`;
    }
    resetUploads();
  }

  let resp;
  try {
    resp = await sendToContent('deepread_sp_chat_send', { message: composed, images, attachments });
  } catch (e) {
    showErrorDialog('请求失败', e && e.message ? e.message : String(e));
    throw e;
  }

  if (resp && resp.ok) {
    __localChatHistory = resp.chatHistory || [];
    renderChat(__localChatHistory);
  } else {
    showErrorDialog('请求失败', resp && resp.error ? resp.error : '');
    await refreshState();
  }
}

async function sendChat() {
  const input = qs('drsp-input');
  const text = input ? input.value.trim() : '';
  if (input) input.value = '';
  await sendChatMessage(text);
}

async function exportImportableChat() {
  const resp = await sendToContent('deepread_sp_get_state');
  if (!resp || !resp.ok) return;
  const chatHistory = resp.chatHistory || [];
  if (!chatHistory.length) {
    showErrorDialog('导出失败', '当前没有可导出的对话内容。');
    return;
  }

  const exportData = {
    schema: 'deepread.chat.export.v1',
    exportId: `sp_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    exportedAt: Date.now(),
    source: {
      url: resp.pageMeta && resp.pageMeta.url ? String(resp.pageMeta.url) : '',
      title: resp.pageMeta && resp.pageMeta.title ? String(resp.pageMeta.title) : '',
    },
    messages: chatHistory.map((item) => ({
      id: item.messageId || `spm_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      role: item.role === 'user' ? 'user' : 'assistant',
      content: String(item.rawMessage || item.message || '').trim(),
    })),
  };

  const jsonText = JSON.stringify(exportData, null, 2);
  const ts = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const stamp = `${ts.getFullYear()}${pad2(ts.getMonth() + 1)}${pad2(ts.getDate())}_${pad2(ts.getHours())}${pad2(ts.getMinutes())}${pad2(ts.getSeconds())}`;
  const host = (() => {
    try {
      const u = exportData && exportData.source && exportData.source.url ? String(exportData.source.url) : '';
      if (!u) return '';
      return new URL(u).hostname.replaceAll('.', '_');
    } catch {
      return '';
    }
  })();
  const filename = `deepread_chat_${host ? host + '_' : ''}${stamp}.json`;

  const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
}

async function appendImportableChat() {
  const text = await showTextInputDialog('追加导入', '请粘贴 DeepRead 可导入 JSON：');
  if (!text || !text.trim()) return;
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    alert('内容不是有效 JSON。');
    return;
  }
  const resp = await sendToContent('deepread_sp_append_imported', { imported: data });
  if (resp && resp.ok) {
    await refreshState();
  } else {
    alert(resp && resp.error ? String(resp.error) : '追加导入失败');
  }
}

async function clearChat() {
  const ok = confirm('确认清空当前对话？此操作不可撤销。');
  if (!ok) return;
  const resp = await sendToContent('deepread_sp_clear_chat');
  if (resp && resp.ok) {
    await refreshState();
  }
}

function bindEvents() {
  const sel = qs('drsp-font-select');
  if (sel) {
    sel.addEventListener('change', () => {
      const px = applyFontSizePx(sel.value);
      scheduleSaveFontSize(px);
    });
  }

  const analyzeBtn = qs('drsp-analyze');
  if (analyzeBtn) analyzeBtn.addEventListener('click', analyzeFull);

  const manualAnalyzeBtn = qs('drsp-manual-analyze');
  if (manualAnalyzeBtn) manualAnalyzeBtn.addEventListener('click', openManualAnalyzeModal);

  const refreshBtn = qs('drsp-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', hardRefresh);

  const cfg = qs('drsp-config');
  if (cfg) cfg.addEventListener('click', openConfigWindow);

  const toggleAnalysisBtn = qs('drsp-toggle-analysis');
  if (toggleAnalysisBtn) {
    toggleAnalysisBtn.addEventListener('click', toggleAnalysis);
    updateToggleButton('drsp-toggle-analysis', __analysisCollapsed);
    setSectionCollapsed('drsp-analysis-body', __analysisCollapsed);
  }

  const imgBtn = qs('drsp-upload-image');
  const fileBtn = qs('drsp-upload-file');
  const imgInput = qs('drsp-image-input');
  const fileInput = qs('drsp-file-input');
  if (imgBtn && imgInput) {
    imgBtn.addEventListener('click', () => imgInput.click());
    imgInput.addEventListener('change', (e) => {
      try { addImagesFromInput(e && e.target ? e.target.files : null); } catch (err) { /* ignore */ }
      try { e.target.value = ''; } catch (err) { /* ignore */ }
    });
  }
  if (fileBtn && fileInput) {
    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      try { addFilesFromInput(e && e.target ? e.target.files : null); } catch (err) { /* ignore */ }
      try { e.target.value = ''; } catch (err) { /* ignore */ }
    });
  }

  const sendBtn = qs('drsp-send');
  if (sendBtn) {
    sendBtn.addEventListener('click', async () => {
      try {
        await sendChat();
      } catch (e) {
        showErrorDialog('发送失败', e && e.message ? e.message : String(e));
      }
    });
  }

  const clearBtn = qs('drsp-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      try {
        await clearChat();
      } catch (e) {
        showErrorDialog('清空失败', e && e.message ? e.message : String(e));
      }
    });
  }

  const copyBtn = qs('drsp-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await exportImportableChat();
      } catch (e) {
        showErrorDialog('导出失败', e && e.message ? e.message : String(e));
      }
    });
  }

  const appendBtn = qs('drsp-append');
  if (appendBtn) {
    appendBtn.addEventListener('click', async () => {
      try {
        await appendImportableChat();
      } catch (e) {
        showErrorDialog('导入失败', e && e.message ? e.message : String(e));
      }
    });
  }

  const insertSummaryBtn = qs('drsp-insert-summary');
  if (insertSummaryBtn) {
    insertSummaryBtn.addEventListener('click', async () => {
      try {
        await insertSummaryToChat();
      } catch (e) {
        showErrorDialog('插入失败', e && e.message ? e.message : String(e));
      }
    });
  }

  const insertConceptBtn = qs('drsp-insert-concept');
  if (insertConceptBtn) {
    insertConceptBtn.addEventListener('click', async () => {
      try {
        await insertConceptToChat();
      } catch (e) {
        showErrorDialog('插入失败', e && e.message ? e.message : String(e));
      }
    });
  }

  const input = qs('drsp-input');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    });

    input.addEventListener('paste', (e) => {
      try {
        const cd = e.clipboardData;
        const items = cd && cd.items ? Array.from(cd.items) : [];
        const imageFiles = items
          .filter((it) => it && it.kind === 'file' && it.type && it.type.startsWith('image/'))
          .map((it) => (typeof it.getAsFile === 'function' ? it.getAsFile() : null))
          .filter(Boolean);
        if (imageFiles.length) {
          e.preventDefault();
          addImagesFromBlobs(imageFiles);
        }
      } catch (err) {
        // ignore
      }
    });
  }

  const chatSearchInput = qs('drsp-chat-search-input');
  if (chatSearchInput) {
    chatSearchInput.addEventListener('input', (e) => {
      performChatSearch(e && e.target ? e.target.value : '');
    });
  }
  const chatSearchPrev = qs('drsp-chat-search-prev');
  if (chatSearchPrev) {
    chatSearchPrev.addEventListener('click', () => gotoNextSearchHit(-1));
  }
  const chatSearchNext = qs('drsp-chat-search-next');
  if (chatSearchNext) {
    chatSearchNext.addEventListener('click', () => gotoNextSearchHit(1));
  }
  updateChatSearchButtons();
}

async function insertConceptToChat() {
  if (!lastConceptName || !lastConceptExplanation) {
    alert('当前没有可插入的概念解释。');
    return;
  }
  const rawMessage = `概念：${lastConceptName}\n\n解释：\n${lastConceptExplanation}`;
  const resp = await sendToContent('deepread_sp_append_chat_message', { role: 'assistant', rawMessage });
  if (resp && resp.ok) {
    renderChat(resp.chatHistory || []);
  } else {
    await refreshState();
  }
}

async function writeToClipboardWithFallback(text) {
  const s = String(text == null ? '' : text);
  try {
    await navigator.clipboard.writeText(s);
    // alert('已复制到剪贴板。');
    return;
  } catch (e) {
    // fallback
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) {
      // alert('已复制到剪贴板。');
      return;
    }
  } catch (e) {
    // ignore
  }

  await showTextInputDialog('复制失败', '浏览器限制导致无法自动复制，请手动复制以下内容：', s);
}

async function showTextInputDialog(title, message, presetValue = '') {
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.left = '0';
  overlay.style.top = '0';
  overlay.style.right = '0';
  overlay.style.bottom = '0';
  overlay.style.background = 'rgba(0,0,0,0.28)';
  overlay.style.zIndex = '999999';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.padding = '12px';

  const card = document.createElement('div');
  card.style.width = '92%';
  card.style.maxWidth = '520px';
  card.style.background = '#fff';
  card.style.border = '1px solid #e5e7eb';
  card.style.borderRadius = '12px';
  card.style.padding = '12px';
  card.style.boxSizing = 'border-box';
  card.style.display = 'flex';
  card.style.flexDirection = 'column';
  card.style.gap = '10px';

  const h = document.createElement('div');
  h.textContent = String(title || '');
  h.style.fontWeight = '700';
  h.style.fontSize = '13px';

  const p = document.createElement('div');
  p.textContent = String(message || '');
  p.style.fontSize = '12px';
  p.style.color = '#374151';
  p.style.whiteSpace = 'pre-wrap';

  const ta = document.createElement('textarea');
  ta.value = presetValue || '';
  ta.rows = 8;
  ta.style.width = '100%';
  ta.style.boxSizing = 'border-box';
  ta.style.border = '1px solid #e5e7eb';
  ta.style.borderRadius = '10px';
  ta.style.padding = '8px';
  ta.style.fontSize = '12px';
  ta.style.resize = 'vertical';

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.justifyContent = 'flex-end';
  actions.style.gap = '8px';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'drsp-btn';
  cancelBtn.textContent = '取消';

  const okBtn = document.createElement('button');
  okBtn.className = 'drsp-btn drsp-primary';
  okBtn.textContent = '确定';

  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);

  card.appendChild(h);
  card.appendChild(p);
  card.appendChild(ta);
  card.appendChild(actions);

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  setTimeout(() => {
    try { ta.focus(); ta.select(); } catch (e) { /* no-op */ }
  }, 0);

  return new Promise((resolve) => {
    const cleanup = (val) => {
      try { document.body.removeChild(overlay); } catch (e) { /* no-op */ }
      resolve(val);
    };
    cancelBtn.addEventListener('click', () => cleanup(''));
    okBtn.addEventListener('click', () => cleanup(String(ta.value || '')));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup('');
    });
  });
}

(async function init() {
  await loadFontSizeSetting();
  bindEvents();
  bindTabSyncEvents();
  startUrlWatcher();
  bindConfigAutoRefresh();
  await hardRefresh();
})();
