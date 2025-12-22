// DeepRead 深度阅读助手 - 内容脚本
// 负责在页面上创建 UI并处理交互

// 加载 LLM API 脚本
// (function loadLLMScript() {
//   const script = document.createElement('script');
//   script.src = chrome.runtime.getURL('extensions/llm-api.js');
//   script.onload = function() {
//     console.log('LLM API 脚本加载成功');
//   };
//   document.head.appendChild(script);
// })();

// 添加调试信息
console.log('DeepRead content script loaded!');

// 检测是否在Chrome扩展环境中
const isExtensionEnvironment = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;

// gemini-2.5-flash-lite   gemini-flash-lite-latest   gemini-3-flash-preview
const MODEL_ID = 'gemini-3-flash-preview'
const PROVIDER = 'google'
const default_bot_language = '中文'
const greetingMessage = '您好！我是DeepRead助手。您可以向我提问有关本页面内容的问题，我将尽力为您解答。';
const pageSummaryFallback = '抱歉，我暂时无法分析页面内容。请稍后再试。';
const conceptExplanationFallback = '的解释暂时无法获取。请稍后再试。';
const chatResponseFallback = '关于您的问题，我暂时无法回答。请稍后再试。';
const imageGenerationFallback = '生成图像失败，请稍后再试。';
// 获取当前页面URL
const currentUrl = window.location.href;

// API_URL = `https://openrouter.ai/api/v1/chat/completions`;
const API_BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/`;
// 页面分析状态
let pageAnalyzed = false; // 标记页面是否已经分析过
let pageTitle = document.title;
let pageContent = ''; // 存储页面内容
let pageSummary = ''; // 存储页面摘要
let pageKeyTerms = []; // 存储页面关键概念
let pageKeyParagraphs = []; // 存储页面关键段落

// 聊天历史
let chatHistory = [];
// 概念查询历史
let conceptHistory = [];
let currentConceptIndex = -1; // 当前浏览的概念索引

let highlightHistory = []; // 用户划线历史（独立于 conceptHistory）

let lastSelectionRange = null;
let lastSelectionParagraphId = null;
let lastSelectionOffsets = null;

let selectedHighlightId = null;

function isDeepReadMinimapPinned(){
    try{
        return localStorage.getItem('deepread_minimap_pinned') === '1';
    }catch{
        return false;
    }
}

function setDeepReadMinimapPinned(v){
    try{
        localStorage.setItem('deepread_minimap_pinned', v ? '1' : '0');
    }catch{}
}

function showDeepReadMinimapPinned(restore = true){
    const minimap = ensureDeepReadMinimap();
    if (!minimap) return null;
    minimap.classList.remove('deepread-hidden');
    setDeepReadMinimapPinned(true);
    if (restore){
        restoreHighlightsFromCacheAndRender().catch(err => console.warn('恢复划线失败:', err));
    }
    return minimap;
}

function findParagraphEl(pid){
    if (!pid) return null;
    try{
        const direct = document.getElementById(pid);
        if (direct) return direct;
        const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(pid) : String(pid).replace(/"/g, '\\"');
        const byData = document.querySelector(`[data-dr-paragraph-id="${esc}"]`);
        if (byData) return byData;
    }catch{}
    return null;
}

function updateMinimapUIIfVisible({ previewText = '', previewHid = null } = {}){
    const minimap = document.getElementById('deepread-minimap') || null;
    if (!minimap || minimap.classList.contains('deepread-hidden')) return;
    try{
        renderHighlightMinimapDots();
        updateDeepReadMinimapViewport();
        if (previewHid){
            setHighlightPreviewText(previewText || '', previewHid);
        }
    }catch(err){
        console.warn('DeepRead: 刷新 minimap 失败:', err);
    }
}

async function ensureParagraphIdsReadyForHighlights(highlights){
    // 只有当 highlight 使用 paragraph-* 体系时才需要（否则一般是网页原生 id，可直接定位）
    const hs = Array.isArray(highlights) ? highlights : [];
    const needsParagraphIds = hs.some(h => h && typeof h.paragraphId === 'string' && h.paragraphId.startsWith('paragraph-'));
    if (!needsParagraphIds) return;

    // 如果已经有段落标记（存在任意 data-dr-paragraph-id="paragraph-0"），则认为已就绪
    if (document.querySelector('[data-dr-paragraph-id^="paragraph-"]')) return;

    // 避免重复执行导致卡顿
    if (window.__deepreadParagraphIdsReady) return;
    if (window.__deepreadParagraphIdsPromise) {
        try { await window.__deepreadParagraphIdsPromise; } catch {}
        return;
    }

    window.__deepreadParagraphIdsPromise = (async () => {
        try{
            await addParagraphIds();
            window.__deepreadParagraphIdsReady = true;
        } finally {
            window.__deepreadParagraphIdsPromise = null;
        }
    })();

    try{
        await window.__deepreadParagraphIdsPromise;
    }catch(err){
        console.warn('DeepRead: 自动补段落ID失败（用于恢复划线）:', err);
    }
}

// 当页面加载完成后初始化 2秒
window.addEventListener('load', function() {
    // 在Chrome扩展环境中，等待一小段时间再初始化，确保页面完全加载
    setTimeout(init, 2000);
});

// 添加清除缓存的快捷键函数
function setupClearCacheShortcut() {
    document.addEventListener('keydown', async function(event) {
        // Alt+Shift+C 组合键清除缓存
        if (event.altKey && event.shiftKey && event.key === 'C') {
            console.log('检测到清除缓存快捷键 Alt+Shift+C');
            
            try {
                if (window.cacheManager && window.cacheManager.clearAllCache) {
                    const result = await window.cacheManager.clearAllCache();
                    if (result) {
                        console.log('缓存已成功清除');
                        alert('缓存已成功清除，请刷新页面以应用更改。');
                        // 重置状态
                        pageAnalyzed = false;
                        pageSummary = '';
                        pageKeyTerms = [];
                        pageKeyParagraphs = [];
                        chatHistory = [];
                        conceptHistory = [];
                        currentConceptIndex = -1;
                    } else {
                        console.error('清除缓存失败');
                        alert('清除缓存失败，请查看控制台了解详情。');
                    }
                } else {
                    console.error('缓存管理器不可用或缺少clearAllCache函数');
                    alert('缓存管理器不可用，请刷新页面后重试。');
                }
            } catch (error) {
                console.error('清除缓存时出错:', error);
                alert('清除缓存时出错: ' + error.message);
            }
        }
    });
    console.log('DeepRead: 已设置清除缓存快捷键 Alt+Shift+C');
}

// Highlight 控制函数
function normalizeRangeOffsets(a, b){
    const s = Math.min(a, b);
    const e = Math.max(a, b);
    return { start: s, end: e };
}

function generateHighlightId(){
    return `hl_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function unwrapSpan(el){
    if (!el) return;
    const text = document.createTextNode(el.textContent || '');
    el.replaceWith(text);
}

function getUserHighlightElById(hid){
    if (!hid) return null;
    return document.querySelector(`.deepread-user-highlight[data-hid="${hid}"]`);
}

function isEditableTarget(target){
    if (!target) return false;
    const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = (el.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function setSelectedHighlightId(hid){
    selectedHighlightId = hid || null;
    document.querySelectorAll('.deepread-user-highlight.deepread-user-highlight-selected').forEach(el => {
        el.classList.remove('deepread-user-highlight-selected');
    });
    if (selectedHighlightId){
        const el = getUserHighlightElById(selectedHighlightId);
        if (el) el.classList.add('deepread-user-highlight-selected');
    }
}

function showFloatActionsForExistingHighlight({ x, y, highlight, paragraphId } = {}){
    try{
        const existingButtons = document.querySelectorAll('.deepread-float-button');
        existingButtons.forEach(button => {
            try{ if (document.body.contains(button)) document.body.removeChild(button); }catch{}
        });

        const floatButton = document.createElement('div');
        floatButton.className = 'deepread-float-button';
        floatButton.title = 'DeepRead';
        floatButton.innerHTML = `
            <button class="deepread-float-action deepread-float-highlight" type="button" title="划线">划线</button>
            <button class="deepread-float-action deepread-float-explain" type="button" title="解释">解释</button>
        `;
        floatButton.style.left = (Number(x || 0) + 10) + 'px';
        floatButton.style.top = (Number(y || 0) + 10) + 'px';

        floatButton.addEventListener('mousedown', function(e) {
            e.stopPropagation();
        });

        const btnHighlight = floatButton.querySelector('.deepread-float-highlight');
        const btnExplain = floatButton.querySelector('.deepread-float-explain');

        if (btnHighlight){
            // 对“已存在的划线”再次点击划线按钮：无动作（仅关闭浮窗）
            btnHighlight.addEventListener('click', function(e){
                e.stopPropagation();
                e.preventDefault();
                try{ floatButton.remove(); }catch{}
            });
        }

        if (btnExplain){
            btnExplain.addEventListener('click', function(e){
                e.stopPropagation();
                e.preventDefault();
                try{ floatButton.remove(); }catch{}

                const text = String((highlight && highlight.text) || '').trim();
                if (!text) return;
                const anchorData = { paragraphId: paragraphId || (highlight && highlight.paragraphId) };
                if (highlight && typeof highlight.start === 'number' && typeof highlight.end === 'number'){
                    anchorData.start = highlight.start;
                    anchorData.end = highlight.end;
                    anchorData.text = highlight.text;
                }
                openDeepReadWithConcept(text, anchorData);
            });
        }

        document.body.appendChild(floatButton);
    }catch(err){
        console.warn('DeepRead: showFloatActionsForExistingHighlight failed:', err);
    }
}

function showDeepReadToast(text, type = 'info'){
    try{
        const toast = document.createElement('div');
        toast.textContent = String(text || '');
        toast.style.position = 'fixed';
        toast.style.top = '18px';
        toast.style.left = '50%';
        toast.style.transform = 'translateX(-50%)';
        toast.style.backgroundColor = type === 'success' ? 'rgba(33, 150, 243, 0.92)' : (type === 'error' ? 'rgba(244, 67, 54, 0.92)' : 'rgba(0, 0, 0, 0.78)');
        toast.style.color = 'white';
        toast.style.padding = '8px 14px';
        toast.style.borderRadius = '10px';
        toast.style.zIndex = '10000';
        toast.style.maxWidth = '80vw';
        toast.style.fontSize = '12px';
        toast.style.lineHeight = '1.3';
        document.body.appendChild(toast);
        setTimeout(() => {
            try{ toast.remove(); }catch{}
        }, 1600);
    }catch{}
}

// 发送笔记到飞书
function getDeepReadFeishuWebhookUrl(){
    try{
        return (localStorage.getItem('deepread_feishu_webhook_url') || '').trim();
    }catch{
        return '';
    }
}

async function copyHighlightToClipboard(highlight){
    if (!highlight) {
        showDeepReadToast('没有可复制的划线内容', 'error');
        return;
    }
    const text = String(highlight.text || '').trim();
    try{
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            ta.style.top = '-9999px';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
        showDeepReadToast('已复制', 'success');
    } catch (err) {
        console.warn('DeepRead: 复制失败:', err);
        showDeepReadToast('复制失败', 'error');
    }
}

async function sendHighlightToFeishu(highlight){
    const webhookUrl = getDeepReadFeishuWebhookUrl();
    if (!webhookUrl){
        showDeepReadToast('请先配置 deepread_feishu_webhook_url', 'error');
        return;
    }
    if (!highlight || !highlight.text){
        showDeepReadToast('没有可发送的划线内容', 'error');
        return;
    }

    const title = (document && document.title) ? document.title : '';
    const url = window.location.href;
    const ideaText = String(highlight.text || '').trim();

    const payload = { title, idea: ideaText, url };
    try{
        const resp = await chrome.runtime.sendMessage({
            action: 'deepread_send_feishu_webhook',
            webhookUrl,
            payload
        });
        if (!resp || !resp.ok) throw new Error(resp && resp.error ? resp.error : 'unknown');
        showDeepReadToast('已发送', 'success');
    }catch(err){
        console.warn('DeepRead: 发送到飞书失败:', err);
        showDeepReadToast('发送失败', 'error');
    }
}

function bindUserHighlightSelectionAndDelete(){
    document.addEventListener('click', (e) => {
        const target = e.target;
        const sp = target && target.closest ? target.closest('.deepread-user-highlight[data-hid]') : null;
        if (!sp) return;

        const hid = sp.getAttribute('data-hid');
        if (!hid) return;
        setSelectedHighlightId(hid);

        const h = (Array.isArray(highlightHistory) ? highlightHistory : []).find(x => x && x.id === hid);
        setHighlightPreviewText((h && h.text) ? h.text : (sp.textContent || ''), hid);

        // 点击已划线文本时，弹出“划线/解释”按钮，方便直接解释
        showFloatActionsForExistingHighlight({
            x: e.pageX,
            y: e.pageY,
            highlight: h || { id: hid, paragraphId: sp.getAttribute('data-pid') || null, text: sp.textContent || '' },
            paragraphId: (h && h.paragraphId) ? h.paragraphId : (sp.getAttribute('data-pid') || null)
        });

        e.preventDefault();
        e.stopPropagation();
    }, true);

    document.addEventListener('click', async (e) => {
        const sendBtn = e.target && e.target.closest ? e.target.closest('#deepreadMinimapActions .deepread-minimap-send') : null;
        if (sendBtn){
            const box = document.getElementById('deepreadMinimapPreview');
            const hid = box ? (box.getAttribute('data-hid') || '') : '';
            if (hid){
                const h = (Array.isArray(highlightHistory) ? highlightHistory : []).find(x => x && x.id === hid);
                await sendHighlightToFeishu(h);
            }
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        const copyBtn = e.target && e.target.closest ? e.target.closest('#deepreadMinimapActions .deepread-minimap-copy') : null;
        if (copyBtn){
            const box = document.getElementById('deepreadMinimapPreview');
            const hid = box ? (box.getAttribute('data-hid') || '') : '';
            if (hid){
                const h = (Array.isArray(highlightHistory) ? highlightHistory : []).find(x => x && x.id === hid);
                await copyHighlightToClipboard(h);
            }
            e.preventDefault();
            e.stopPropagation();
            return;
        }
    });

    document.addEventListener('keydown', async (e) => {
        if (e.key !== 'Backspace' && e.key !== 'Delete') return;
        if (!selectedHighlightId) return;
        if (isEditableTarget(e.target)) return;
        await deleteHighlightById(selectedHighlightId);
        e.preventDefault();
        e.stopPropagation();
    });
}

function setHighlightPreview(text, hid){
    const el = document.getElementById('deepreadMinimapPreview');
    if (!el) return;
    const safeText = (text || '').toString();
    const hasId = !!hid;
    el.setAttribute('data-hid', hasId ? String(hid) : '');
    el.innerHTML = `
        <div class="deepread-minimap-preview-text"></div>
    `;
    const textEl = el.querySelector('.deepread-minimap-preview-text');
    if (textEl) textEl.textContent = safeText;

    const sendBtn = document.querySelector('#deepreadMinimapActions .deepread-minimap-send');
    const copyBtn = document.querySelector('#deepreadMinimapActions .deepread-minimap-copy');
    if (sendBtn) sendBtn.disabled = !hasId;
    if (copyBtn) copyBtn.disabled = !hasId;
}

async function deleteHighlightById(hid){
    if (!hid) return;

    const span = getUserHighlightElById(hid);
    if (span) unwrapSpan(span);

    highlightHistory = Array.isArray(highlightHistory) ? highlightHistory : [];
    highlightHistory = highlightHistory.filter(h => h && h.id !== hid);

    try{
        await saveHighlightsToCache();
    }catch(err){
        console.warn('删除划线缓存失败:', err);
    }

    setSelectedHighlightId(null);
    setHighlightPreview('', null);

    updateMinimapUIIfVisible();
}

function wrapHighlightInParagraph(paragraphEl, highlight){
    if (!paragraphEl || !highlight) return null;
    if (typeof highlight.start !== 'number' || typeof highlight.end !== 'number') return null;
    const fullTextLen = (paragraphEl.textContent || '').length;
    const s = Math.max(0, Math.min(fullTextLen, highlight.start));
    const e = Math.max(0, Math.min(fullTextLen, highlight.end));
    if (e <= s) return null;

    // 覆盖策略：移除与 [s,e) 有重叠的旧划线
    const spans = Array.from(paragraphEl.querySelectorAll('.deepread-user-highlight[data-hid]'));
    for (const sp of spans){
        const spStart = Number(sp.getAttribute('data-start'));
        const spEnd = Number(sp.getAttribute('data-end'));
        if (!Number.isFinite(spStart) || !Number.isFinite(spEnd)) continue;
        const overlap = !(e <= spStart || s >= spEnd);
        if (overlap) unwrapSpan(sp);
    }

    const startLoc = nodeAtOffset(paragraphEl, s);
    const endLoc = nodeAtOffset(paragraphEl, e);
    if (!startLoc || !endLoc) return null;

    const range = document.createRange();
    range.setStart(startLoc.node, startLoc.offset);
    range.setEnd(endLoc.node, endLoc.offset);

    const selectedText = (range.toString() || '').trim();
    if (!selectedText) return null;

    const span = document.createElement('span');
    span.className = 'deepread-user-highlight';
    span.setAttribute('data-hid', highlight.id);
    span.setAttribute('data-pid', highlight.paragraphId);
    span.setAttribute('data-start', String(s));
    span.setAttribute('data-end', String(e));

    const frag = range.extractContents();
    span.appendChild(frag);
    range.insertNode(span);
    return span;
}

async function saveHighlightsToCache(){
    if (!window.cacheManager || !window.cacheManager.saveHighlights) return;
    const url = window.location.href;
    await window.cacheManager.saveHighlights(url, highlightHistory || []);
}

function buildHighlightsExportText(){
    const title = (document && document.title) ? String(document.title).trim() : '';
    const url = window.location.href;
    const highlights = (Array.isArray(highlightHistory) ? highlightHistory : [])
        .filter(h => h && typeof h.text === 'string' && h.text.trim())
        .map(h => h.text.trim());

    const parts = [];
    if (title) parts.push(title);
    parts.push(url);
    parts.push('');
    parts.push(...highlights);
    return parts.join('\n\n');
}

function downloadTextFile(filename, text){
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        try{ URL.revokeObjectURL(a.href); }catch{}
        try{ a.remove(); }catch{}
    }, 0);
}

async function deleteAllHighlights(){
    const ids = (Array.isArray(highlightHistory) ? highlightHistory : []).map(h => h && h.id).filter(Boolean);
    for (const hid of ids){
        const span = getUserHighlightElById(hid);
        if (span) unwrapSpan(span);
    }
    highlightHistory = [];
    selectedHighlightId = null;
    try{
        await saveHighlightsToCache();
    }catch(err){
        console.warn('清空划线缓存失败:', err);
    }
    updateMinimapUIIfVisible({ previewText: '', previewHid: '' });
}

async function loadHighlightsFromCache(){
    if (!window.cacheManager || !window.cacheManager.loadHighlights) return [];
    const url = window.location.href;
    return await window.cacheManager.loadHighlights(url);
}

function clearTransientConceptHighlight(){
    document.querySelectorAll('.deepread-precise-highlight').forEach(el => {
        unwrapSpan(el);
    });
    document.querySelectorAll('.deepread-highlight').forEach(el => {
        el.classList.remove('deepread-highlight');
    });
}

function setHighlightPreviewText(text, hid){
    setHighlightPreview(text, hid);
}

function renderHighlightMinimapDots(){
    const minimap = document.getElementById('deepread-minimap');
    if (!minimap || minimap.classList.contains('deepread-hidden')) return;
    const bar = minimap.querySelector('#deepreadMinimapBar');
    const countEl = minimap.querySelector('#deepreadMinimapCount');
    const exportBtn = minimap.querySelector('#deepreadMinimapExport');
    if (!bar) return;

    bar.querySelectorAll('.deepread-minimap-dot').forEach(d => d.remove());

    const highlights = Array.isArray(highlightHistory) ? highlightHistory : [];
    if (countEl) countEl.textContent = String(highlights.length);
    if (exportBtn) exportBtn.disabled = highlights.length === 0;

    const docH = Math.max(1, document.documentElement.scrollHeight);
    const barH = bar.getBoundingClientRect().height || 1;
    const topPad = 10;
    const bottomPad = 14;
    const usableH = Math.max(1, barH - topPad - bottomPad);

    for (const h of highlights){
        if (!h || !h.paragraphId) continue;
        const el = findParagraphEl(h.paragraphId);
        if (!el) continue;
        const top = el.getBoundingClientRect().top + window.scrollY;
        const ratio = Math.max(0, Math.min(1, top / docH));
        const topPx = Math.round(topPad + ratio * usableH);

        const dot = document.createElement('div');
        dot.className = 'deepread-minimap-dot';
        dot.setAttribute('data-hid', h.id);
        dot.style.background = 'rgba(76, 175, 80, 0.95)';
        dot.style.top = `${Math.max(topPad, Math.min(barH - bottomPad, topPx))}px`;

        // hover: 仅预览，不跳转
        dot.addEventListener('mouseenter', () => {
            setHighlightPreviewText(h.text || '', h.id);
        });

        dot.addEventListener('mouseleave', () => {
            if (selectedHighlightId){
                const cur = (Array.isArray(highlightHistory) ? highlightHistory : []).find(x => x && x.id === selectedHighlightId);
                setHighlightPreviewText((cur && cur.text) ? cur.text : '', selectedHighlightId);
            } else {
                setHighlightPreviewText('', '');
            }
        });

        dot.addEventListener('click', () => {
            const target = findParagraphEl(h.paragraphId);
            if (target){
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            setSelectedHighlightId(h.id);
            setHighlightPreviewText(h.text || '', h.id);
            clearTransientConceptHighlight();
        });

        bar.appendChild(dot);
    }
}

async function restoreHighlightsFromCacheAndRender(){
    // 1) load cache -> memory
    const cached = await loadHighlightsFromCache();
    if (Array.isArray(cached)) highlightHistory = cached;

    // 1.5) 确保 paragraph-* 体系可定位（在不打开右侧面板时也能恢复高亮/dots）
    await ensureParagraphIdsReadyForHighlights(highlightHistory);

    // 2) restore DOM wraps
    for (const h of (highlightHistory || [])){
        if (!h || !h.id || !h.paragraphId) continue;
        if (getUserHighlightElById(h.id)) continue; // avoid double wrap
        const paragraphEl = findParagraphEl(h.paragraphId);
        if (!paragraphEl) continue;
        try{
            wrapHighlightInParagraph(paragraphEl, h);
        }catch(err){
            console.warn('恢复单条划线失败:', h && h.id, err);
        }
    }

    renderHighlightMinimapDots();
    updateDeepReadMinimapViewport();
}
// Highlight 控制函数结束


// 初始化 注意：不要再这个init方法里自动展开面板，
// 这会导致打开新页面或页面刷新时，助手（作为chrome插件）自动打开，对用户体验不好
// 只有用户主动点击助手进行操作时，才打开面板，
// 具体方法是：if (isExtensionEnvironment) { chrome.runtime.onMessage.addListener
async function init() {
    console.log('DeepRead 初始化中...');
    
    // 设置清除缓存的快捷键
    setupClearCacheShortcut();

    // 绑定划线选中/删除（防止重复绑定）
    if (!window.__deepreadUserHighlightDeleteBound){
        try{
            bindUserHighlightSelectionAndDelete();
            window.__deepreadUserHighlightDeleteBound = true;
        }catch(err){
            console.warn('DeepRead: 绑定划线删除事件失败:', err);
        }
    }

    if (!window.__deepreadSelectionListenerBound){
        try{
            addTextSelectionListener();
            window.__deepreadSelectionListenerBound = true;
        }catch(err){
            console.warn('DeepRead: 绑定文本选择浮窗失败:', err);
        }
    }
    
    // 从缓存加载数据
    if (window.cacheManager) {
        try {
            // 获取当前页面URL
            const currentUrl = window.location.href;
            
            // 加载概念查询历史
            const cachedConceptHistory = await window.cacheManager.loadConceptHistory();
            if (cachedConceptHistory && cachedConceptHistory.length > 0) {
                conceptHistory = cachedConceptHistory;
                currentConceptIndex = await window.cacheManager.getCurrentConceptIndex();
                debugLog(`从缓存加载了 ${conceptHistory.length} 条概念查询记录，当前索引: ${currentConceptIndex}`);
            }

            // 加载聊天历史
            const cachedChatHistory = await window.cacheManager.loadChatHistory();
            if (cachedChatHistory && cachedChatHistory.length > 0) {
                chatHistory = cachedChatHistory;
                debugLog(`从缓存加载了 ${chatHistory.length} 条聊天记录`);
            }

            // 加载用户划线（仅加载到内存；恢复 DOM 在面板打开时执行）
            const cachedHighlights = await window.cacheManager.loadHighlights(currentUrl);
            if (cachedHighlights && cachedHighlights.length > 0) {
                highlightHistory = cachedHighlights;
                debugLog(`从缓存加载了 ${highlightHistory.length} 条划线记录`);
            }

            // 左侧 minimap 一旦打开后常驻：若之前 pinned，则页面刷新后自动恢复显示
            if (isDeepReadMinimapPinned()){
                showDeepReadMinimapPinned(true);
            }
            
            // 加载页面内容
            const cachedPageContent = await window.cacheManager.loadPageContent(currentUrl);
            if (cachedPageContent) {
                // 更新页面内容变量
                pageContent = cachedPageContent.content || '';
                pageSummary = cachedPageContent.summary || '';
                pageKeyTerms = cachedPageContent.keyTerms || [];
                pageKeyParagraphs = cachedPageContent.keyParagraphs || [];
            
                // 加载当前页面的分析状态
                // pageAnalyzed = await window.cacheManager.loadPageAnalyzedStatus(currentUrl);
                // console.log('当前页面分析状态:', pageAnalyzed);

                // 检查缓存内容是否有效
                const contentValid = pageContent 
                    && pageContent.length > 0 
                    && pageSummary 
                    && pageSummary.length > 0 
                    && pageSummary != pageSummaryFallback
                    && pageKeyTerms 
                    && pageKeyTerms.length > 0
                    && pageKeyParagraphs 
                    && pageKeyParagraphs.length > 0;
                
                // 如果缓存内容有效，更新页面分析状态
                if (contentValid) {
                    // 更新内存中的状态
                    pageAnalyzed = true;
                    // 同时更新缓存中的状态
                    await window.cacheManager.savePageAnalyzedStatus(currentUrl, true);
                    console.log('缓存内容有效，设置pageAnalyzed = true');
                    console.log('摘要长度:', pageSummary.length, '关键概念数量:', pageKeyTerms.length, '关键段落数量:', pageKeyParagraphs.length);
                } else {
                    // 如果缓存内容无效，确保页面分析状态为false
                    pageAnalyzed = false;
                    await window.cacheManager.savePageAnalyzedStatus(currentUrl, false);
                    console.log('缓存内容无效: "', pageSummary, '", 设置pageAnalyzed = false');
                }
                
            } else {
                console.log('没有找到当前页面的缓存内容');
                // 确保页面分析状态为false
                pageAnalyzed = false;
                await window.cacheManager.savePageAnalyzedStatus(currentUrl, false);
            }
        } catch (error) {
            console.error('从缓存加载数据时出错:', error);
            // 出错时确保页面分析状态为false
            pageAnalyzed = false;
            try {
                await window.cacheManager.savePageAnalyzedStatus(currentUrl, false);
            } catch (e) {
                console.error('保存页面分析状态时出错:', e);
            }
        }
    }
}

// 如果在Chrome扩展环境中，添加消息监听器 
// 这段代码是扩展功能的重要组成部分，它连接了扩展的弹出界面和内容脚本，使用户能够通过点击扩展图标和按钮来控制DeepRead功能。
if (isExtensionEnvironment) {
    chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
        console.log('Content script received message:', request);
        if (request.action === 'startReading') {
            console.log('收到startReading消息');
            // 检查页面是否已经分析过
            if (pageAnalyzed) {
                console.log('页面已经分析过，直接显示结果');
                
                // 确保面板存在
                if (!document.getElementById('deepread-container')) {
                    createDeepReadPanel();
                    // addParagraphIds();
                    addTextSelectionListener();
                }
                
                // 显示面板
                toggleDeepReadPanel();

                addParagraphIds();
                
                // 再次从缓存加载页面内容
                window.cacheManager.loadPageContent(currentUrl)
                    .then(cachedPageContent => {
                        if (cachedPageContent && cachedPageContent.summary && cachedPageContent.keyTerms) {
                            console.log('加载全文分析缓存，关键概念数量:', cachedPageContent.keyTerms.length);
                            // 更新全局变量
                            pageSummary = cachedPageContent.summary;
                            pageKeyTerms = cachedPageContent.keyTerms;
                            pageKeyParagraphs = cachedPageContent.keyParagraphs;
                        } else {
                            console.log('缓存加载失败或缓存内容不完整，使用当前内存中的数据');
                        }
                        // 全文分析结果
                        showAnalysisResults({
                            summary: pageSummary,
                            keyTerms: pageKeyTerms,
                            keyParagraphs: pageKeyParagraphs
                        });
                    })
                    .catch(error => {
                        console.error('加载缓存内容失败:', error);
                        // 出错时使用当前内存中的数据
                        showAnalysisResults({
                            summary: pageSummary,
                            keyTerms: pageKeyTerms,
                            keyParagraphs: pageKeyParagraphs
                        });
                    });
                sendResponse({status: 'success', message: '从缓存恢复分析结果'});

            } else {
                console.log('页面没有分析过，Starting deep reading...');
                // 创建面板，让用户预览内容并手动确认分析
                createDeepReadPanel();
                // 添加文本选择事件监听
                addTextSelectionListener();
                // 显示面板
                toggleDeepReadPanel();
                
                sendResponse({status: 'success', message: '深度阅读已启动'});
            }
        } else if (request.action === 'togglePanel') {
            console.log('Toggling panel...');
            toggleDeepReadPanel();
            sendResponse({status: 'success', message: '面板显示状态已切换'});
        } else if (request.action === 'showSettings') {
            console.log('Showing settings panel...');
            // 创建并显示设置面板
            createSettingsPanel();
            sendResponse({status: 'success', message: '设置面板已显示'});
        }
        return true; // 保持消息通道打开以便异步响应
    });
}

// 页面加载时 创建DeepRead面板（核心代码）
function createDeepReadPanel() {
    // 检查是否已存在面板
    if (document.getElementById('deepread-panel')) {
        return;
    }
    
    // 强制重置文本选择功能，确保用户可以选中文本
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    
    // 创建主容器
    const container = document.createElement('div');
    container.id = 'deepread-container';
    container.className = 'deepread-container deepread-hidden';
    
    // 创建可拖动边界
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'deepread-resize-handle';
    container.appendChild(resizeHandle);
    
    // 添加水平拖动事件处理
    initResizeHandlers(container, resizeHandle);
    // 垂直拖动功能将在showAnalysisResults函数中初始化，确保DOM元素已创建

    // 创建面板
    const panel = document.createElement('div');
    panel.id = 'deepread-panel';
    panel.className = 'deepread-panel';

    // 创建标题
    const header = document.createElement('div');
    header.className = 'deepread-header';
    
    const title = document.createElement('h2');
    title.textContent = 'DeepRead 深度阅读';
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'deepread-close-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', toggleDeepReadPanel);
    
    header.appendChild(title);
    header.appendChild(closeBtn);

    // 创建内容区域
    const content = document.createElement('div');
    content.id = 'deepread-content';
    content.className = 'deepread-content';
    
    // 初始内容
    content.innerHTML = `
        <div class="deepread-response">
            <button id="deepread-analyze-btn" class="deepread-btn">开始全文分析</button>
        </div>
    `;
    
    // 创建底部对话区域
    const footer = document.createElement('div');
    footer.className = 'deepread-footer';
    footer.id = 'deepread-footer';
    
    // 添加输入区域
    const chatInputContainer = document.createElement('div');
    chatInputContainer.className = 'deepread-chat-input-container';
    chatInputContainer.style.flexDirection = 'column'; // 垂直布局

    // 图片预览区
    const imagePreviewContainer = document.createElement('div');
    imagePreviewContainer.id = 'deepread-image-preview-container';
    imagePreviewContainer.className = 'deepread-image-preview-container';
    imagePreviewContainer.style.display = 'none'; // 默认隐藏

    const chatInput = document.createElement('textarea');
    chatInput.id = 'deepread-chat-input';
    chatInput.className = 'deepread-chat-input';
    chatInput.placeholder = '输入您的问题... (Shift+Enter 发送)'; // 更新提示
    chatInput.rows = 1;

    // 添加键盘事件监听，实现 Enter 换行, Shift+Enter 发送
    chatInput.addEventListener('keydown', (event) => {
        // 当按下 Shift + Enter 时发送消息
        if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault(); // 阻止默认的换行行为
            // 直接调用发送消息的函数
            sendChatMessage();
        }
        // 单独按下 Enter 时，保持默认的换行行为，此处无需代码
    });

    // 图片上传按钮
    const uploadButton = document.createElement('button');
    uploadButton.id = 'deepread-chat-upload';
    uploadButton.className = 'deepread-chat-upload';
    uploadButton.innerHTML = '&#128247;'; // emoji for image
    uploadButton.title = '上传图片';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true; // 允许多文件上传
    fileInput.style.display = 'none';
    fileInput.id = 'deepread-image-input';

    uploadButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleImageUpload);

    // 为聊天输入框添加粘贴事件监听
    chatInput.addEventListener('paste', (event) => {
        // 从剪贴板获取文件
        const files = event.clipboardData?.files;
        if (files && files.length > 0) {
            // 筛选出图片文件
            const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/'));
            if (imageFiles.length > 0) {
                // 阻止默认的粘贴行为（如将文件路径粘贴到输入框）
                event.preventDefault();
                // 处理图片文件
                addImagesToPreview(imageFiles);
            }
        }
    });

    // 创建一个新的行容器来包裹输入框和按钮
    const inputRowContainer = document.createElement('div');
    inputRowContainer.className = 'deepread-input-row-container';
    inputRowContainer.style.display = 'flex';
    inputRowContainer.style.flexDirection = 'row';
    inputRowContainer.style.width = '100%';
    inputRowContainer.style.alignItems = 'flex-end'; // 垂直对齐

    // 将输入框和按钮添加到行容器
    inputRowContainer.appendChild(chatInput);
    inputRowContainer.appendChild(uploadButton);
    inputRowContainer.appendChild(fileInput);

    const sendButton = document.createElement('button');
    sendButton.id = 'deepread-chat-send';
    sendButton.className = 'deepread-chat-send';
    sendButton.textContent = '发送';
    sendButton.addEventListener('click', sendChatMessage);
    inputRowContainer.appendChild(sendButton);

    // 将图片预览和行容器添加到主容器
    chatInputContainer.appendChild(imagePreviewContainer);
    chatInputContainer.appendChild(inputRowContainer);
    footer.appendChild(chatInputContainer);

    // 组装面板
    panel.appendChild(header);
    panel.appendChild(content);
    panel.appendChild(footer);
    container.appendChild(panel);

    // 添加到页面
    document.body.appendChild(container);

    // 添加事件监听
    document.getElementById('deepread-analyze-btn').addEventListener('click', analyzePageContent);
    
    // // 点击主面板外部区域时隐藏面板 
    // document.addEventListener('click', function(e) {
    //     const mainContainer = document.getElementById('deepread-container');
    //     if (mainContainer && !mainContainer.classList.contains('deepread-hidden')) {
    //         // 检查点击是否在主面板外部，且不是浮动按钮或设置面板
    //         const isOutsideMainPanel = !mainContainer.contains(e.target);
    //         const isFloatButton = e.target.closest('.deepread-float-button');
    //         const isSettingsPanel = e.target.closest('#deepread-settings-panel');
    //         const isSettingsBtn = e.target.closest('#deepread-settings-btn');
            
    //         if (isOutsideMainPanel && !isFloatButton && !isSettingsPanel && !isSettingsBtn) {
    //             mainContainer.classList.add('deepread-hidden');
    //             debugLog('点击外部区域，隐藏主面板');
    //         }
    //     }
    // });

    // 创建导航指示器
    const navIndicator = document.createElement('div');
    navIndicator.id = 'deepread-nav-indicator';
    navIndicator.className = 'deepread-nav-indicator';
    navIndicator.style.display = 'none';
    document.body.appendChild(navIndicator);
    ensureDeepReadMinimap();
    console.log('DeepRead panel created.');
}

// 创建切换按钮 TODO 没用到
function createToggleButton() {
    const button = document.createElement('button');
    button.id = 'deepread-toggle-btn';
    button.className = 'deepread-toggle-btn';
    button.textContent = 'DR';
    button.title = '打开/关闭 DeepRead 深度阅读助手';
    button.addEventListener('click', toggleDeepReadPanel);
    document.body.appendChild(button);
}

// 切换面板显示/隐藏
function toggleDeepReadPanel() {
    let container = document.getElementById('deepread-container');
    
    // 如果面板不存在，先创建面板
    // if (!container) {
    //     console.log('面板不存在，创建面板');
    //     createDeepReadPanel();
    //     // addParagraphIds();
    //     addTextSelectionListener();
    //     container = document.getElementById('deepread-container');
    // }
    
    // 切换面板显示状态
    if (container) {
        container.classList.toggle('deepread-hidden');
        // 右侧面板开闭与左侧 minimap 解耦：minimap 一旦打开即常驻，不随右侧隐藏
        if (!container.classList.contains('deepread-hidden')){
            showDeepReadMinimapPinned(true);
        }
        if (container.classList.contains('deepread-hidden')) {
            debugLog('隐藏DeepRead面板');
        } else {
            debugLog('显示DeepRead面板');
        }
    } else {
        console.error('面板显示失败');
    }
}

function ensureDeepReadMinimap(){
    let el = document.getElementById('deepread-minimap');
    if (el) return el;

    el = document.createElement('div');
    el.id = 'deepread-minimap';
    el.className = 'deepread-minimap deepread-hidden';
    el.setAttribute('aria-label', 'DeepRead 卡尺');
    el.innerHTML = `
        <div class="deepread-minimap-pan" id="deepreadMinimapPan" title="拖动窗口"></div>
        <div class="deepread-minimap-actions" id="deepreadMinimapActions">
            <button class="deepread-minimap-export" id="deepreadMinimapExport" title="导出全部划线" disabled>导出划线<span class="deepread-minimap-count" id="deepreadMinimapCount">—</span></button>
            <button class="deepread-minimap-send" type="button" title="发送到飞书" disabled>发送</button>
            <button class="deepread-minimap-copy" type="button" title="复制文本内容" disabled>复制</button>
        </div>
        <div class="deepread-minimap-preview" id="deepreadMinimapPreview" title="划线预览"></div>
        <div class="deepread-minimap-bar" id="deepreadMinimapBar" title="划线微缩">
            <div class="deepread-minimap-rail"></div>
            <div class="deepread-minimap-view" id="deepreadMinimapView"></div>
        </div>
    `;
    document.body.appendChild(el);

    const exportBtn = document.getElementById('deepreadMinimapExport');
    if (exportBtn){
        exportBtn.disabled = true;
        exportBtn.addEventListener('click', async () => {
            const highlights = Array.isArray(highlightHistory) ? highlightHistory : [];
            if (!highlights.length){
                showDeepReadToast('没有可导出的划线', 'error');
                return;
            }

            const shouldClear = confirm('导出划线：\n\n【确定】导出后清空并删除记录\n【取消】仅导出');
            const content = buildHighlightsExportText();
            const safeTitle = ((document && document.title) ? String(document.title) : '').replace(/[\\/:*?"<>|]+/g, ' ').trim();
            const date = new Date();
            const stamp = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
            const filename = `${safeTitle || 'DeepRead'}-highlights-${stamp}.txt`;
            downloadTextFile(filename, content);

            if (shouldClear){
                await deleteAllHighlights();
                showDeepReadToast('已导出并清空', 'success');
            } else {
                showDeepReadToast('已导出', 'success');
            }
        });
    }

    restoreDeepReadMinimapX();
    bindDeepReadMinimapPan();

    // 滚动/缩放更新 viewport
    window.addEventListener('scroll', updateDeepReadMinimapViewport, { passive: true });
    window.addEventListener('resize', () => {
        renderHighlightMinimapDots();
        updateDeepReadMinimapViewport();
    });

    return el;
}

function getDeepReadMinimapX(){
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--deepread-minimap-x');
    const v = parseInt(String(raw || '').trim(), 10);
    return Number.isFinite(v) ? v : 0;
}

function setDeepReadMinimapX(px){
    const x = Math.round(Number(px) || 0);
    document.documentElement.style.setProperty('--deepread-minimap-x', `${x}px`);
    try{
        localStorage.setItem('deepread_minimap_x', String(x));
    }catch{}
}

function restoreDeepReadMinimapX(){
    try{
        const v = parseInt(localStorage.getItem('deepread_minimap_x') || '', 10);
        if (Number.isFinite(v)) setDeepReadMinimapX(v);
    }catch{}
}

function bindDeepReadMinimapPan(){
    const pan = document.getElementById('deepreadMinimapPan');
    const card = document.getElementById('deepread-minimap');
    if (!pan || !card) return;

    let dragging = false;
    let startX = 0;
    let startOffset = 0;
    let minOffset = null;
    let maxOffset = null;

    pan.addEventListener('pointerdown', (e) => {
        dragging = true;
        startX = e.clientX;
        startOffset = getDeepReadMinimapX();

        const rect = card.getBoundingClientRect();
        const vw = window.innerWidth || document.documentElement.clientWidth || 0;

        // 允许在视口内拖动：左边不小于 8px，右边不超过 vw-8px
        const canMoveLeft = rect.left - 8;
        const canMoveRight = (vw - 8) - rect.right;
        minOffset = startOffset - canMoveLeft;
        maxOffset = startOffset + canMoveRight;

        try{ pan.setPointerCapture(e.pointerId); }catch{}
        e.preventDefault();
        e.stopPropagation();
    });

    pan.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        let next = startOffset + dx;
        if (typeof minOffset === 'number') next = Math.max(minOffset, next);
        if (typeof maxOffset === 'number') next = Math.min(maxOffset, next);
        setDeepReadMinimapX(next);
    });

    function endDrag(){
        dragging = false;
        minOffset = null;
        maxOffset = null;
    }

    pan.addEventListener('pointerup', endDrag);
    pan.addEventListener('pointercancel', endDrag);
}

function getClosestParagraphIdFromNode(node){
    if (!node) return null;
    let el = (node.nodeType === Node.ELEMENT_NODE) ? node : node.parentElement;
    if (!el) return null;

    // 优先直接找 data-dr-paragraph-id / id
    const direct = el.closest('[data-dr-paragraph-id], [id^="paragraph-"]');
    if (!direct) return null;

    return direct.getAttribute('data-dr-paragraph-id') || direct.id || null;
}

function getClosestParagraphElement(node){
    if (!node) return null;
    let el = (node.nodeType === Node.ELEMENT_NODE) ? node : node.parentElement;
    if (!el) return null;

    const direct = el.closest('[data-dr-paragraph-id], [id^="paragraph-"]');
    if (direct) return direct;

    // 真实网页兼容：正文段落常见是 p/li/blockquote/pre/h1-h6，并且可能自带非 paragraph-* 的 id
    const fallback = el.closest('p, li, blockquote, pre, h1, h2, h3, h4, h5, h6');
    if (!fallback) return null;

    // 补齐 data-dr-paragraph-id：优先复用现有 id；如果没有 id，则生成一个
    if (!fallback.getAttribute('data-dr-paragraph-id')){
        if (fallback.id){
            fallback.setAttribute('data-dr-paragraph-id', fallback.id);
        } else {
            const autoId = `paragraph-auto-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            fallback.id = autoId;
            fallback.setAttribute('data-dr-paragraph-id', autoId);
        }
    }
    return fallback;
}

function getTextNodesIn(el){
    const nodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
}

function calcOffsetWithinParagraph(paragraphEl, range){
    if (!paragraphEl || !range) return null;
    try{
        const rStart = document.createRange();
        rStart.selectNodeContents(paragraphEl);
        rStart.setEnd(range.startContainer, range.startOffset);
        const start = rStart.toString().length;

        const rEnd = document.createRange();
        rEnd.selectNodeContents(paragraphEl);
        rEnd.setEnd(range.endContainer, range.endOffset);
        const end = rEnd.toString().length;

        return { start, end, text: range.toString() };
    }catch{
        return null;
    }
}

function nodeAtOffset(el, targetOffset){
    const nodes = getTextNodesIn(el);
    let acc = 0;
    for (const n of nodes){
        const len = n.nodeValue.length;
        if (targetOffset <= acc + len){
            return { node: n, offset: Math.max(0, targetOffset - acc) };
        }
        acc += len;
    }
    if (nodes.length === 0) return null;
    const last = nodes[nodes.length - 1];
    return { node: last, offset: last.nodeValue.length };
}

function setDeepReadHighlightByParagraphId(paragraphId){
    if (!paragraphId) return;
    const target = (typeof findByIdEverywhere === 'function') ? findByIdEverywhere(paragraphId) : document.getElementById(paragraphId);
    if (!target) return;

    document.querySelectorAll('.deepread-highlight').forEach(el => {
        el.classList.remove('deepread-highlight');
    });
    target.classList.add('deepread-highlight');
}

function setDeepReadHighlightByAnchor(anchor){
    if (!anchor || !anchor.paragraphId) return;
    const paragraphEl = (typeof findByIdEverywhere === 'function') ? findByIdEverywhere(anchor.paragraphId) : document.getElementById(anchor.paragraphId);
    if (!paragraphEl) return;

    // 清除旧高亮
    document.querySelectorAll('.deepread-highlight, .deepread-precise-highlight').forEach(el => {
        if (el.classList.contains('deepread-precise-highlight')){
            const text = document.createTextNode(el.textContent || '');
            el.replaceWith(text);
        } else {
            el.classList.remove('deepread-highlight');
        }
    });

    // 如果有精确 offsets，则精确 wrap
    if (typeof anchor.start === 'number' && typeof anchor.end === 'number'){
        try{
            const startLoc = nodeAtOffset(paragraphEl, anchor.start);
            const endLoc = nodeAtOffset(paragraphEl, anchor.end);
            if (startLoc && endLoc){
                const range = document.createRange();
                range.setStart(startLoc.node, startLoc.offset);
                range.setEnd(endLoc.node, endLoc.offset);
                const span = document.createElement('span');
                span.className = 'deepread-precise-highlight';
                const frag = range.extractContents();
                span.appendChild(frag);
                range.insertNode(span);
                return;
            }
        }catch(err){
            console.warn('精确高亮失败，降级到段落级:', err);
        }
    }

    // 降级：段落级高亮
    paragraphEl.classList.add('deepread-highlight');
}

function renderConceptMinimapDots(){
    // 已按设计将左侧 minimap 专用于“用户划线/高亮”。
    // 保留该函数以避免历史调用导致报错，但不再渲染 concept dots。
    return;
}

function updateDeepReadMinimapViewport(){
    const minimap = document.getElementById('deepread-minimap');
    if (!minimap || minimap.classList.contains('deepread-hidden')) return;
    const bar = minimap.querySelector('#deepreadMinimapBar');
    const view = minimap.querySelector('#deepreadMinimapView');
    if (!bar || !view) return;

    const docH = Math.max(1, document.documentElement.scrollHeight);
    const barH = bar.getBoundingClientRect().height || 1;
    const topPad = 10;
    const bottomPad = 14;
    const usableH = Math.max(1, barH - topPad - bottomPad);

    const topRatio = window.scrollY / docH;
    const viewRatio = window.innerHeight / docH;
    const topPx = Math.round(topPad + topRatio * usableH);
    const hPx = Math.max(18, Math.round(viewRatio * usableH));
    view.style.top = `${Math.max(topPad, Math.min(barH - bottomPad, topPx))}px`;
    view.style.height = `${Math.max(18, Math.min(barH - topPad - bottomPad, hPx))}px`;
}

// createDeepReadPanel -> initResizeHandlers 初始化拖动功能(窗口变宽)
function initResizeHandlers(container, resizeHandle) {
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    
    // 开始拖动
    resizeHandle.addEventListener('mousedown', function(e) {
        console.log('开始水平拖动 - 禁用部分文本选择');
        isResizing = true;
        startX = e.clientX;
        startWidth = parseInt(document.defaultView.getComputedStyle(container).width, 10);
        resizeHandle.classList.add('active');
        document.body.style.cursor = 'ew-resize';
        // 只在拖动手柄上禁用文本选择，而不是整个页面
        resizeHandle.style.userSelect = 'none';
        container.style.userSelect = 'none';
        
        // 阻止事件冒泡和默认行为
        e.preventDefault();
        e.stopPropagation();
    });
    
    // 拖动过程
    document.addEventListener('mousemove', function(e) {
        if (!isResizing) return;
        
        // 计算新宽度
        const newWidth = startWidth - (e.clientX - startX);
        
        // 限制最小宽度
        if (newWidth >= 400) {
            container.style.width = newWidth + 'px';
        }
        
        // 阻止事件冒泡和默认行为
        e.preventDefault();
        e.stopPropagation();
    });
    
    // 结束拖动
    window.addEventListener('mouseup', function() {
        if (isResizing) {
            console.log('结束水平拖动 - 恢复文本选择');
            isResizing = false;
            resizeHandle.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

// 初始化垂直拖动功能 showAnalysisResults -> initVerticalResizeHandlers
function initVerticalResizeHandlers() {
    console.log('DeepRead: 初始化垂直拖动功能');
    // 使用document.querySelector而非container.querySelector来确保能找到元素
    const explanationSection = document.querySelector('#deepread-explanation-section-id');
    const verticalResizer = document.querySelector('#deepread-vertical-resizer');
    const chatSection = document.querySelector('.deepread-chat-section');
    const contentArea = document.querySelector('#deepread-content');

    if (!explanationSection || !verticalResizer || !chatSection || !contentArea) {
        console.log('DeepRead: 垂直拖动组件未找到，跳过初始化。', {
            explanationSection: explanationSection ? explanationSection.id : null,
            verticalResizer: verticalResizer ? verticalResizer.id : null,
            chatSection: chatSection ? chatSection.className : null,
            contentArea: contentArea ? contentArea.id : null
        });
        return;
    }
    
    // 设置初始高度，确保有一个默认值
    if (!explanationSection.style.height) {
        explanationSection.style.height = '300px';
    }
    
    // 先移除可能存在的旧事件监听器
    const newResizer = verticalResizer.cloneNode(true);
    verticalResizer.parentNode.replaceChild(newResizer, verticalResizer);
    // 重新获取引用
    const updatedResizer = document.querySelector('#deepread-vertical-resizer');
    // 使用updatedResizer代替verticalResizer
    
    // 使用全局变量跟踪拖动状态
    window.isVerticalResizing = false;
    
    // 设置拖动条的样式，增强可见性
    updatedResizer.style.cursor = 'ns-resize';
    updatedResizer.style.backgroundColor = '#e0e0e0';
    updatedResizer.style.height = '5px'; // 增加高度便于拖动
    updatedResizer.title = '上下拖动调整面板高度';
    
    // 定义拖动开始函数
    function handleMouseDown(e) {
        // 阻止默认行为和事件冒泡
        e.preventDefault();
        e.stopPropagation();
        
        window.isVerticalResizing = true;
        const startY = e.clientY;
        const startHeight = explanationSection.offsetHeight;
        
        console.log('开始垂直拖动，初始高度:', startHeight);
        updatedResizer.classList.add('active');
        updatedResizer.style.backgroundColor = '#a0a0a0'; // 拖动时变色
        
        // 更改鼠标样式和禁用文本选择
        console.log('开始垂直拖动 - 禁用文本选择');
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        
        // 直接在document上添加事件监听器
        document.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        
        function handleMouseMove(e) {
            if (!window.isVerticalResizing) return;
            
            const dy = e.clientY - startY;
            const newHeight = startHeight + dy;
            
            // 使用固定的最小高度值
            const minHeight = 100;
            const chatMinHeight = 150;
            const containerHeight = contentArea.offsetHeight;
            const resizerHeight = updatedResizer.offsetHeight || 8;
            
            // 调试输出
            // console.log('拖动中:', {
            //     dy,
            //     newHeight,
            //     containerHeight,
            //     available: containerHeight - resizerHeight
            // });
            
            // 确保调整后的高度在有效范围内
            if (newHeight >= minHeight && (containerHeight - newHeight - resizerHeight) >= chatMinHeight) {
                // 直接设置像素值，而不是使用calc
                explanationSection.style.height = newHeight + 'px';
                explanationSection.style.minHeight = newHeight + 'px';
                explanationSection.style.maxHeight = newHeight + 'px';
                
                // 计算聊天区域高度
                const chatHeight = containerHeight - newHeight - resizerHeight;
                chatSection.style.height = chatHeight + 'px';
                chatSection.style.minHeight = chatHeight + 'px';
            }
            
            // 阻止事件冒泡和默认行为
            e.preventDefault();
            e.stopPropagation();
        }
        
        function handleMouseUp(e) {
            window.isVerticalResizing = false;
            document.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            
            // 恢复鼠标样式和文本选择
            console.log('结束垂直拖动 - 恢复文本选择');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            
            updatedResizer.classList.remove('active');
            updatedResizer.style.backgroundColor = '#e0e0e0'; // 恢复原色
            
            console.log('结束垂直拖动，最终高度:', explanationSection.offsetHeight);
        }
    }
    
    // 添加事件监听器
    updatedResizer.addEventListener('mousedown', handleMouseDown);
}

/**
 * 查找页面中的内容区域（核心代码）
 * @returns {Array} 内容区域元素数组
 */
function findContentAreas() {
    // 尝试查找所有可能的内容区域
    const contentSelectors = [
        '.cmsContent', '.article-content', '.post-body', // 特定CMS容器
        'article', '.article', 'd-article', '.post', '.content', 'main', 
        '#content', '#main', '.main-content', '.post-content',
        '[role="main"]', '[itemprop="articleBody"]'
    ];
    
    // 收集所有内容区域
    let contentAreas = [];
    
    // 先尝试查找所有匹配的内容区域
    for (const selector of contentSelectors) {
        const elements = document.querySelectorAll(selector);
        if (elements && elements.length > 0) {
            console.log(`找到 ${elements.length} 个内容区域: ${selector}`);
            elements.forEach(element => contentAreas.push(element));
        }
    }
    
    // 如果没有找到任何内容区域，则使用body
    if (contentAreas.length === 0) {
        contentAreas.push(document.body);
        debugLog('未找到任何内容区域，使用body');
    }
    
    return contentAreas;
}

/**
 * 获取通用的排除选择器
 * @returns {Array} 排除选择器数组
 */
function getExcludeSelectors() {
    return [
        // Chrome扩展自带的UI元素
        '#deepread-container', '.deepread-float-button', '#deepread-settings-header', '#deepread-settings-panel', 
        '#deepread-settings-title', '#deepread-settings-section', '#deepread-header', '#deepread-settings-item',
        // 常见网站的导航和页脚元素
        'header', 'nav', 'footer', '.header', '.nav', '.navbar', '.footer',
        '.menu', '.sidebar', '.navigation',
        // 广告和其他非内容区域
        '.ad', '.ads', '.advertisement',
        '.comment', '.comments',
        '.social', '.share',
        // 其他可能的UI元素
        '.cookie-banner', '.popup', '.modal',
        '.search', '.search-bar'
    ];
}

// 用户选择文本，点击浮动按钮 事件监听
function addTextSelectionListener() {
    debugLog('添加文本选择事件监听');
    
    document.addEventListener('mouseup', function(event) {
        const selection = window.getSelection();
        const selectedText = selection.toString().trim();

        lastSelectionRange = null;
        lastSelectionParagraphId = null;
        lastSelectionOffsets = null;
        try{
            if (selection && selection.rangeCount > 0){
                lastSelectionRange = selection.getRangeAt(0).cloneRange();
                const paragraphEl = getClosestParagraphElement(lastSelectionRange.commonAncestorContainer);
                if (paragraphEl){
                    lastSelectionParagraphId = paragraphEl.getAttribute('data-dr-paragraph-id') || paragraphEl.id || null;
                    lastSelectionOffsets = calcOffsetWithinParagraph(paragraphEl, lastSelectionRange);
                }
            }
        }catch{
            lastSelectionRange = null;
            lastSelectionParagraphId = null;
            lastSelectionOffsets = null;
        }
        
        if (selectedText && selectedText.length > 1) { // 至少选择2个字符
            // debugLog('选中文本: ' + selectedText);
            
            // 移除现有的浮动按钮
            const existingButtons = document.querySelectorAll('.deepread-float-button');
            existingButtons.forEach(button => {
                if (document.body.contains(button)) {
                    document.body.removeChild(button);
                }
            });
            
            // 创建浮动按钮组：划线 / 解释
            const floatButton = document.createElement('div');
            floatButton.className = 'deepread-float-button';
            floatButton.title = 'DeepRead';
            floatButton.innerHTML = `
                <button class="deepread-float-action deepread-float-highlight" type="button" title="划线">划线</button>
                <button class="deepread-float-action deepread-float-explain" type="button" title="解释">解释</button>
            `;
            
            // 定位浮动按钮到鼠标位置
            floatButton.style.left = (event.pageX + 10) + 'px';
            floatButton.style.top = (event.pageY + 10) + 'px';
            
            // 阻止mousedown和mouseup事件冒泡，防止触发document的mouseup重新定位按钮
            floatButton.addEventListener('mousedown', function(e) {
                e.stopPropagation();
                e.preventDefault();
            });
            
            floatButton.addEventListener('mouseup', function(e) {
                e.stopPropagation();
                e.preventDefault();
            });
            
            const btnHighlight = floatButton.querySelector('.deepread-float-highlight');
            const btnExplain = floatButton.querySelector('.deepread-float-explain');

            if (btnHighlight){
                btnHighlight.addEventListener('click', async function(e) {
                    e.stopPropagation();
                    e.preventDefault();

                    console.log('[DeepRead][HighlightClick] clicked');
                    console.log('[DeepRead][HighlightClick] lastSelectionParagraphId:', lastSelectionParagraphId);
                    console.log('[DeepRead][HighlightClick] lastSelectionOffsets:', lastSelectionOffsets);
                    console.log('[DeepRead][HighlightClick] selectedText(mouseup):', selectedText);

                    // 移除浮动按钮
                    if (document.body.contains(floatButton)) {
                        document.body.removeChild(floatButton);
                    }

                    // 划线：仅限同段落，且必须能算出 offsets
                    if (!lastSelectionParagraphId || !lastSelectionOffsets) {
                        console.warn('[DeepRead][HighlightClick] abort: missing paragraphId or offsets');
                        return;
                    }
                    const { start, end } = normalizeRangeOffsets(lastSelectionOffsets.start, lastSelectionOffsets.end);
                    console.log('[DeepRead][HighlightClick] normalized offsets:', { start, end });
                    if (end <= start) {
                        console.warn('[DeepRead][HighlightClick] abort: end <= start');
                        return;
                    }

                    const paragraphEl = findParagraphEl(lastSelectionParagraphId);
                    if (!paragraphEl) {
                        console.warn('[DeepRead][HighlightClick] abort: paragraphEl not found for id:', lastSelectionParagraphId);
                        return;
                    }
                    console.log('[DeepRead][HighlightClick] paragraphEl:', paragraphEl);
                    console.log('[DeepRead][HighlightClick] paragraphEl.tagName:', paragraphEl.tagName);
                    console.log('[DeepRead][HighlightClick] paragraphEl.textContent.length:', (paragraphEl.textContent || '').length);

                    const highlight = {
                        id: generateHighlightId(),
                        url: window.location.href,
                        paragraphId: lastSelectionParagraphId,
                        start,
                        end,
                        text: (lastSelectionOffsets.text || selectedText || '').trim(),
                        createdAt: Date.now()
                    };

                    console.log('[DeepRead][HighlightClick] highlight obj:', highlight);

                    highlightHistory = Array.isArray(highlightHistory) ? highlightHistory : [];
                    highlightHistory.push(highlight);
                    console.log('[DeepRead][HighlightClick] highlightHistory.length:', highlightHistory.length);

                    try{
                        const span = wrapHighlightInParagraph(paragraphEl, highlight);
                        console.log('[DeepRead][HighlightClick] wrap result span:', span);
                    }catch(err){
                        console.warn('划线包裹失败:', err);
                    }

                    try{
                        await saveHighlightsToCache();
                        console.log('[DeepRead][HighlightClick] saved highlights to cache');
                    }catch(err){
                        console.warn('划线缓存失败:', err);
                    }

                    // 只要用户成功划线，就自动展开左侧 minimap（与右侧面板解耦）
                    // 这里传 false，避免触发 restore 导致重复 wrap
                    showDeepReadMinimapPinned(false);

                    // 左侧 minimap 独立：只要可见就刷新 dots + 预览（不依赖右侧面板）
                    setSelectedHighlightId(highlight.id);
                    updateMinimapUIIfVisible({ previewText: highlight.text || '', previewHid: highlight.id });
                });
            }

            if (btnExplain){
                btnExplain.addEventListener('click', function(e) {
                    e.stopPropagation();
                    e.preventDefault();
                    debugLog('点击了解释，选中文本: ' + selectedText);

                    // 移除浮动按钮
                    if (document.body.contains(floatButton)) {
                        document.body.removeChild(floatButton);
                    }

                    if (!pageAnalyzed){
                        if (!document.getElementById('deepread-container')) {
                            createDeepReadPanel();
                        }
                        const container = document.getElementById('deepread-container');
                        if (container) {
                            container.classList.remove('deepread-hidden');
                        }
                        if (!window.__deepreadExplainGuideShownForUrl || window.__deepreadExplainGuideShownForUrl !== window.location.href){
                            window.__deepreadExplainGuideShownForUrl = window.location.href;
                            try{
                                extractPageContent();
                            }catch(err){
                                console.warn('DeepRead: 解释前引导分析失败:', err);
                            }
                        } else {
                            try{
                                if (pageContent) viewTextEditor(pageContent);
                            }catch{}
                        }
                        return;
                    }

                    // 解释：保持旧逻辑（不产生划线）
                    const anchorData = { paragraphId: lastSelectionParagraphId };
                    if (lastSelectionOffsets){
                        anchorData.start = lastSelectionOffsets.start;
                        anchorData.end = lastSelectionOffsets.end;
                        anchorData.text = lastSelectionOffsets.text;
                    }
                    openDeepReadWithConcept(selectedText, anchorData);
                });
            }
            
            // 添加到页面
            document.body.appendChild(floatButton);
            
            // 60秒后自动移除浮动按钮
            setTimeout(function() {
                if (document.body.contains(floatButton)) {
                    document.body.removeChild(floatButton);
                }
            }, 60000);
        }
    });
}

/**
 * 通用的Google Gemini API调用函数
 * @param {Array} contents 请求内容，包含系统提示词和用户消息
 * @param {string} apiType 调用类型，用于日志记录和错误处理
 * @param {boolean} expectJson 是否期望返回结果是JSON
 * @param {Object} fallbackResponse 当出错时的预设回退响应
 * @returns {Promise<Object|string>} API响应结果
 */
async function callGeminiAPI(contents, apiType, expectJson = false, fallbackResponse = {}) {
    try {
        // 获取用户设置的API Key
        let API_KEY = null;
        // 如果是在扩展环境中，使用Chrome存储API
        if (isExtensionEnvironment && chrome.storage) {
            // 由于 chrome.storage.sync.get 是异步的，我们需要将其转换为 Promise
            API_KEY = await new Promise(resolve => {
                chrome.storage.sync.get(['deepread_api_key'], function(result) {
                    resolve(result.deepread_api_key || null);
                });
            });
        } else {
            // 如果不是在扩展环境中，使用localStorage
            API_KEY = localStorage.getItem('deepread_api_key');
        }
        // 检查API Key是否有效
        if (!API_KEY) {
            alert('请先在设置面板中设置您的 API Key，然后刷新页面！');
            throw new Error('未设置 API Key，请在设置面板中设置您的 Google Gemini API Key');
        }
        
        // 尝试从存储中获取用户配置的MODEL和thinkingLevel
        let userModelId = MODEL_ID;
        let userThinkingLevel = 'MINIMAL';
        if (isExtensionEnvironment && chrome.storage) {
            try {
                // 同步获取存储的MODEL和thinkingLevel
                const result = await new Promise(resolve => {
                    chrome.storage.sync.get(['deepread_model', 'deepread_thinking_level'], resolve);
                });
                
                if (result.deepread_model && result.deepread_model.trim() !== '') {
                    userModelId = result.deepread_model.trim();
                    debugLog(`使用用户配置的MODEL: ${userModelId}`);
                }
                if (result.deepread_thinking_level) {
                    userThinkingLevel = result.deepread_thinking_level;
                    debugLog(`使用用户配置的thinkingLevel: ${userThinkingLevel}`);
                }
            } catch (error) {
                console.error('获取用户配置失败:', error);
                // 出错时使用默认值
            }
        } else {
            // 非扩展环境使用 localStorage
            const storedModel = localStorage.getItem('deepread_model');
            const storedThinkingLevel = localStorage.getItem('deepread_thinking_level');
            if (storedModel) userModelId = storedModel;
            if (storedThinkingLevel) userThinkingLevel = storedThinkingLevel;
        }

        const API_URL = API_BASE_URL + `${userModelId}:generateContent?key=${API_KEY}`
        // 请求配置
        const requestBody = {
            // model: PROVIDER + '/' + MODEL_ID, // openrouter
            // messages: contents, // openrouter
            // temperature: 0.7,
            // top_p: 0.95,
            // top_k: 64,
            // max_tokens: 8192,
            contents: contents, // google
            generationConfig: { // google
                responseMimeType: 'text/plain',
                temperature: 0.7,
                topP: 0.95,
                topK: 64,
                maxOutputTokens: 8192,
                thinkingConfig: {
                    thinkingLevel: userThinkingLevel, // MINIMAL, LOW, MEDIUM, HIGH 
                },
            },
            tools: [
                {
                    urlContext: {}
                },
                {
                    googleSearch: {}
                },
            ],
        };
        debugLog(`${apiType} 发送请求到API \n ${API_URL}`);
        
        // 创建AbortController来设置超时
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000); // 300秒超时
        // 发送请求
        let response;
        try {
            response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    // "Authorization": "Bearer " + API_KEY, // openrouter
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal // 使用AbortController的signal
            });
            
            // 请求完成后清除超时定时器
            clearTimeout(timeoutId);
        } catch (fetchError) {
            // 清除超时定时器
            clearTimeout(timeoutId);
            
            // 如果是超时错误
            if (fetchError.name === 'AbortError') {
                console.error(`${apiType} API请求超时（300秒）`);
                throw new Error(`API请求超时，请检查网络连接或稍后再试`);
            }
            
            // 其他网络错误
            console.error(`${apiType} API请求错误：`, fetchError);
            throw fetchError;
        }
        
        // 检查响应状态
        if (!response.ok) {
            const errorData = await response.json();
            console.error(`${apiType} API请求失败：`, errorData);
            throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
        }
        
        // 解析响应
        const responseData = await response.json();
        debugLog(`${apiType} API响应: \n ${JSON.stringify(responseData, null, 2)}`);
        // 根据响应结构自动选择解析器：OpenRouter(choices) vs Google(candidates)
        if (responseData && Array.isArray(responseData.choices)) {
            return parseOpenRouterResponse(responseData, apiType, expectJson, fallbackResponse);
        }
        return parseGeminiResponse(responseData, apiType, expectJson, fallbackResponse);
    } catch (error) {
        console.error(`${apiType} 调用出错:`, error);
        // 返回预设的回退响应
        return fallbackResponse;
    }
}

/**
 * 流式调用Google Gemini API函数
 * @param {Array} contents 请求内容，包含系统提示词和用户消息
 * @param {string} apiType 调用类型，用于日志记录和错误处理
 * @param {Function} onChunk 每收到一个数据块时的回调函数
 * @param {Function} onComplete 所有数据接收完成时的回调函数
 * @param {Function} onError 发生错误时的回调函数
 * @returns {Promise<void>} 无返回值，通过回调函数处理结果
 */
async function callGeminiAPIStream(contents, apiType, onChunk, onComplete, onError) {
    try {
        // 获取用户设置的API Key
        let API_KEY = null;
        // 如果是在扩展环境中，使用Chrome存储API
        if (isExtensionEnvironment && chrome.storage) {
            // 由于 chrome.storage.sync.get 是异步的，我们需要将其转换为 Promise
            API_KEY = await new Promise(resolve => {
                chrome.storage.sync.get(['deepread_api_key'], function(result) {
                    resolve(result.deepread_api_key || null);
                });
            });
        } else {
            // 如果不是在扩展环境中，使用localStorage
            API_KEY = localStorage.getItem('deepread_api_key');
        }
        // 检查API Key是否有效
        if (!API_KEY) {
            const errorMsg = '未设置 API Key，请在设置面板中设置您的 Google Gemini API Key';
            alert('请先在设置面板中设置您的 API Key，然后刷新页面！');
            if (onError) onError(new Error(errorMsg));
            return;
        }
        
        // 尝试从存储中获取用户配置的MODEL和thinkingLevel
        let userModelId = MODEL_ID;
        let userThinkingLevel = 'MINIMAL';
        if (isExtensionEnvironment && chrome.storage) {
            try {
                // 同步获取存储的MODEL和thinkingLevel
                const result = await new Promise(resolve => {
                    chrome.storage.sync.get(['deepread_model', 'deepread_thinking_level'], resolve);
                });
                
                if (result.deepread_model && result.deepread_model.trim() !== '') {
                    userModelId = result.deepread_model.trim();
                    debugLog(`使用用户配置的MODEL: ${userModelId}`);
                }
                if (result.deepread_thinking_level) {
                    userThinkingLevel = result.deepread_thinking_level;
                    debugLog(`使用用户配置的thinkingLevel: ${userThinkingLevel}`);
                }
            } catch (error) {
                console.error('获取用户配置失败:', error);
                // 出错时使用默认值
            }
        } else {
            // 非扩展环境使用 localStorage
            const storedModel = localStorage.getItem('deepread_model');
            const storedThinkingLevel = localStorage.getItem('deepread_thinking_level');
            if (storedModel) userModelId = storedModel;
            if (storedThinkingLevel) userThinkingLevel = storedThinkingLevel;
        }
        
        // 使用 streamGenerateContent API
        const STREAM_API_URL = API_BASE_URL + `${userModelId}:streamGenerateContent?key=${API_KEY}`;
        // 请求配置
        const requestBody = {
            contents: contents,
            generationConfig: {
                responseMimeType: 'text/plain',
                temperature: 0.7,
                topP: 0.95,
                topK: 64,
                maxOutputTokens: 8192,
                thinkingConfig: {
                    thinkingLevel: userThinkingLevel,
                },
            },
            tools: [
                {
                    urlContext: {}
                },
                {
                    googleSearch: {}
                },
            ],
        };
        debugLog(`${apiType} 发送流式请求到 API \n ${STREAM_API_URL}`);
        
        // 创建AbortController来设置超时
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000); // 300秒超时
        
        // 发送请求
        let response;
        try {
            response = await fetch(STREAM_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal // 使用AbortController的signal
            });
            
            // 请求完成后清除超时定时器
            clearTimeout(timeoutId);
        } catch (fetchError) {
            // 清除超时定时器
            clearTimeout(timeoutId);
            
            // 如果是超时错误
            if (fetchError.name === 'AbortError') {
                console.error(`${apiType} 流式API请求超时（300秒）`);
                if (onError) onError(new Error(`API请求超时，请检查网络连接或稍后再试`));
                return;
            }
            
            // 其他网络错误
            console.error(`${apiType} 流式API请求错误：`, fetchError);
            if (onError) onError(fetchError);
            return;
        }
        
        // 检查响应状态
        if (!response.ok) {
            const errorData = await response.json();
            console.error(`${apiType} 流式API请求失败：`, errorData);
            if (onError) onError(new Error(`API请求失败: ${response.status} ${response.statusText}`));
            return;
        }
        
        // 处理流式响应
        try {
            // 读取响应流
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let completeResponse = '';
            let streamGroundingMetadata = null; // 在流式处理中收集groundingMetadata
            
            // 处理流式数据
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                // 解码二进制数据为文本
                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;
                
                // 尝试解析JSON数据块
                // 注意：流式响应可能会分多次返回，需要处理不完整的JSON
                try {
                    // 检查是否有完整的JSON对象
                    let startPos = 0;
                    while (startPos < buffer.length) {
                        // 查找JSON对象的开始和结束
                        const jsonStart = buffer.indexOf('{', startPos);
                        if (jsonStart === -1) break;
                        
                        let jsonEnd = -1;
                        let braceCount = 0;
                        let inString = false;
                        let escapeNext = false;
                        
                        // 查找匹配的右括号
                        for (let i = jsonStart; i < buffer.length; i++) {
                            const char = buffer[i];
                            
                            if (escapeNext) {
                                escapeNext = false;
                                continue;
                            }
                            
                            if (char === '\\') {
                                escapeNext = true;
                                continue;
                            }
                            
                            if (char === '"') {
                                inString = !inString;
                                continue;
                            }
                            
                            if (!inString) {
                                if (char === '{') {
                                    braceCount++;
                                } else if (char === '}') {
                                    braceCount--;
                                    if (braceCount === 0) {
                                        jsonEnd = i + 1;
                                        break;
                                    }
                                }
                            }
                        }
                        
                        // 如果找到了完整的JSON对象
                        if (jsonEnd !== -1) {
                            const jsonStr = buffer.substring(jsonStart, jsonEnd);
                            try {
                                const jsonObj = JSON.parse(jsonStr);
                                
                                // 处理响应块
                                if (jsonObj.candidates && jsonObj.candidates[0] && 
                                    jsonObj.candidates[0].content && jsonObj.candidates[0].content.parts) {
                                    
                                    const candidate = jsonObj.candidates[0];
                                    const responseText = candidate.content.parts[0].text || '';
                                    
                                    // 累积完整响应
                                    completeResponse += responseText;
                                    
                                    // 收集groundingMetadata（核心代码）
                                    if (candidate.groundingMetadata && 
                                        Object.keys(candidate.groundingMetadata).length > 0) {
                                        streamGroundingMetadata = candidate.groundingMetadata;
                                        debugLog(`${apiType} 流式响应中收集到groundingMetadata，包含: ${Object.keys(candidate.groundingMetadata).join(', ')}`);
                                    }
                                    
                                    // 始终调用回调函数处理当前块，无论是否有groundingMetadata
                                    // console.log('callStream', responseText)
                                    if (onChunk) onChunk(responseText);
                                }
                                
                                // 移除已处理的JSON
                                buffer = buffer.substring(jsonEnd);
                                startPos = 0;
                            } catch (jsonError) {
                                // JSON解析错误，可能是不完整的JSON，继续等待更多数据
                                startPos = jsonStart + 1;
                            }
                        } else {
                            // 没有找到完整的JSON对象，等待更多数据
                            break;
                        }
                    }
                } catch (parseError) {
                    console.error(`${apiType} 解析流式响应时出错:`, parseError);
                    // 继续处理，不中断流
                }
            }
            
            // 所有数据接收完成后，处理完整响应
            debugLog(`${apiType} 流式响应接收完成，总长度: ${completeResponse.length}`);
            
            // 尝试从buffer中解析最后一个完整的JSON对象，它可能包含groundingMetadata
            try {
                if (buffer.trim()) {
                    const lastJsonStart = buffer.lastIndexOf('{');
                    if (lastJsonStart !== -1) {
                        const lastJsonStr = buffer.substring(lastJsonStart);
                        const lastJsonObj = JSON.parse(lastJsonStr);
                        if (lastJsonObj.candidates && lastJsonObj.candidates[0]) {
                            lastCandidate = lastJsonObj.candidates[0];
                            debugLog(`${apiType} 成功解析最后一个响应块，可能包含groundingMetadata`);
                        }
                    }
                }
            } catch (error) {
                console.error(`${apiType} 解析最后一个响应块时出错:`, error);
                // 继续处理，不中断流程
            }
            
            // 构造完整响应对象
            const fullResponseData = {
                candidates: [{
                    content: {
                        parts: [{
                            text: completeResponse
                        }]
                    },
                    // 只有当groundingMetadata存在且不为空对象时才添加
                    ...(streamGroundingMetadata && Object.keys(streamGroundingMetadata).length > 0 ? 
                        { groundingMetadata: streamGroundingMetadata } : {})
                }]
            };
            
            // 使用parseGeminiResponse处理完整响应，这里会处理groundingMetadata
            const processedResponse = parseGeminiResponse(fullResponseData, apiType, false);
            
            debugLog(`${apiType} 流式响应处理完成，最终响应长度: ${processedResponse.length}`);
            
            // 调用完成回调，传递处理后的响应
            if (onComplete) onComplete(processedResponse);
            
        } catch (streamError) {
            console.error(`${apiType} 处理流式响应时出错:`, streamError);
            if (onError) onError(streamError);
        }
    } catch (error) {
        console.error(`${apiType} 流式调用出错:`, error);
        if (onError) onError(error);
    }
}

/**
 * 调用Gemini多模态API，支持生成图像
 * @param {Array} contents 请求内容
 * @param {string} apiType API类型描述（用于日志）
 * @param {boolean} expectJson 是否期望返回JSON格式
 * @param {object} fallbackResponse 当请求失败时的默认响应
 * @returns {object} 包含文本和图像的响应对象
 */
// @deprecated
async function callGeminiAPIDraw(contents, apiType, expectJson = false, fallbackResponse = {}) {
    try {
        // 获取用户设置的API Key
        let API_KEY = null;
        // 如果是在扩展环境中，使用Chrome存储API
        if (isExtensionEnvironment && chrome.storage) {
            // 由于 chrome.storage.sync.get 是异步的，我们需要将其转换为 Promise
            API_KEY = await new Promise(resolve => {
                chrome.storage.sync.get(['deepread_api_key'], function(result) {
                    resolve(result.deepread_api_key || null);
                });
            });
        } else {
            // 如果不是在扩展环境中，使用localStorage
            API_KEY = localStorage.getItem('deepread_api_key');
        }
        // 检查API Key是否有效
        if (!API_KEY) {
            alert('请先在设置面板中设置您的 API Key，然后刷新页面！');
            throw new Error('未设置 API Key，请在设置面板中设置您的 Google Gemini API Key');
        }
        
        // 尝试从存储中获取用户配置的MODEL
        if (isExtensionEnvironment && chrome.storage) {
            try {
                // 同步获取存储的MODEL
                const result = await new Promise(resolve => {
                    chrome.storage.sync.get(['deepread_model'], resolve);
                });
                
                if (result.deepread_model && result.deepread_model.trim() !== '') {
                    MODEL_ID = result.deepread_model.trim();
                    debugLog(`使用用户配置的MODEL: ${MODEL_ID}`);
                }
            } catch (error) {
                console.error('获取用户配置的MODEL失败:', error);
                // 出错时使用默认MODEL
            }
        }
        
        const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent?key=${API_KEY}`;
        
        // 请求配置 - 注意多模态特有的配置 responseModalities
        const requestBody = {
            contents: contents,
            generationConfig: {
                temperature: 0.7,
                topP: 0.95,
                topK: 64,
                maxOutputTokens: 8192,
                responseModalities: ["IMAGE", "TEXT"] // 指定响应包含图像和文本
            }
        };
        
        debugLog(`发送 ${apiType} 请求到 Google Gemini API \n ${API_URL}`);
        
        // 创建AbortController来设置超时
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000); // 300秒超时
        
        let response;
        try {
            // 发送请求
            response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal // 使用AbortController的signal
            });
            
            // 请求完成后清除超时定时器
            clearTimeout(timeoutId);
        } catch (fetchError) {
            // 清除超时定时器
            clearTimeout(timeoutId);
            
            // 如果是超时错误
            if (fetchError.name === 'AbortError') {
                console.error(`${apiType}API请求超时（300秒）`);
                throw new Error(`API请求超时，请检查网络连接或稍后再试`);
            }
            
            // 其他网络错误
            console.error(`${apiType}API请求错误：`, fetchError);
            throw fetchError;
        }
        
        // 检查响应状态
        if (!response.ok) {
            const errorData = await response.json();
            console.error(`${apiType} API请求失败：`, errorData);
            throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
        }
        
        // 解析响应
        const responseData = await response.json();
        
        // 提取文本和图像响应
        if (responseData.candidates && responseData.candidates[0] && 
            responseData.candidates[0].content && responseData.candidates[0].content.parts) {
            
            const parts = responseData.candidates[0].content.parts;
            let result = {
                text: '',
                images: []
            };
            
            // 遍历所有响应部分
            for (const part of parts) {
                if (part.text) {
                    // 文本部分
                    result.text += part.text;
                } else if (part.inlineData && part.inlineData.mimeType && part.inlineData.mimeType.startsWith('image/')) {
                    // 图像部分
                    result.images.push({
                        mimeType: part.inlineData.mimeType,
                        data: part.inlineData.data // base64编码的图像数据
                    });
                }
            }
            
            // debugLog(`${apiType} 提取到文本和 ${result.images.length} 张图像`);
            return result;
        } else {
            throw new Error(`${apiType} 响应格式不符合预期`);
        }
    } catch (error) {
        console.error(`${apiType} 调用出错:`, error);
        // 返回预设的回退响应
        return {
            text: typeof fallbackResponse === 'string' ? fallbackResponse : imageGenerationFallback,
            images: []
        };
    }
}

/**
 * 解析Gemini API的响应，处理带有groundingMetadata的搜索结果
 * @param {Object} responseData API返回的原始响应数据
 * @param {string} apiType 调用类型，用于日志记录和错误处理
 * @param {boolean} expectJson 是否期望返回结果是JSON
 * @param {Object} fallbackResponse 当出错时的预设回退响应
 * @returns {Object|string} 处理后的响应结果
 */
function parseGeminiResponse(responseData, apiType, expectJson = false, fallbackResponse = {}) {
    try {
        // 检查响应中是否包含候选项
        if (responseData.candidates && responseData.candidates[0] && 
            responseData.candidates[0].content && responseData.candidates[0].content.parts) {
            
            const candidate = responseData.candidates[0];
            const responseText = candidate.content.parts[0].text;
            debugLog(`${apiType} Google Gemini API 收到的原始响应文本: ${responseText}`);
            // 在第1152行后添加：
            debugLog(`${apiType} 检查groundingMetadata条件:`);
            debugLog(`  candidate.groundingMetadata存在: ${!!candidate.groundingMetadata}`);
            if (candidate.groundingMetadata) {
                debugLog(`  groundingMetadata keys: ${Object.keys(candidate.groundingMetadata).join(', ')}`);
            }
            // 检查是否包含groundingMetadata（使用搜索tool后返回）
            if (candidate.groundingMetadata && apiType.indexOf('聊天') !== -1) {
                debugLog(`${apiType} 检测到groundingMetadata，处理搜索结果引用`);
                
                // 处理搜索结果
                const processedResponse = processGroundingMetadata(responseText, candidate.groundingMetadata);
                
                // 如果期望返回JSON，但处理后的响应不是JSON格式
                if (expectJson) {
                    try {
                        // 尝试将处理后的响应转换为JSON
                        if (typeof processedResponse === 'string') {
                            // 处理Markdown代码块格式
                            let processedText = processedResponse;
                            
                            // 检查是否是Markdown代码块
                            const jsonCodeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/;
                            const match = processedText.match(jsonCodeBlockRegex);
                            
                            if (match && match[1]) {
                                debugLog(`${apiType} 检测到Markdown代码块格式，正在提取JSON内容`);
                                processedText = match[1].trim();
                            }
                            
                            // 尝试修复常见的JSON格式错误
                            processedText = fixCommonJsonErrors(processedText);
                            
                            // 检查处理后的文本是否是JSON格式
                            if (processedText.trim().startsWith('{') && processedText.trim().endsWith('}')) {
                                try {
                                    return JSON.parse(processedText);
                                } catch (jsonError) {
                                    console.error(`${apiType} JSON解析错误:`, jsonError, '尝试使用安全的JSON解析方法');
                                    
                                    // 尝试使用更安全的方法解析JSON
                                    try {
                                        // 使用手动修复常见的JSON问题
                                        const manuallyFixedJson = manualJsonFix(processedText);
                                        debugLog('手动修复后的JSON:' + manuallyFixedJson);
                                        
                                        // 尝试解析手动修复的JSON
                                        const jsonObj = JSON.parse(manuallyFixedJson);
                                        debugLog('使用手动修复方法成功');
                                        return jsonObj;
                                    } catch (fixError) {
                                        console.error('手动修复方法失败:', fixError);
                                        // 如果手动修复失败，使用预设的回退响应
                                        debugLog('使用预设的回退响应');
                                        return fallbackResponse;
                                    }
                                }
                            } else {
                                // 如果不是JSON格式，返回预设的回退响应
                                debugLog(`${apiType} 响应不是JSON格式，使用原始文本`);
                                // 将原始文本放入预设对象的第一个属性
                                const firstKey = Object.keys(fallbackResponse)[0];
                                if (firstKey) {
                                    fallbackResponse[firstKey] = processedText;
                                }
                                return fallbackResponse;
                            }
                        } else if (typeof processedResponse === 'object') {
                            // 如果已经是对象，直接返回
                            return processedResponse;
                        }
                    } catch (parseError) {
                        console.error(`${apiType} 解析JSON响应时出错:`, parseError);
                        // 如果无法解析，返回预设的回退响应
                        return fallbackResponse;
                    }
                } else {
                    // 直接返回处理后的文本
                    return processedResponse;
                }
            } 
            // 没有groundingMetadata，按原来的方式处理
            else {
                debugLog(`${apiType} 没有groundingMetadata，按原来的方式处理`);
                if (expectJson) {
                    try {
                        // 尝试解析JSON响应，只有当响应是字符串时才需要解析
                        if (typeof responseText === 'string') {
                            // 处理Markdown代码块格式，如果是```json ... ```格式
                            let processedText = responseText;
                            
                            // 检查是否是Markdown代码块
                            const jsonCodeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/;
                            const match = processedText.match(jsonCodeBlockRegex);
                            
                            if (match && match[1]) {
                                debugLog(`${apiType} 检测到Markdown代码块格式，正在提取JSON内容`);
                                processedText = match[1].trim();
                            }
                            
                            // 尝试修复常见的JSON格式错误
                            processedText = fixCommonJsonErrors(processedText);
                            
                            // 检查处理后的文本是否是JSON格式
                            if (processedText.trim().startsWith('{') && processedText.trim().endsWith('}')) {
                                try {
                                    return JSON.parse(processedText);
                                } catch (jsonError) {
                                    console.error(`${apiType} JSON解析错误:`, jsonError, '尝试使用安全的JSON解析方法');
                                    
                                    // 尝试使用更安全的方法解析JSON
                                    try {
                                        // 使用手动修复常见的JSON问题
                                        const manuallyFixedJson = manualJsonFix(processedText);
                                        debugLog('手动修复后的JSON:' + manuallyFixedJson);
                                        
                                        // 尝试解析手动修复的JSON
                                        const jsonObj = JSON.parse(manuallyFixedJson);
                                        debugLog('使用手动修复方法成功');
                                        return jsonObj;
                                    } catch (fixError) {
                                        console.error('手动修复方法失败:', fixError);
                                        // 如果手动修复失败，使用预设的回退响应
                                        debugLog('使用预设的回退响应');
                                        return fallbackResponse;
                                    }
                                }
                            } else {
                                // 如果不是JSON格式，返回预设的回退响应
                                debugLog(`${apiType} 响应不是JSON格式，使用原始文本`);
                                // 将原始文本放入预设对象的第一个属性
                                const firstKey = Object.keys(fallbackResponse)[0];
                                if (firstKey) {
                                    fallbackResponse[firstKey] = processedText;
                                }
                                return fallbackResponse;
                            }
                        } else if (typeof responseText === 'object') {
                            // 如果已经是对象，直接返回
                            return responseText;
                        }
                    } catch (parseError) {
                        console.error(`${apiType} 解析JSON响应时出错:`, parseError);
                        // 如果无法解析，返回预设的回退响应
                        return fallbackResponse;
                    }
                } else {
                    // 直接返回文本
                    return responseText;
                }
            }
        } else {
            throw new Error(`${apiType} 响应格式不符合预期`);
        }
    } catch (error) {
        console.error(`${apiType} 解析响应时出错:`, error);
        return expectJson ? fallbackResponse : (typeof fallbackResponse === 'string' ? fallbackResponse : '解析响应时出错');
    }
}

/**
 * 解析 OpenRouter Chat Completions 响应
 * 典型结构：
 * {
 *   id, provider, model, object, created,
 *   choices: [{ index, finish_reason, message: { role, content } }],
 *   usage: {...}
 * }
 */
function parseOpenRouterResponse(responseData, apiType, expectJson = false, fallbackResponse = {}) {
    try {
        if (!responseData || !Array.isArray(responseData.choices) || !responseData.choices[0]) {
            throw new Error(`${apiType} OpenRouter 响应格式不符合预期`);
        }
        const choice = responseData.choices[0];
        const message = choice.message || {};
        const content = typeof message.content === 'string' ? message.content : '';
        debugLog(`${apiType} OpenRouter 原始响应: ${content}`);

        if (expectJson) {
            try {
                // 提取 ```json ... ``` 或 ``` ... ``` 代码块
                let processedText = content;
                const jsonCodeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/;
                const match = processedText.match(jsonCodeBlockRegex);
                if (match && match[1]) {
                    debugLog(`${apiType} 检测到Markdown代码块，提取其中JSON`);
                    processedText = match[1].trim();
                }
                // 常见修复
                processedText = fixCommonJsonErrors(processedText);

                if (processedText && processedText.trim().startsWith('{') && processedText.trim().endsWith('}')) {
                    try {
                        return JSON.parse(processedText);
                    } catch (jsonError) {
                        console.error(`${apiType} OpenRouter JSON解析错误:`, jsonError, '尝试手动修复');
                        try {
                            const manuallyFixedJson = manualJsonFix(processedText);
                            const jsonObj = JSON.parse(manuallyFixedJson);
                            debugLog('OpenRouter 使用手动修复方法成功');
                            return jsonObj;
                        } catch (fixError) {
                            console.error('OpenRouter 手动修复失败:', fixError);
                            // 将原始文本塞到fallback第一个字段，尽量提供信息
                            const firstKey = Object.keys(fallbackResponse)[0];
                            if (firstKey) fallbackResponse[firstKey] = content;
                            return fallbackResponse;
                        }
                    }
                } else {
                    debugLog(`${apiType} OpenRouter 响应非JSON格式，返回回退对象`);
                    const firstKey = Object.keys(fallbackResponse)[0];
                    if (firstKey) fallbackResponse[firstKey] = processedText || content;
                    return fallbackResponse;
                }
            } catch (parseError) {
                console.error(`${apiType} OpenRouter 解析JSON响应时出错:`, parseError);
                return fallbackResponse;
            }
        } else {
            // 不需要JSON，直接返回文本
            return content;
        }
    } catch (error) {
        console.error(`${apiType} OpenRouter 解析响应时出错:`, error);
        return expectJson ? fallbackResponse : (typeof fallbackResponse === 'string' ? fallbackResponse : '解析响应时出错');
    }
}

/**
 * 处理Gemini API返回的groundingMetadata，添加引用标记和Sources区块
 * @param {string} responseText 原始响应文本
 * @param {Object} groundingMetadata 搜索元数据
 * @returns {string} 处理后的响应文本，包含引用标记和Sources区块
 */
function processGroundingMetadata(responseText, groundingMetadata) {
    try {
        debugLog('processGroundingMetadata 处理groundingMetadata');
        // debugLog('处理groundingMetadata，数据结构:', JSON.stringify(groundingMetadata, null, 2));
        
        if (!groundingMetadata) {
            debugLog('没有groundingMetadata，返回原文');
            return responseText;
        }
        
        let processedText = responseText;
        let sources = [];
        let hasDetailedSupports = false;
        
        // 第一步：从 searchEntryPoint 提取基本的搜索链接
        if (groundingMetadata.searchEntryPoint && groundingMetadata.webSearchQueries) {
            debugLog('检测到searchEntryPoint，提取搜索链接');
            
            const renderedContent = groundingMetadata.searchEntryPoint.renderedContent;
            const linkMatches = renderedContent.match(/href="([^"]+)"/g);
            
            if (linkMatches && linkMatches.length > 0) {
                // 从 searchEntryPoint 提取链接
                const searchLinks = linkMatches.map(match => {
                    const url = match.match(/href="([^"]+)"/)[1];
                    return url;
                });
                
                // 使用搜索查询作为默认标题
                const searchQuery = groundingMetadata.webSearchQueries[0] || '搜索结果';
                
                // 将 searchEntryPoint 的链接添加到 sources
                searchLinks.forEach(link => {
                    let title = searchQuery;
                    try {
                        const url = new URL(link);
                        title = url.hostname;
                    } catch (e) {
                        // 如果无法解析URL，使用搜索查询作为标题
                    }
                    
                    // 去重添加到 sources
                    if (!sources.find(s => s.uri === link)) {
                        sources.push({ uri: link, title });
                    }
                });
            }
        }
        
        // 第二步：如果有 groundingChunks，优先使用其中的链接和标题
        if (groundingMetadata.groundingChunks && groundingMetadata.groundingChunks.length > 0) {
            debugLog('检测到groundingChunks，提取详细的源信息');
            
            // 清空之前的 sources，优先使用 groundingChunks 中的信息
            sources = [];
            const sourceMap = new Map();
            
            groundingMetadata.groundingChunks.forEach((chunk, index) => {
                if (chunk && chunk.web) {
                    const { uri, title } = chunk.web;
                    if (!sourceMap.has(uri)) {
                        sourceMap.set(uri, sources.length + 1);
                        sources.push({ uri, title: title || uri });
                        // debugLog(`添加源 ${sources.length}: ${title || uri}`);
                    }
                }
            });
        }
        
        // 第三步：如果有 groundingSupports，进行精确的引用标记
        if (groundingMetadata.groundingSupports && groundingMetadata.groundingSupports.length > 0 && sources.length > 0) {
            debugLog('检测到groundingSupports，进行精确引用标记');
            hasDetailedSupports = true;
            
            // 使用原有的精确引用逻辑
            const sourceMap = new Map();
            sources.forEach((source, index) => {
                sourceMap.set(source.uri, index + 1);
            });
            
            // 按照endIndex从大到小排序，从后向前插入引用标记
            const sortedSupports = [...groundingMetadata.groundingSupports].sort((a, b) => 
                b.segment.endIndex - a.segment.endIndex
            );
            
            const segmentProcessed = new Set();
            
            for (let i = 0; i < sortedSupports.length; i++) {
                const support = sortedSupports[i];
                const { segment, groundingChunkIndices } = support;
                
                if (!segment || !segment.text) {
                    continue;
                }
                
                const expectedText = segment.text;
                const segmentKey = `${segment.startIndex || 0}_${segment.endIndex}_${expectedText.substring(0, 50)}`;
                
                if (segmentProcessed.has(segmentKey)) {
                    continue;
                }
                
                // 查找匹配文本
                let foundIndex = -1;
                let searchStartIndex = 0;
                
                while (true) {
                    const tempIndex = processedText.indexOf(expectedText, searchStartIndex);
                    if (tempIndex === -1) break;
                    
                    const afterText = processedText.substring(tempIndex + expectedText.length, tempIndex + expectedText.length + 50);
                    if (!afterText.includes('<a href=')) {
                        foundIndex = tempIndex;
                        break;
                    }
                    
                    searchStartIndex = tempIndex + 1;
                }
                
                if (foundIndex !== -1) {
                    const correctedEndIndex = foundIndex + expectedText.length;
                    
                    // 收集该段落引用的所有源
                    const citations = new Set();
                    for (const chunkIndex of groundingChunkIndices) {
                        if (chunkIndex < groundingMetadata.groundingChunks.length) {
                            const chunk = groundingMetadata.groundingChunks[chunkIndex];
                            if (chunk && chunk.web) {
                                const { uri } = chunk.web;
                                const sourceIndex = sourceMap.get(uri);
                                if (sourceIndex) {
                                    citations.add(sourceIndex);
                                }
                            }
                        }
                    }
                    
                    if (citations.size > 0) {
                        const sortedCitations = Array.from(citations).sort((a, b) => a - b);
                        const citationStr = sortedCitations.map(idx => {
                            const source = sources[idx - 1];
                            if (source) {
                                return `<a href="${source.uri}" target="_blank" style="color: #1a73e8; text-decoration: none; font-weight: 500;">[${idx}]</a>`;
                            }
                            return `[${idx}]`;
                        }).join('');
                        
                        processedText = processedText.substring(0, correctedEndIndex) + 
                                       citationStr + 
                                       processedText.substring(correctedEndIndex);
                        
                        segmentProcessed.add(segmentKey);
                    }
                }
            }
        }
        
        // 第四步：如果没有精确的 groundingSupports，但有源链接，在文本末尾添加简单引用
        if (!hasDetailedSupports && sources.length > 0) {
            debugLog('没有精确引用信息，在文本末尾添加简单引用');
            
            if (!processedText.includes('[1]')) {
                    // 找到最后一个句号或句子结尾
                const lastSentenceEnd = Math.max(
                    processedText.lastIndexOf('。'),
                    processedText.lastIndexOf('.'),
                    processedText.lastIndexOf('？'),
                    processedText.lastIndexOf('?'),
                    processedText.lastIndexOf('！'),
                    processedText.lastIndexOf('!')
                );
                
                if (lastSentenceEnd !== -1) {
                    // 在最后一个标点符号后添加引用标记
                    processedText = processedText.substring(0, lastSentenceEnd + 1) + 
                                  ` <a href="${sources[0].uri}" target="_blank" style="color: #1a73e8; text-decoration: none; font-weight: 500;">[1]</a>` + 
                                  processedText.substring(lastSentenceEnd + 1);
                } else {
                    processedText += ` <a href="${sources[0].uri}" target="_blank" style="color: #1a73e8; text-decoration: none; font-weight: 500;">[1]</a>`;
                }
            }
        }
        
        // 最后一步：添加 Sources 区块
        if (sources.length > 0) {
            processedText += '\n\n**Sources**\n\n';
            
            sources.forEach((source, index) => {
                const displayTitle = source.title || new URL(source.uri).hostname;
                processedText += `[${index + 1}] [${displayTitle}](${source.uri})\n\n`;
            });
        }
        
        debugLog('处理后文本长度:' + processedText.length);
        return processedText;
    } catch (error) {
        console.error('处理groundingMetadata时出错:', error);
        return responseText; // 出错时返回原始文本
    }
}

// 1 全文分析 - 支持人工编辑和确认
function analyzePageContent() {
    debugLog('准备分析全文内容');
    
    // 检查页面是否已经分析过
    if (pageAnalyzed) {
        console.log('页面已经分析过，直接显示分析结果');
        
        // 直接显示分析结果，而不再显示文本编辑区域
        showAnalysisResults();
        return;
    }
    
    // 如果没有分析过 开始提取页面内容
    pageContent = extractPageContent();

}

// 1.a 全文分析 提取页面内容
function extractPageContent() {
    debugLog('第一步：提取页面内容 --->');
    
    // 获取所有内容区域
    let contentAreas = findContentAreas();
    
    // 查找页面主标题（可能在内容区域外）
    const mainHeadings = document.querySelectorAll('h1');
    if (mainHeadings.length > 0) {
        // 将标题添加到内容区域前面，确保优先处理
        contentAreas = Array.from(mainHeadings).concat(contentAreas);
        debugLog(`找到页面标题元素: ${mainHeadings.length}个`);
        // debugLog(`第一个标题：` + mainHeadings[0].textContent);
        // debuglog foreach mainHeadings
        mainHeadings.forEach(heading => {
            debugLog(`标题：` + heading.textContent);
        });
    }
    
    // 获取排除UI元素的选择器
    const excludeSelectors = getExcludeSelectors();
    
    // 获取所有段落，但排除UI元素中的段落
    const paragraphs = [];
    let processedElements = new Set(); // 用于跟踪已处理过的元素，避免重复
    
    // 循环处理每个内容区域
    contentAreas.forEach(contentArea => {
        let elements = [];
        
        // 如果contentArea本身就是标题元素，直接处理
        if (contentArea.tagName && ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(contentArea.tagName)) {
            elements = [contentArea];
        } else {
            // 获取所有段落、标题、列表项、代码块和特殊格式元素
            elements = contentArea.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, pre, code, blockquote, span[style*="font-size"], div[class*="highlight"], div[class*="hljs"], div[class*="prism"], pre[class*="language-"], code[class*="language-"], [class*="code-block"], [class*="blob-code"]');
        }
        
        elements.forEach(element => {
            // 避免父子元素重复：如果是code且在pre内，跳过code元素
            if (element.tagName === 'CODE' && element.closest('pre')) {
                return;
            }
            
            // 避免祖先已处理的情况：检查是否有祖先元素已被处理
            let hasProcessedAncestor = false;
            let parent = element.parentElement;
            while (parent && parent !== contentArea) {
                if (processedElements.has(parent)) {
                    hasProcessedAncestor = true;
                    break;
                }
                parent = parent.parentElement;
            }
            if (hasProcessedAncestor) {
                return;
            }
            
            // 如果元素已经处理过，则跳过
            if (processedElements.has(element)) {
                return;
            }
            
            // 标记为已处理
            processedElements.add(element);
            
            // 检查是否在排除区域内
            let shouldExclude = false;
            for (const selector of excludeSelectors) {
                if (element.closest(selector)) {
                    shouldExclude = true;
                    break;
                }
            }
            
            // 排除空元素或者只有空格的元素
            const text = element.textContent.trim();
            if (!text || text.length < 5) {
                shouldExclude = true;
            }
            
            // 排除目录相关元素
            if (element.id && (element.id.includes('toc') || element.name === 'tableOfContents')) {
                shouldExclude = true;
            }
            
            if (!shouldExclude) {
                paragraphs.push(element);
            }
        });
    });
    
    // 如果没有找到足够的内容，尝试备用方法
    if (paragraphs.length < 5) {
        debugLog('未找到足够段落，尝试备用方法');
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            { acceptNode: node => node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT }
        );
        let node;
        while (node = walker.nextNode()) {
            const parentElement = node.parentElement;
            if (
                parentElement &&
                !processedElements.has(parentElement) &&
                node.textContent.trim().length >= 8
            ) {
                // 检查是否在排除区域内
                let shouldExclude = false;
                for (const selector of excludeSelectors) {
                    if (parentElement.closest(selector)) {
                        shouldExclude = true;
                        break;
                    }
                }
                
                if (!shouldExclude) {
                    processedElements.add(parentElement);
                    paragraphs.push(parentElement);
                }
            }
        }
    }
    
    // 构建内容
    let content = '';
    paragraphs.forEach((paragraph, index) => {
        const text = paragraph.textContent.trim();
        content += `[paragraph-${index}] ${text}\n\n`;
    });
    
    debugLog('第一步：---> 提取页面内容 长度: ' + content.length);
    
    // 第二步：预览提取的内容
    viewTextEditor(content);

    return content;
}

// 1.b 全文分析 预览提取的内容（待确认 可人工编辑）
function viewTextEditor(content) {
    debugLog('第二步：预览提取内容 准备分析 长度: ' + content.length);
    
    // 确保面板存在
    if (!document.getElementById('deepread-container')) {
        createDeepReadPanel();
    }
    
    // 确保面板可见
    const panel = document.getElementById('deepread-container');
    if (panel) {
        panel.classList.remove('deepread-hidden');
    }
    
    // 设置编辑区域内容
    const deepreadContent = document.getElementById('deepread-content');
    if (deepreadContent) {
        deepreadContent.innerHTML = `
            <div class="deepread-editor">
                <h3>页面内容预览</h3>
                <span>您可以编辑以下内容，然后点击“确认分析”按钮开始分析。</span>
                <div class="deepread-editor-controls">
                    <button id="deepread-analyze-btn" class="deepread-btn">确认分析</button>
                    <button id="deepread-reanalyze-btn" class="deepread-btn" title="重新提取页面内容">重新提取</button>
                    <button id="deepread-cancel-btn" class="deepread-btn">取消</button>
                </div>
                <textarea class="deepread-text-editor" id="deepread-text-input">${content}</textarea>
            </div>
        `;
        
        // 确认分析按钮事件 关键指向 -> analyzeContent
        const analyzeBtn = document.getElementById('deepread-analyze-btn');
        if (analyzeBtn) {
            analyzeBtn.addEventListener('click', function() {
                const textInput = document.getElementById('deepread-text-input');
                if (textInput) {
                    const editedContent = textInput.value;
                    // 关键指向 -> 分析页面HTML并为段落添加ID
                    analyzeContent(editedContent);
                }
            });
        }
        
        // 添加重新提取按钮事件（对于渐进式页面有用）
        const reanalyzeBtn = document.getElementById('deepread-reanalyze-btn');
        if (reanalyzeBtn) {
            reanalyzeBtn.addEventListener('click', function() {
                // 使用防重复点击方法
                preventDuplicateClick('reanalyze', () => {
                    // 重新提取页面内容
                    const newPageContent = extractPageContent();
                    console.log('重新提取的内容长度: ' + newPageContent.length);
                    
                    // 更新文本编辑区域
                    const textInput = document.getElementById('deepread-text-input');
                    if (textInput) {
                        textInput.value = newPageContent;
                    }
                }, 3000, '正在重新提取页面内容，请稍候...');
            });
        }
        
        // 添加取消按钮事件
        document.getElementById('deepread-cancel-btn').addEventListener('click', function() {
            panel.classList.add('deepread-hidden');
        });
    }
}

// 1.c 全文分析 调用LLM API（人工已确认）
async function analyzeContent(content) {
    debugLog('第三步：确认分析 长度：' + content.length + '，预览: ' + content.substring(0, 100) + '...');
    
    // 显示加载状态
    const deepreadContent = document.getElementById('deepread-content');
    if (deepreadContent) {
        deepreadContent.innerHTML = '<div class="deepread-loading">正在分析内容，请稍等...</div>';
    }
    try {
        // 调用LLM API获取分析结果
        const llmResponse = await callAnalyzeContent(content, default_bot_language);
        // 如果调用失败，使用预设数据
        if (!llmResponse || llmResponse.summary == pageSummaryFallback) {
            console.error('获取分析结果失败');
            return;
        }
        // 存储关键概念，并更新页面内容
        if (llmResponse && llmResponse.keyTerms) {
            window.keyTerms = llmResponse.keyTerms;
            pageContent = content;
            pageKeyTerms = llmResponse.keyTerms;
            pageKeyParagraphs = llmResponse.keyParagraphs;
            pageSummary = llmResponse.summary || '';
            
            // 保存页面内容到缓存
            if (window.cacheManager) {
                const pageData = {
                    url: currentUrl,
                    title: pageTitle,
                    content: pageContent,
                    summary: pageSummary,
                    keyTerms: pageKeyTerms,
                    keyParagraphs: pageKeyParagraphs,
                    timestamp: Date.now()
                };
                window.cacheManager.savePageContent(pageData)
                    .catch(error => console.error('保存页面内容到缓存失败:', error));
                await window.cacheManager.savePageAnalyzedStatus(currentUrl, true);
                debugLog('页面分析状态已更新并保存到缓存');
            }

            // 关键指向 -> 为段落添加ID（先添加ID，再渲染结果，确保关键段落可定位）
            await addParagraphIds();
            // 显示分析结果（此时ID已就绪）
            showAnalysisResults(llmResponse);
            // 更新页面分析状态
            pageAnalyzed = true;
        } else {
            deepreadContent.innerHTML = '<div class="deepread-error">抱歉，分析内容时出错。</div>';
        }
    } catch (error) {
        console.error('分析内容时出错:', error);
        // 在出错时显示错误信息
        if (deepreadContent) {
            deepreadContent.innerHTML = '<div class="deepread-error">抱歉，分析内容时出错。</div>';
        }
    }
}

// 1.d 全文分析完成 为段落添加ID 这个方法对于长文会导致页面卡顿 谨慎！
async function addParagraphIds() {
    debugLog('第四步：为段落添加ID --->');
    
    // 获取内容区域 - 与extractPageContent保持一致
    let contentAreas = findContentAreas();
    
    // 查找页面主标题（可能在内容区域外）
    const mainHeadings = document.querySelectorAll('h1');
    if (mainHeadings.length > 0) {
        contentAreas = Array.from(mainHeadings).concat(contentAreas);
        debugLog(`找到页面标题元素: ${mainHeadings.length}个`);
    }
    
    // 获取排除UI元素的选择器
    const excludeSelectors = getExcludeSelectors();
    
    // 为每个段落添加ID
    let idCounter = 0;
    let processedElements = new Set(); // 用于跟踪已处理过的元素，避免重复
    
    // 处理每个内容区域
    contentAreas.forEach(contentArea => {
        let elements = [];
        
        // 如果contentArea本身就是标题元素，直接处理
        if (contentArea.tagName && ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(contentArea.tagName)) {
            elements = [contentArea];
        } else {
            // 获取所有段落、标题、列表项、代码块和特殊格式元素
            elements = contentArea.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, pre, code, blockquote, span[style*="font-size"], div[class*="highlight"], div[class*="hljs"], div[class*="prism"], pre[class*="language-"], code[class*="language-"], [class*="code-block"], [class*="blob-code"]');
        }
        
        elements.forEach(element => {
            // 避免父子元素重复：如果是code且在pre内，跳过code元素
            if (element.tagName === 'CODE' && element.closest('pre')) {
                return;
            }
            
            // 避免祖先已处理的情况：检查是否有祖先元素已被处理
            let hasProcessedAncestor = false;
            let parent = element.parentElement;
            while (parent && parent !== contentArea) {
                if (processedElements.has(parent)) {
                    hasProcessedAncestor = true;
                    break;
                }
                parent = parent.parentElement;
            }
            if (hasProcessedAncestor) {
                return;
            }
            
            // 如果元素已经处理过则跳过（但不要因为已有id就跳过，我们仍需写入 data 标记并参与计数）
            if (processedElements.has(element)) {
                return;
            }

            // 标记为已处理
            processedElements.add(element);

            // 检查是否在排除区域内
            let shouldExclude = false;
            for (const selector of excludeSelectors) {
                if (element.closest(selector)) {
                    shouldExclude = true;
                    break;
                }
            }

            // 排除空元素或者只有空格的元素
            const text = element.textContent.trim();
            if (!text || text.length < 5) {
                shouldExclude = true;
            }

            // 排除目录相关元素
            if (element.id && (element.id.includes('toc') || element.name === 'tableOfContents')) {
                shouldExclude = true;
            }

            if (!shouldExclude) {
                const pid = 'paragraph-' + idCounter;
                // 始终写入数据标记，便于跨上下文和不改动既有id的情况下定位
                element.setAttribute('data-dr-paragraph-id', pid);
                // 仅在没有现有 id 时赋予 id，避免覆盖页面原始结构
                if (!element.id) {
                    element.id = pid;
                }
                idCounter++;
            }
        });
    });

    // 如果没有找到足够的内容，尝试备用方法
    if (idCounter < 5) {
        debugLog('未找到足够段落，为可见文本父元素补充ID');
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            { acceptNode: node => node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT }
        );
        let node;
        while (node = walker.nextNode()) {
            const parentElement = node.parentElement;
            if (
                parentElement &&
                !processedElements.has(parentElement) &&
                node.textContent.trim().length >= 8
            ) {
                // 检查是否在排除区域内
                let shouldExclude = false;
                for (const selector of excludeSelectors) {
                    if (parentElement.closest(selector)) {
                        shouldExclude = true;
                        break;
                    }
                }
                
                if (!shouldExclude) {
                    processedElements.add(parentElement);
                    const pid = 'paragraph-' + idCounter;
                    parentElement.setAttribute('data-dr-paragraph-id', pid);
                    if (!parentElement.id) {
                        parentElement.id = pid;
                    }
                    idCounter++;
                }
            }
        }
    }
    
    debugLog(`第四步：---> 共添加了 ${idCounter} 个段落ID`);
}

/**
 * 调用API进行全文理解 analyzeContent -> callAnalyzeContent
 * @param {string} content 页面内容
 * @returns {Promise<Object>} 分析结果，包含摘要和关键概念
 */
async function callAnalyzeContent(content, language) {
    debugLog('开始分析全文内容，长度：' + content.length);
    
    // 系统提示词
    const systemPrompt = `
        ## 角色：
        我是一个专业的深度阅读助手DeepRead，帮助用户进行网页浏览和理解。
        用户正在查看一个网页，网页的内容形式是文章/资料/视频等，
        
        ---
        
        ## 网页内容：
        '''
        ${content}
        '''
        
        ---
        
        ## 任务：
        我会使用${language}进行总结，但对于有必要提供原文的专业术语等，我会在括号中附上原文。

        对于常规页面，
            给出全文内容摘要summary，并挑选出关键概念keyTerms和关键段落keyParagraphs（对应段落id）。
            如果页面内容没有提供段落编号，则不提供关键段落keyParagraphs。
        对于视频页，
            如果有视频字幕，给出视频内容摘要summary和keyTerms，但不提供关键段落keyParagraphs。
            如果没有视频字幕，给出视频标题summary，但不提供keyTerms和keyParagraphs。

        ## 输出格式：
        我会按以下JSON格式返回结果：
        {
            "summary": "内容摘要，简要描述网页的主题和要点",
            "keyTerms": ["关键概念1", "关键概念2", ...],
            "keyParagraphs": [
                {
                    "id": "paragraph-1", 
                    "reason": "段落主题 --- 关键信息一句话概述..."
                },{
                    "id": "paragraph-2",
                    "reason": "段落主题 --- 关键信息一句话概述..."
                }
            ]
        }

        例子：
        {
            "summary": "《2025年AI现状》报告揭示了AI的变革性影响，通过“超新星”和“流星”重新定义了成功标准。报告描绘了新兴AI生态系统，并预测了浏览器代理、生成式视频、关键评估、新社交媒体及并购趋势。创始人应关注可持续增长和战略性护城河。",
            "keyTerms": ["超新星 (Supernovas)", "流星 (Shooting Stars)"],
            "keyParagraphs": [
                {
                    "id": "paragraph-10", 
                    "reason": "超新星 --- AI超新星增长速度惊人，商业化第一年平均达到4000万美元ARR，第二年达1.25亿美元。"
                },{
                    "id": "paragraph-19",
                    "reason": "流星 --- 消费级新兴AI生态系统是从生产力工具转向治疗、陪伴和自我成长的更深层用例。"
                }
            ]
        }
        
        注意：
        1. summary：应简洁清晰，用 3~5 句话总结全文的主题、背景、核心结论。
        2. keyTerms：5个左右 文中的关键词或概念。(保留文中原始语言和格式，必要时可在括号内翻译)
        3. keyParagraphs：将全文划分为若干个段落，找出关键段落，并用一句话概扩。
        4. 所有输出必须严格遵循上述JSON格式。
    `;
    
    // 构建请求内容
    const contents = [
        {
            // role: 'user' | 'assistant' | 'system'; // openrouter
            // role: 'system',
            role: 'model',
            // content: systemPrompt // openrouter
            parts: [{ text: systemPrompt }]
        },
        {
            role: 'user',
            // content: '请分析这篇文章的内容并提取关键信息'
            parts: [{ text: '请分析这篇文章的内容并提取关键信息' }]
        }
    ];
    
    // 预设的回退响应
    const fallbackResponse = {
        summary: pageSummaryFallback,
        keyTerms: [],
        keyParagraphs: []
    };
    
    // 调用通用API函数
    return await callGeminiAPI(contents, '全文分析', true, fallbackResponse);
}

// 显示LLM全文分析结果 analyzeContent -> showAnalysisResults
function showAnalysisResults(analysisResult) {
    // debugLog('全文分析结果:', analysisResult);
    
    // 确保面板存在并可见
    if (!document.getElementById('deepread-container')) {
        createDeepReadPanel();
    }
    
    const panel = document.getElementById('deepread-container');
    if (panel) {
        panel.classList.remove('deepread-hidden');
    }
    
    // 检查分析结果是否存在并有效
    if (!analysisResult) {
        console.error('分析结果为空');
    } else if (!analysisResult.summary) {
        console.error('分析结果不完整:', analysisResult);
    }
    
    // 使用默认值，如果没有提供分析结果
    const summary = analysisResult?.summary || "这篇文章讨论了...";
    
    // 显示分析结果
    const deepreadContent = document.getElementById('deepread-content');
    if (deepreadContent) {
        // 准备关键概念列表HTML
        let keyTermsHtml = '';
        if (analysisResult?.keyTerms && analysisResult.keyTerms.length > 0) {
            keyTermsHtml = `
                <div class="deepread-key-terms">
                    <h4>相关概念</h4>
                    <ul>
                        ${analysisResult.keyTerms.map(term => 
                            `<li><a href="#" class="deepread-concept" data-concept="${term}">${term}</a></li>`
                        ).join('')}
                    </ul>
                </div>
            `;
        }
        
        // 关键段落HTML（方案A+B：跨上下文查找 + 找不到也渲染兜底项）
        // 简单的跨上下文查找：document -> 同源iframe -> 所有shadowRoot；支持 id 与 data-dr-paragraph-id
        function findByIdEverywhere(id) {
            try {
                const direct = document.getElementById(id);
                if (direct) return direct;
                const dataMatch = document.querySelector(`[data-dr-paragraph-id="${CSS.escape(id)}"]`);
                if (dataMatch) return dataMatch;
            } catch (e) { /* no-op */ }
            // 查找同源 iframe
            const iframes = document.querySelectorAll('iframe');
            for (const frame of iframes) {
                try {
                    const doc = frame.contentDocument || frame.contentWindow?.document;
                    if (doc) {
                        const el = doc.getElementById(id) || doc.querySelector(`[data-dr-paragraph-id="${CSS.escape(id)}"]`);
                        if (el) return el;
                    }
                } catch (e) {
                    // 跨域，忽略
                }
            }
            // 遍历所有含有 shadowRoot 的节点
            const all = document.querySelectorAll('*');
            for (const node of all) {
                if (node.shadowRoot) {
                    const el = node.shadowRoot.getElementById?.(id) || node.shadowRoot.querySelector?.(`#${CSS.escape(id)}`) || node.shadowRoot.querySelector?.(`[data-dr-paragraph-id="${CSS.escape(id)}"]`);
                    if (el) return el;
                }
            }
            return null;
        }

        let keyParagraphsHtml = '';
        if (analysisResult?.keyParagraphs && analysisResult.keyParagraphs.length > 0) {
            keyParagraphsHtml = `<div class="deepread-key-paragraphs"><p><strong>关键段落：</strong></p>`;
            // console.log('analysisResult.keyParagraphs', analysisResult.keyParagraphs);
            analysisResult.keyParagraphs.forEach(paragraphInfo => {
                // 检查是否是新格式（对象包含id和reason）
                const paragraphId = typeof paragraphInfo === 'object' ? paragraphInfo.id : paragraphInfo;
                const reason = typeof paragraphInfo === 'object' ? paragraphInfo.reason : '';
                // console.log('paragraphId', paragraphId);
                // console.log('reason', reason);
                const paragraph = findByIdEverywhere(paragraphId);
                if (paragraph) {
                    // console.log('paragraph', paragraph);
                    // const preview = paragraph.textContent.trim();
                    // const clipped = preview.length > 120 ? preview.substring(0, 120) + '...' : preview;
                    const score = getParagraphStrength(paragraphId);
                    const pct = Math.round(clamp01(score) * 100);
                    const color = deepreadHeatColor(score);
                    keyParagraphsHtml += `
                        <div class="deepread-key-paragraph deepread-paragraph-item" data-target="${paragraphId}">
                            <div class="deepread-strength-row">
                                <span class="deepread-strength-text">相关度 ${pct}%</span>
                            </div>
                            <div class="deepread-heat"><div class="deepread-heat-fill" style="width:${pct}%;background:${color}"></div></div>
                            ${reason ? `<p class="deepread-paragraph-reason"><strong>${reason}</strong></p>` : ''}
                            <button class="deepread-navigate-btn">跳转到此</button>
                            <button class="deepread-navigate-btn deepread-explain-btn">解释此段</button>
                        </div>
                    `;
                } else {
                    console.warn('关键段落ID无效:', paragraphInfo);
                    // 兜底渲染：展示ID与原因；隐藏“跳转到此”
                    keyParagraphsHtml += `
                        <div class="deepread-key-paragraph deepread-paragraph-item" data-target="${paragraphId}">
                            ${reason ? `<p class="deepread-paragraph-reason"><strong>${reason}</strong></p>` : ''}
                            <button class="deepread-navigate-btn deepread-explain-btn">解释此段</button>
                        </div>
                    `;
                }
            });
            keyParagraphsHtml += '</div>';
        }

        // 将全文分析作为首次概念解析添加到概念历史中
        if (conceptHistory.length === 0) {
            const normalizedUrl = window.cacheManager ? 
                window.cacheManager.normalizeUrl(currentUrl) : 
                currentUrl.split('#')[0].split('?')[0]; // 简单的URL规范化
            
            // 创建特定于页面的全文分析名称
            const pageSpecificFullTextName = `全文分析_${normalizedUrl}`;
            
            // 添加全文分析作为首个概念
            conceptHistory.push({
                name: pageSpecificFullTextName, // 使用特定于页面的名称
                displayName: '全文分析', // 显示名称保持不变
                conceptKey: getConceptKey(pageSpecificFullTextName), // 生成概念键
                response: {
                    explanation: `${summary}`,
                    relatedConcepts: analysisResult?.keyTerms || [],
                    relatedParagraphs: analysisResult?.keyParagraphs || []
                }
            });
            console.log('准备缓存全文分析：', conceptHistory[0].conceptKey);
            currentConceptIndex = 0;
            
            // 保存到缓存
            if (window.cacheManager) {
                window.cacheManager.saveConceptHistory(conceptHistory);
            }
        }
        
        // 获取当前概念的显示名称，默认为全文分析
        const currentConcept = conceptHistory[currentConceptIndex] || {};
        const displayName = '全文分析';
        
        deepreadContent.innerHTML = `
            <div id="deepread-explanation-section-id" class="deepread-explanation-section">
                <div class="deepread-section-header">
                    <h3>概念解释区</h3>
                    <div class="deepread-header-buttons">
                        <button class="deepread-insert-chat-btn" id="deepread-insert-chat-full" title="将全文分析加入对话">插入对话</button>
                    </div>
                </div>
                <div class="deepread-concept-header">
                    <h3 class="deepread-concept-title" data-concept-key="${currentConcept.conceptKey || ''}">${displayName}</h3>
                </div>
                <p class="deepread-concept-explanation-summary">${summary}</p>
                ${keyTermsHtml}
                ${keyParagraphsHtml}
                <div id="deepread-concept-explanation-info"></div>
            </div>
            <div class="deepread-vertical-resizer" id="deepread-vertical-resizer"></div>
            <div class="deepread-chat-section">
                <div class="deepread-section-header">
                    <h3>对话区</h3>
                    <div class="deepread-header-buttons">
                        <button class="deepread-clear-btn" id="deepread-clear-chat" title="清除所有对话记录">×</button>
                    </div>
                </div>
                <div id="deepread-chat-messages" class="deepread-chat-messages"></div>
            </div>
        `;
        
        // 添加欢迎消息
        if (chatHistory.length === 0) {
            addChatMessage(greetingMessage, 'assistant');
        } else {
            // 恢复历史消息
            chatHistory.forEach(msg => {
                addChatMessage(msg.message, msg.role, false, false);
            });
        }
        
        // 初始化聊天相关的事件监听
        initChatEvents();
        
        // 初始化概念区相关的事件监听
        initConceptEvents();
        
        // 初始化垂直拖动功能
        initVerticalResizeHandlers();
        
        // 开始处理页面内容，识别关键概念
        identifyKeyConcepts(analysisResult?.keyTerms);
        
        // 为关键段落添加跳转按钮事件
        const navigateButtons = document.querySelectorAll('.deepread-navigate-btn');
        navigateButtons.forEach(button => {
            button.addEventListener('click', function() {
                const targetId = this.parentNode.getAttribute('data-target');
                debugLog('跳转到段落: ' + targetId);

                const targetElement = (typeof findByIdEverywhere === 'function') ? findByIdEverywhere(targetId) : document.getElementById(targetId);
                if (targetElement) {
                    // 高亮目标段落
                    document.querySelectorAll('.deepread-highlight').forEach(el => {
                        el.classList.remove('deepread-highlight');
                    });
                    targetElement.classList.add('deepread-highlight');

                    // 滚动到目标段落
                    targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            });
        });
        
        // 为解释关键段落添加跳转按钮事件
        const explainButtons = document.querySelectorAll('.deepread-explain-btn');
        explainButtons.forEach(button => {
            button.addEventListener('click', function() {
                const targetId = this.parentNode.getAttribute('data-target');
                debugLog('解释段落: ' + targetId);

                const targetElement = (typeof findByIdEverywhere === 'function') ? findByIdEverywhere(targetId) : document.getElementById(targetId);
                if (targetElement) {
                    // 高亮目标段落
                    document.querySelectorAll('.deepread-highlight').forEach(el => {
                        el.classList.remove('deepread-highlight');
                    });
                    targetElement.classList.add('deepread-highlight');

                    // 滚动到目标段落
                    targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

                    // 解释该段落
                    openDeepReadWithConcept(targetElement.textContent);
                }
            });
        });
    }
}

// showAnalysisResults -> identifyKeyConcepts
// 识别页面中的关键概念，并添加交互功能，使用户可以点击获取更详细的解释
function identifyKeyConcepts(llmKeyTerms) {
    // 使用LLM返回的关键概念，如果没有则使用预设值
    const keyTerms = llmKeyTerms || [
        '阅读'
    ];

    // 查找页面中的段落
    const paragraphs = document.querySelectorAll('p');

    // 遍历段落，查找关键概念
    paragraphs.forEach(p => {
        keyTerms.forEach(term => {
            // 简单的文本替换，实际应用中需要更复杂的NLP
            try {
                const regex = new RegExp(`\\b${term}\\b`, 'g');
                p.innerHTML = p.innerHTML.replace(regex, 
                    `<span class="deepread-concept" data-concept="${term}">${term}</span>`);
            } catch (error) {
                console.error(`identifyKeyConcepts: replace ${term} failed`, error);
            }
        });
    });

    // 为概念添加点击事件
    document.querySelectorAll('.deepread-concept').forEach(concept => {
        concept.addEventListener('click', function() {
            explainConcept(this.getAttribute('data-concept'), this);
        });
    });
}

// 2 解释概念
function mockLLMExplain(text) {
    debugLog('调用模拟LLM接口解释: ' + text);
        // 预设的回答
    const presetResponses = {
        '模型解释性': {
            explanation: '模型解释性是指使深度学习模型的决策过程变得透明和可理解的能力。它涉及开发技术和方法，以揭示模型如何从输入数据得出特定预测或决策。模型解释性对于建立对AI系统的信任、确保公平性和支持模型调试至关重要。',
            relatedConcepts: ['黑盒', '决策透明度', '特征重要性'],
            relatedParagraphs: ['paragraph-0', 'paragraph-2', 'paragraph-9']
        },
        '黑盒': {
            explanation: '在AI领域，“黑盒”是指那些内部工作机制不透明、难以理解的模型。深度神经网络通常被视为黑盒，因为它们包含数百万个参数和复杂的非线性变换，使得人类难以直观理解它们如何从输入得出输出。',
            relatedConcepts: ['模型解释性'],
            relatedParagraphs: ['paragraph-0']
        },
        '决策透明度': {
            explanation: '决策透明度指的是AI系统决策过程的可见性和可理解性。在高风险应用中，如医疗诊断或自动驾驶，决策透明度尤为重要，因为它使人类能够验证和信任AI系统的决策。',
            relatedConcepts: ['模型解释性'],
            relatedParagraphs: ['paragraph-2']
        },
        '自然语言处理和语音识别': {
            explanation: '自然语言处理(NLP)和语音识别是人工智能的两个重要分支，它们使计算机能够理解、解释和生成人类语言。深度学习模型在这些领域取得了突破性进展，使得机器翻译、语音助手和自动化客服等应用成为可能。',
            relatedConcepts: ['深度学习'],
            relatedParagraphs: ['paragraph-0']
        }
    };
    
    // 检查是否有预设的回答
    if (presetResponses[text]) {
        return presetResponses[text];
    }
    
    // 对于没有预设的文本，返回一个通用的回答
    return {
        explanation: `LLM返回的解释：这是关于"${text}"的解释。(在实际应用中，这里将会调用真实API获取由LLM生成的详细解释。)`,
        relatedConcepts: [],
        relatedParagraphs: []
    };
}

// 生成概念名称的缩略版本
function getConceptDisplayName(conceptName, maxLength = 50) {
    if (!conceptName) return '';
    
    // 如果概念名称超过指定长度，进行缩略
    if (conceptName.length > maxLength) {
        return conceptName.substring(0, maxLength) + '...';
    }
    
    return conceptName;
}

// 生成概念名称的哈希键
function getConceptKey(conceptName) {
    if (!conceptName) return '';
    
    // 无论概念名称长短，都使用哈希处理，确保导航一致性
    if (window.cacheManager && window.cacheManager.hashString) {
        // 使用缓存管理器中的哈希函数
        return 'concept_' + window.cacheManager.hashString(conceptName);
    } else {
        // 如果缓存管理器不可用，使用简单的哈希方法
        let hash = 0;
        for (let i = 0; i < conceptName.length; i++) {
            const char = conceptName.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return 'concept_' + Math.abs(hash).toString(16);
    }
}

function clamp01(x){
    if (typeof x !== 'number' || Number.isNaN(x)) return 0;
    return Math.max(0, Math.min(1, x));
}

function deepreadHeatColor(score){
    const t = clamp01(score);
    const hue = 120 * (1 - t);
    return `hsl(${hue}, 85%, 55%)`;
}

function getParagraphStrength(paragraphId){
    // 先用稳定的伪随机值（避免每次渲染都跳变）；后续替换为 LLM 返回分数
    if (!paragraphId) return 0;
    try{
        const hash = (window.cacheManager && window.cacheManager.hashString)
            ? window.cacheManager.hashString(String(paragraphId))
            : String(paragraphId);
        let acc = 0;
        for (let i = 0; i < hash.length; i++){
            acc = (acc * 31 + hash.charCodeAt(i)) >>> 0;
        }
        return (acc % 1000) / 1000;
    }catch{
        return Math.random();
    }
}

// 划词 打开阅读助手并跳转到解释指定概念 - 已合并到explainConcept函数
async function openDeepReadWithConcept(conceptName, options = {}) {
    // 直接调用explainConcept函数，传入null作为element参数
    await explainConcept(conceptName, null, options);
}

/**
 * 解释概念
 * @param {string} conceptName 概念名称
 * @param {HTMLElement} element 概念所在的HTML元素
 */
async function explainConcept(conceptName, element, options = {}) {
    // 使用哈希处理后的概念名称作为动作键
    const conceptKey = getConceptKey(conceptName);
    const actionKey = `explain_concept_${conceptKey}`;
    
    // 生成用于显示的概念名称
    const displayName = getConceptDisplayName(conceptName);
    
    preventDuplicateClick(actionKey, async () => {
        try {
            // debugLog('概念名称：' + conceptName);
            // debugLog('概念键：', conceptKey);
            debugLog('解释概念：', displayName);
            
            // 如果面板不存在，创建它
            if (!document.getElementById('deepread-container')) {
                createDeepReadPanel();
            }
            
            // 确保面板可见
            const panel = document.getElementById('deepread-container');
            if (panel) {
                panel.classList.remove('deepread-hidden');
            }
            
            // 显示加载状态
            const explanationDiv = document.getElementById('deepread-explanation-section-id');
            if (!explanationDiv) {
                console.error('未找到解释区域');
                return;
            }
            
            explanationDiv.innerHTML = `<div class="deepread-loading">正在获取"${displayName}"的解释...</div>`;
            
            // 检查缓存中是否已有对应概念的解释
            const existingConceptIndex = conceptHistory.findIndex(item => 
                (item.conceptKey && item.conceptKey === conceptKey) || 
                (!item.conceptKey && item.name === conceptName)
            );
            let processedResponse;
            if (existingConceptIndex >= 0) {
                // 如果已存在，直接使用缓存的结果
                processedResponse = conceptHistory[existingConceptIndex].response;
                
                // 设置当前索引为已存在概念的位置
                currentConceptIndex = existingConceptIndex;

                // 如果本次是从正文选区触发（有 paragraphId），则把定位信息补齐/更新到历史记录中
                if (options && options.paragraphId) {
                    conceptHistory[existingConceptIndex].anchor = conceptHistory[existingConceptIndex].anchor || {};
                    conceptHistory[existingConceptIndex].anchor.paragraphId = options.paragraphId;
                    if (typeof options.start === 'number') conceptHistory[existingConceptIndex].anchor.start = options.start;
                    if (typeof options.end === 'number') conceptHistory[existingConceptIndex].anchor.end = options.end;
                    if (options.text) conceptHistory[existingConceptIndex].anchor.text = options.text;
                    conceptHistory[existingConceptIndex].anchor.url = window.location.href;
                    if (window.cacheManager) {
                        window.cacheManager.saveConceptHistory(conceptHistory)
                            .catch(error => console.error('更新概念定位信息到缓存失败:', error));
                    }
                }

                // 命中缓存：直接更新UI并返回（避免重复调用 LLM）
                debugLog('explainConcept 命中缓存，调用 updateExplanationArea');
                updateExplanationArea(conceptName, processedResponse, displayName, conceptKey);
                return;
            } else {
                // 如果不存在，调用LLM API获取概念解释
                debugLog(`概念"${displayName}"不在缓存中，调用LLM获取解释`);
                const conceptInfo = await callExplanationConcept(conceptName, pageContent);
                // 如果调用失败，显示错误和重试按钮
                if (!conceptInfo) {
                    console.error('获取概念解释失败:', conceptName);
                    explanationDiv.innerHTML = `
                        <div class="deepread-error">
                            获取"${displayName}"的解释失败。请稍后再试。
                            <button class="deepread-retry-btn" data-concept="${conceptName}" data-display="${displayName}">重试</button>
                        </div>`;
                    // 绑定重试按钮事件
                    const retryBtn = explanationDiv.querySelector('.deepread-retry-btn');
                    if (retryBtn) {
                        retryBtn.addEventListener('click', function() {
                            explainConcept(conceptName, null);
                        });
                    }
                    return;
                }
                // 处理返回的数据
                processedResponse = processLLMExplanation(conceptInfo, conceptName);
                // 检查是否是默认的回退响应（解析失败的情况）
                const isFallbackResponse = processedResponse && 
                    processedResponse.explanation && 
                    processedResponse.explanation.includes(conceptExplanationFallback);
                
                if (isFallbackResponse) {
                    console.warn(`概念"${displayName}"的解释是默认的回退响应，不会添加到缓存中`);
                    // 如果是默认的回退响应，不进行缓存
                    debugLog('explainConcept 调用 updateExplanationArea');
                    updateExplanationArea(conceptName, processedResponse, displayName, conceptKey);
                    return;
                }

                // 加入历史记录并缓存
                const conceptData = {
                    name: conceptName,           // 原始概念名称（完整版）
                    displayName: displayName,    // 缩略后的显示名称
                    conceptKey: conceptKey,      // 哈希处理后的概念键
                    response: processedResponse,  // 使用response而非explanation以保持一致性
                    timestamp: Date.now(),
                    anchor: {
                        paragraphId: options && options.paragraphId ? options.paragraphId : null,
                        start: options && typeof options.start === 'number' ? options.start : undefined,
                        end: options && typeof options.end === 'number' ? options.end : undefined,
                        text: options && options.text ? options.text : undefined,
                        url: window.location.href
                    }
                };
                conceptHistory.push(conceptData);
                // 设置当前索引为最新的概念
                currentConceptIndex = conceptHistory.length - 1;
                
                // 打印更新后的历史记录
                debugLog('更新后的概念列表长度:' + conceptHistory.length);
                // conceptHistory.forEach((concept, index) => {
                //     console.log(`  [${index}] ${concept.name}`);
                // });
                
                // 保存到缓存
                if (window.cacheManager) {
                    debugLog('正在将概念历史保存到缓存...');
                    window.cacheManager.saveConceptHistory(conceptHistory)
                        .then(() => debugLog('概念历史成功保存到缓存'))
                        .catch(error => console.error('保存概念查询历史到缓存失败:', error));
                }
            }
            
            // 更新UI
            debugLog('explainConcept 调用 updateExplanationArea');
            updateExplanationArea(conceptName, processedResponse, displayName, conceptKey);
            
            // 高亮当前点击的概念
            document.querySelectorAll('.deepread-concept-active').forEach(el => {
                el.classList.remove('deepread-concept-active');
            });
            if (element) {
                element.classList.add('deepread-concept-active');
            }
        } catch (error) {
            console.error('解释概念时出错:', error);
            // 出错时显示错误信息和重试按钮
            const explanationDiv = document.getElementById('deepread-concept-explanation-info');
            if (explanationDiv) {
                explanationDiv.innerHTML = `
                    <div class="deepread-error">
                        获取"${displayName}"的解释时出错。请稍后再试。
                        <button class="deepread-retry-btn" data-concept="${conceptName}" data-display="${displayName}">重试</button>
                    </div>`;
                // 绑定重试按钮事件
                const retryBtn = explanationDiv.querySelector('.deepread-retry-btn');
                if (retryBtn) {
                    retryBtn.addEventListener('click', function() {
                        explainConcept(conceptName, null);
                    });
                }
            }
        }
    });
}

/**
 * 调用 LLM API 获取概念解释
 * @param {string} conceptName 概念名称
 * @param {string} pageContent 页面内容
 * @returns {Promise<Object>} 概念解释，包含解释文本、相关概念和相关段落
 */
async function callExplanationConcept(conceptName, pageContent = '') {
    // 系统提示词
    const systemPrompt = `
        我是一个专业的深度阅读助手DeepRead，帮助用户进行网页浏览和理解。
        用户选择了一段文本'''${conceptName}'''，我会结合页面内容给出适合语境的中文解释以及相关概念。
        对于常规页面，我会给出解释和相关概念和相关段落（方便用户点击并跳转）。
        对于视频页，我会基于视频字幕（如有）给出视频内容摘要，但不提供相关概念和相关段落。
        如果页面缺失原始段落编号，我会解释相关概念，但不提供相关段落。

        ---

        网页内容：'''
        ${pageContent}
        '''
        
        ---

        我会按以下JSON格式返回结果：
        {
            "explanation": "上下文语境解释，包括且不限于定义、背景和例子",
            "relatedConcepts": ["相关概念1", "相关概念2", "相关概念3"],
            "relatedParagraphs": [
                {
                    "id": "paragraph-1", 
                    "reason": "这段内容与所选概念相关的原因"
                },{
                    "id": "paragraph-2",
                    "reason": "这段内容与所选概念相关的原因"
                }
            ]
        }
        
        ---

        注意：
        1. explanation必选
        2. relatedConcepts可选，1~5个文中与所选概念密切相关的其他概念，并按相关性排序(保留文中原始语言和格式，不翻译)
        3. relatedParagraphs可选，1~5个文中与所选概念最相关的段落ID及相关原因，段落ID格式为"paragraph-X"，其中X是段落的索引号
        4. 所有输出必须严格遵循JSON格式，不要添加额外的文本
    `;
    
    // 构建请求体
    const contents = [
        {
            // role: 'system', // openrouter
            // content: systemPrompt // openrouter
            role: 'model',
            parts: [{ text: systemPrompt }] // google
        },
        {
            role: 'user',
            // content: `请解释"${conceptName}"这个概念` // openrouter
            parts: [{ text: `请解释"${conceptName}"这个概念` }]
        }
    ];

    fallbackResponse = {
        explanation: `"${conceptName}"` + conceptExplanationFallback,
        relatedConcepts: [],
        relatedParagraphs: []
    }

    // 调用通用API函数
    return await callGeminiAPI(contents, '概念解释', true, fallbackResponse);
}

// 处理LLM解释响应
function processLLMExplanation(llmResponse, conceptName) {
    try {
        // 如果返回的是字符串，尝试解析为JSON
        let response = typeof llmResponse === 'string' ? JSON.parse(llmResponse) : llmResponse;
        
        // 安全处理文本内容，防止XSS攻击
        const sanitizeText = (text) => {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        };
        
        // 处理解释内容
        const explanation = sanitizeText(response.explanation || `关于"${conceptName}"的解释未找到`);
        
        // 处理相关概念
        const relatedConcepts = Array.isArray(response.relatedConcepts) ? 
            response.relatedConcepts.map(concept => sanitizeText(concept)) : [];
        
        // 处理相关段落
        const relatedParagraphs = [];
        if (Array.isArray(response.relatedParagraphs)) {
            response.relatedParagraphs.forEach(item => {
                // 如果是简单字符串格式
                if (typeof item === 'string') {
                    const paragraph = document.getElementById(item);
                    if (paragraph) {
                        relatedParagraphs.push({
                            id: item,
                            text: paragraph.textContent,
                            reason: "相关段落"
                        });
                    }
                } 
                // 如果是对象格式
                else if (typeof item === 'object' && item.id) {
                    const paragraph = document.getElementById(item.id);
                    if (paragraph) {
                        relatedParagraphs.push({
                            id: item.id,
                            text: paragraph.textContent,
                            reason: sanitizeText(item.reason || "相关段落")
                        });
                    }
                }
            });
        }
        
        return {
            explanation,
            relatedConcepts,
            relatedParagraphs
        };
    } catch (error) {
        console.error("处理LLM解释结果时出错:", error);
        return {
            explanation: `解析"${conceptName}"的解释时出错。`,
            relatedConcepts: [],
            relatedParagraphs: []
        };
    }
}

// 更新解释区域
function updateExplanationArea(conceptName, llmResponse, displayName, conceptKey) {
    const content = document.getElementById('deepread-content');
    if (!content) return;
    
    // 生成用于显示的概念名称
    // const displayName = displayName || getConceptDisplayName(conceptName);
    // const conceptKey = conceptKey || getConceptKey(conceptName);
    
    debugLog('更新解释区域:');
    // debugLog('- 原始概念名称:' + conceptName);
    debugLog('- 显示名称:' + displayName);
    debugLog('- 概念键:' + conceptKey);
    
    // 防止llmResponse为undefined
    if (!llmResponse) {
        console.error('更新解释区域时llmResponse为undefined');
        llmResponse = {
            explanation: `"${displayName}"` + conceptExplanationFallback,
            relatedConcepts: [],
            relatedParagraphs: []
        };
    }
    
    // 检测是否是fallback响应，如果是则添加重试按钮
    const isFallbackResponse = llmResponse.explanation && 
        llmResponse.explanation.includes(conceptExplanationFallback);
    const retryButtonHtml = isFallbackResponse ? 
        `<button class="deepread-retry-btn" data-concept="${conceptName}" data-display="${displayName}">重试</button>` : '';
    
    // 获取对话区元素
    const chatSection = content.querySelector('.deepread-chat-section');
    
    // 相关概念HTML
    let relatedConceptsHtml = '';
    if (llmResponse.relatedConcepts && llmResponse.relatedConcepts.length > 0) {
        relatedConceptsHtml = `
            <div class="deepread-related">
                <h4>相关概念</h4>
                <ul>
                    ${llmResponse.relatedConcepts.map(concept => 
                        `<li><a href="#" class="deepread-related-concept" data-concept="${concept}">${concept}</a></li>`
                    ).join('')}
                </ul>
            </div>
        `;
    }
    
    // 相关段落HTML
    let relatedParagraphsHtml = '';
    if (llmResponse.relatedParagraphs && llmResponse.relatedParagraphs.length > 0) {
        relatedParagraphsHtml = `<div class="deepread-related-paragraphs"><p><strong>相关段落：</strong></p>`;

        llmResponse.relatedParagraphs.forEach(paragraphInfo => {
            const paragraphId = typeof paragraphInfo === 'object' ? paragraphInfo.id : paragraphInfo;
            const reason = typeof paragraphInfo === 'object' ? paragraphInfo.reason : '';
            const paragraph = (typeof findByIdEverywhere === 'function') ? findByIdEverywhere(paragraphId) : document.getElementById(paragraphId);
            if (paragraph) {
                // const preview = paragraph.textContent.trim();
                // const clipped = preview.length > 120 ? preview.substring(0, 120) + '...' : preview;
                const score = getParagraphStrength(paragraphId);
                const pct = Math.round(clamp01(score) * 100);
                const color = deepreadHeatColor(score);
                relatedParagraphsHtml += `
                    <div class="deepread-related-content deepread-paragraph-item" data-target="${paragraphId}">
                        <div class="deepread-strength-row">
                            <span class="deepread-strength-text">相关度 ${pct}%</span>
                        </div>
                        <div class="deepread-heat"><div class="deepread-heat-fill" style="width:${pct}%;background:${color}"></div></div>
                        ${reason ? `<p class="deepread-paragraph-reason"><strong>${reason}</strong></p>` : ''}
                        <button class="deepread-navigate-btn">跳转到此</button>
                        <button class="deepread-navigate-btn deepread-explain-btn">解释此段</button>
                    </div>
                `;
            } else {
                console.warn('相关段落ID无效:', paragraphInfo);
                relatedParagraphsHtml += `
                    <div class="deepread-related-content deepread-paragraph-item" data-target="${paragraphId}">
                        ${reason ? `<p class="deepread-paragraph-reason"><strong>${reason}</strong></p>` : ''}
                        <button class="deepread-navigate-btn deepread-explain-btn">解释此段</button>
                    </div>
                `;
            }
        });
        relatedParagraphsHtml += '</div>';
    }
    
    // 更新解释区内容，如果已经有对话区，只更新解释部分
    if (chatSection) {
        const explanationDiv = content.querySelector('.deepread-explanation-section');
        if (explanationDiv) {
            // 创建概念导航按钮
            const prevDisabled = currentConceptIndex <= 0;
            const nextDisabled = currentConceptIndex >= conceptHistory.length - 1;
            
            explanationDiv.innerHTML = `
                <div class="deepread-section-header">
                    <h3>概念解释区</h3>
                    <div class="deepread-header-buttons">
                        <button class="deepread-return-btn" id="deepread-return-to-full" title="返回全文分析">返回全文</button>
                        <button class="deepread-insert-chat-btn" id="deepread-insert-chat" title="将概念解释加入对话">插入对话</button>
                        <button class="deepread-delete-concept-btn" id="deepread-delete-concept" title="删除当前概念">删除概念</button>
                    </div>
					<div class="deepread-concept-nav">
                        <button class="deepread-concept-nav-btn" id="deepread-prev-concept" ${prevDisabled ? 'disabled' : ''}>←</button>
                        <button class="deepread-concept-nav-btn" id="deepread-next-concept" ${nextDisabled ? 'disabled' : ''}>→</button>
                    </div>
                </div>
                <div class="deepread-concept-header">
                    <h3 class="deepread-concept-title" data-concept-key="${conceptKey}">${displayName}</h3>
                </div>
                <p class="deepread-concept-explanation-summary">${llmResponse.explanation}${retryButtonHtml}</p>
                ${relatedConceptsHtml}
                ${relatedParagraphsHtml}
            `;
        } 
        // 如果没有解释区，在对话区前插入
        else {
            const explanationSection = document.createElement('div');
            explanationSection.className = 'deepread-explanation-section';
            explanationSection.innerHTML = `
                <h3 data-concept-key="${conceptKey}">${displayName}</h3>
                <p>${llmResponse.explanation}${retryButtonHtml}</p>
                ${relatedConceptsHtml}
                ${relatedParagraphsHtml}
            `;
            content.insertBefore(explanationSection, chatSection);
        }
    } 
    // 如果没有对话区，创建解释区+对话区
    else {
        content.innerHTML = `
            <div class="deepread-explanation-section">
                <h3 data-concept-key="${conceptKey}">${displayName}</h3>
                <p>${llmResponse.explanation}${retryButtonHtml}</p>
                ${relatedConceptsHtml}
                ${relatedParagraphsHtml}
            </div>
            <div class="deepread-vertical-resizer" id="deepread-vertical-resizer"></div>
            <div class="deepread-chat-section">
                <div class="deepread-section-header">
                    <h3>对话区</h3>
                    <div class="deepread-header-buttons">
                        <button class="deepread-clear-btn" id="deepread-clear-chat" title="清除所有对话记录">×</button>
                    </div>
                </div>
                <div id="deepread-chat-messages" class="deepread-chat-messages"></div>
            </div>
        `;
        
        // 添加欢迎消息
        if (chatHistory.length === 0) {
            addChatMessage(greetingMessage, 'assistant');
        } else {
            // 恢复历史消息
            chatHistory.forEach(msg => {
                addChatMessage(msg.message, msg.role, false, false);
            });
        }
    }
    
    // 初始化聊天相关的事件监听
    initChatEvents();
    
    // 为相关概念添加点击事件
    const relatedConcepts = content.querySelectorAll('.deepread-related-concept');
    relatedConcepts.forEach(concept => {
        concept.addEventListener('click', function(e) {
            e.preventDefault();
            const relatedConceptName = this.getAttribute('data-concept');
            debugLog('相关概念: ' + relatedConceptName);
            openDeepReadWithConcept(relatedConceptName);
        });
    });
    
    // 为相关段落添加跳转按钮事件
    const navigateButtons = content.querySelectorAll('.deepread-navigate-btn');
    navigateButtons.forEach(button => {
        button.addEventListener('click', function() {
            const targetId = this.parentNode.getAttribute('data-target');
            debugLog('跳转到段落: ' + targetId);
            
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                // 高亮目标段落
                document.querySelectorAll('.deepread-highlight').forEach(el => {
                    el.classList.remove('deepread-highlight');
                });
                targetElement.classList.add('deepread-highlight');
                
                // 滚动到目标段落
                targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    });
    
    // 为解释相关段落添加跳转按钮事件
    const explainButtons = content.querySelectorAll('.deepread-explain-btn');
    explainButtons.forEach(button => {
        button.addEventListener('click', function() {
            const targetId = this.parentNode.getAttribute('data-target');
            debugLog('解释段落: ' + targetId);
            
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                // 高亮目标段落
                document.querySelectorAll('.deepread-highlight').forEach(el => {
                    el.classList.remove('deepread-highlight');
                });
                targetElement.classList.add('deepread-highlight');
                
                // 滚动到目标段落
                targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

                // 解释该段落
                openDeepReadWithConcept(targetElement.textContent);
            }
        });
    });
    
    // 调用概念区事件初始化函数
    initConceptEvents();
    
    // 为重试按钮添加点击事件
    const retryButtons = content.querySelectorAll('.deepread-retry-btn');
    retryButtons.forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            const conceptToRetry = this.getAttribute('data-concept');
            debugLog('重试获取概念解释: ' + conceptToRetry);
            explainConcept(conceptToRetry, null);
        });
    });
    
    // 添加概念导航按钮事件
    const prevButton = document.getElementById('deepread-prev-concept');
    const nextButton = document.getElementById('deepread-next-concept');
    
    if (prevButton) {
        prevButton.addEventListener('click', function() {
            // 直接从 deepread-concept-title 元素获取当前概念名称
            let currentName = '';
            
            // 从概念标题元素获取
            const conceptTitleElement = document.querySelector('.deepread-concept-title');
            if (conceptTitleElement && conceptTitleElement.textContent.trim() !== '') {
                currentName = conceptTitleElement.textContent.trim();
            } else if (currentConceptIndex >= 0 && currentConceptIndex < conceptHistory.length) {
                // 如果无法从标题元素获取，则使用当前索引
                currentName = conceptHistory[currentConceptIndex].displayName;
            } else {
                currentName = '未知';
            }
            
            debugLog(`点击向左导航按钮时的状态: 当前概念=${currentName}`);
            navigateConcept('prev');
        });
    }
    
    if (nextButton) {
        nextButton.addEventListener('click', function() {
            // 直接从 deepread-concept-title 元素获取当前概念名称
            let currentName = '';
            
            // 从概念标题元素获取
            const conceptTitleElement = document.querySelector('.deepread-concept-title');
            if (conceptTitleElement && conceptTitleElement.textContent.trim() !== '') {
                currentName = conceptTitleElement.textContent.trim();
            } else if (currentConceptIndex >= 0 && currentConceptIndex < conceptHistory.length) {
                // 如果无法从标题元素获取，则使用当前索引
                currentName = conceptHistory[currentConceptIndex].displayName;
            } else {
                currentName = '未知';
            }
            
            debugLog(`点击向右导航按钮时的状态: 当前概念=${currentName}`);
            navigateConcept('next');
        });
    }
}

// 3 聊天对话
function mockChatResponse(message) {
    // 预设的问答对
    const responses = {
        '什么是模型解释性': '模型解释性是指使深度学习模型的决策过程变得透明和可理解的能力。它涉及开发技术和方法，以揭示模型如何从输入数据得出特定预测或决策。模型解释性对于建立对AI系统的信任、确保公平性和支持模型调试至关重要。',
        '什么是黑盒': '在AI领域，“黑盒”是指那些内部工作机制不透明、难以理解的模型。深度神经网络通常被视为黑盒，因为它们包含数百万个参数和复杂的非线性变换，使得人类难以直观理解它们如何从输入得出输出。',
        '什么是决策透明度': '决策透明度指的是AI系统决策过程的可见性和可理解性。在高风险应用中，如医疗诊断或自动驾驶，决策透明度尤为重要，因为它使人类能够验证和信任AI系统的决策。'
    };
    
    // 检查是否有预设的回答
    for (const [question, answer] of Object.entries(responses)) {
        if (message.toLowerCase().includes(question.toLowerCase())) {
            return answer;
        }
    }
    
    // 通用回答
    return `关于 “${message}” 的问题，我的理解是这与本页面的内容有关。(在实际应用中，这里将会调用真实API获取由LLM生成的详细回答。)`;
}

let selectedImages = []; // 用于存储待上传的图片, {id, data}

// 处理来自文件输入框的图片上传
function handleImageUpload(event) {
    const files = event.target.files;
    if (files && files.length > 0) {
        addImagesToPreview(files);
        // 清空文件输入框，以便用户可以再次选择相同的文件
        event.target.value = '';
    }
}

// 将文件添加到预览区的核心函数
function addImagesToPreview(files) {
    if (!files || files.length === 0) {
        return;
    }

    // 遍历所有文件
    Array.from(files).forEach(file => {
        // 确保是图片文件
        if (!file.type.startsWith('image/')) {
            return;
        }

        const reader = new FileReader();
        reader.onload = function(e) {
            // 为每个图片生成一个唯一ID
            const imageId = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            selectedImages.push({ id: imageId, data: e.target.result, file: file }); // 同时保存原始File对象
            // 添加后立即重新渲染所有预览
            renderImagePreviews();
        };
        reader.readAsDataURL(file);
    });
}

// 移除选择的图片
function removeSelectedImage(imageId) {
    // 从数组中移除指定ID的图片
    selectedImages = selectedImages.filter(img => img.id !== imageId);
    // 重新渲染预览
    renderImagePreviews();
}

// 渲染图片预览
function renderImagePreviews() {
    const previewContainer = document.getElementById('deepread-image-preview-container');
    previewContainer.innerHTML = ''; // 清空现有预览

    if (selectedImages.length === 0) {
        previewContainer.style.display = 'none';
        return;
    }

    previewContainer.style.display = 'flex'; // 使用flex布局来横向排列
    previewContainer.style.flexWrap = 'nowrap'; // 防止换行
    previewContainer.style.overflowX = 'auto'; // 内容超出时显示水平滚动条
    previewContainer.style.padding = '5px';
    previewContainer.style.marginBottom = '5px';

    selectedImages.forEach(image => {
        const previewWrapper = document.createElement('div');
        previewWrapper.style.position = 'relative';
        previewWrapper.style.width = '40px';
        previewWrapper.style.height = '40px';
        previewWrapper.style.borderRadius = '4px';
        previewWrapper.style.border = '1px solid #ccc';
        previewWrapper.style.overflow = 'hidden';
        previewWrapper.style.marginRight = '5px'; // 图片间距
        previewWrapper.style.flexShrink = '0'; // 防止缩放

        const img = document.createElement('img');
        img.src = image.data;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';

        const removeButton = document.createElement('button');
        removeButton.textContent = '×';
        removeButton.title = '移除图片';
        removeButton.style.position = 'absolute';
        removeButton.style.top = '0';
        removeButton.style.right = '0';
        removeButton.style.background = 'rgba(0,0,0,0.5)';
        removeButton.style.color = 'white';
        removeButton.style.border = 'none';
        removeButton.style.borderRadius = '0 0 0 4px';
        removeButton.style.width = '16px';
        removeButton.style.height = '16px';
        removeButton.style.lineHeight = '16px';
        removeButton.style.textAlign = 'center';
        removeButton.style.cursor = 'pointer';
        removeButton.style.padding = '0';

        removeButton.onclick = (e) => {
            e.stopPropagation(); // 防止触发其他事件
            removeSelectedImage(image.id);
        };

        previewWrapper.appendChild(img);
        previewWrapper.appendChild(removeButton);
        previewContainer.appendChild(previewWrapper);
    });
}

// 聊天对话（核心代码）
async function sendChatMessage() {
    const chatInput = document.getElementById('deepread-chat-input');
    if (!chatInput) {
        console.log('未找到聊天输入框');
        return;
    }
    
    const message = chatInput.value.trim();
    if (!message) {
        console.log('消息为空，不发送');
        return;
    }
    
    // 添加用户消息到对话历史，包含图片
    addChatMessage(message, 'user', false, true, selectedImages);
    
    // 清空输入框
    chatInput.value = '';
    
    // 显示加载状态
    const loadingId = addChatMessage('正在思考...', 'assistant', true);
    console.log('创建加载消息，ID:', loadingId);
    
    if (!loadingId) {
        console.log('加载消息ID无效，跳过移除步骤');
    }
    
    try {
        // 移除加载消息
        if (loadingId) {
            console.log('尝试移除加载消息，ID:', loadingId);
            removeChatMessage(loadingId);
        }
        
        // 调用LLM API获取回答 // const response = mockChatResponse(message);
        const responseText = await chatWithAI(message, chatHistory, pageContent, selectedImages);
        const response = processChatResponse(responseText);
        addChatMessage(response, 'assistant', false, true, [], responseText);
        
        // 清空图片预览（如果发送了图片）
        if (selectedImages.length > 0) {
            selectedImages = []; // 清空数组
            renderImagePreviews(); // 更新UI，移除所有预览
        }
        // MCP记忆回答
        addMemory(response, {
            type: 'single_message',
            role: 'assistant'
        });
    } catch (error) {
        console.error('处理聊天回答时出错:', error);
        addChatMessage(chatResponseFallback, 'assistant');
    }
}

/**
 * 调用 LLM API 聊天对话
 * @param userMessage 用户消息
 * @param chatHistory 聊天历史
 * @param pageContent 页面内容摘要
 * @returns 聊天回答
 */
async function chatWithAI(userMessage, chatHistory = [], pageContent = '', images = []) {
    debugLog(`images: ${images && images.length > 0 ? images.length + '张图片' : '无图片'}`);
    debugLog('开始获取聊天回答，用户消息：' + userMessage);
    debugLog('聊天历史长度：' + chatHistory.length);
    
    // 先搜索相关记忆 MCP
    let relatedMemories = [];
    try {
        relatedMemories = await searchMemories(userMessage, pageContent);
    } catch (error) {
        console.error('搜索记忆时出错:', error);
    }

    // 系统提示词
    const systemPrompt = `
        我是一个专业的深度阅读助手DeepRead，帮助用户进行网页浏览和理解。我的语言风格将与用户相仿。
        我和用户主要围绕当前页面内容对话，也可能穿插讨论多个不同的页面。
        我将结合当前的页面内容、正在进行的（多轮）对话，用户记忆（如有），和用户对话。
        （记忆通过外部存储存取，记忆不一定准确，甚至可能与当前话题无关，我会有选择的参考记忆）
        
        ---
        
        当前页面内容：'''
        ${pageContent}
        '''
    `;

    // 如果有相关记忆，添加到系统提示词中
    if (relatedMemories && relatedMemories.length > 0) {
        systemPrompt += `
            以下是与当前问题相关的历史记忆：'''
        `;
        relatedMemories.forEach((memory, index) => {
            systemPrompt += `记忆${index + 1}：${memory}\n`;
        });
        systemPrompt += `'''`;
    }

    // REST方式下，google不支持generationConfig里json属性，因此，系统提示词放在contents头条
    const contents = [
        {
            role: 'model',
            parts: [{ text: systemPrompt }]
        }
    ];

    // 聊天历史（已包含最新的即将发出的用户当前消息）
    let formattedHistory = [];
    if (chatHistory && chatHistory.length > 0) {
        formattedHistory = chatHistory.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.message.substring(0, 1000) }]
        }));
    }
    // 统计contents所有文本的总字符数
    const totalChars = contents.reduce((sum, item) => {
        if (item.parts && item.parts[0] && typeof item.parts[0].text === 'string') {
            return sum + item.parts[0].text.length;
        }
        return sum;
    }, 0);
    // 调用通用API函数
    // if (totalChars < 32768) {
    //     debugLog('对话总字符数：' + totalChars + '，调用 Gemini Draw API 绘画聊天');
    //     return await callGeminiAPIDraw(contents, '绘画聊天', false, chatResponseFallback);
    // }
    contents.push(...formattedHistory);

    // 4. 构建包含图片和最新消息的用户输入 (userParts)
    let userParts = [];
    if (images && images.length > 0) {
        images.forEach(image => {
            // 从base64字符串中提取MIME类型和数据
            const [header, data] = image.data.split(',');
            const mimeType = header.match(/:(.*?);/)[1] || 'image/jpeg';
            userParts.push({
                inlineData: {
                    mimeType: mimeType,
                    data: data
                }
            });
        });
    }
    // 无论有无图片，都添加文本消息
    userParts.push({ text: userMessage });

    // 5. 将新的用户消息（可能包含图片）替换掉历史记录中的最后一条纯文本消息
    // 这是因为 sendChatMessage 已经将纯文本消息添加到了 history
    contents[contents.length - 1] = { role: 'user', parts: userParts };

    // debugLog("构建的最终请求内容:" + JSON.stringify(contents, null, 2));

    // 6. 根据有无图片，智能选择并调用API
    if (images && images.length < 0) { // callGeminiAPIDraw 停用 如需启用 代码改为 images.length > 0
        // 有图片，调用多模态，非流式API
        // debugLog('对话总字符数：' + totalChars + "，调用多模态API (callGeminiAPIDraw)");
        // return await callGeminiAPIDraw(contents, '多模态聊天', false, chatResponseFallback);
    } else if (totalChars > 0) {
        // 调用流式响应API
        debugLog('对话总字符数：' + totalChars + "，调用流式响应API (callGeminiAPIStream)");
        
        // 返回一个Promise，在流式响应完成时解析
        return new Promise((resolve, reject) => {
            // 使用现有的addChatMessage创建一个预加载状态的消息（核心代码）
            const messageId = addChatMessage('', 'assistant', true);
            if (!messageId) {
                reject(new Error('创建聊天消息失败'));
                return;
            }
            
            let accumulatedText = '';
            const converter = new showdown.Converter({
                tables: true,
                simplifiedAutoLink: true,
                strikethrough: true,
                tasklists: true
            });
            
            // 定义每个数据块的回调函数
            const onChunk = (chunkText) => {
                // 累积文本
                accumulatedText += chunkText;
                
                // 实时更新UI
                const messageElement = document.getElementById(messageId);
                if (messageElement) {
                    // 获取或创建消息文本元素
                    let textElement = messageElement.querySelector('.message-text-content');
                    if (!textElement) {
                        textElement = document.createElement('div');
                        textElement.className = 'message-text-content';
                        messageElement.appendChild(textElement);
                    }
                    
                    // 移除加载标识
                    messageElement.classList.remove('loading');
                    
                    // 将累积的文本转换为HTML并显示
                    const htmlContent = converter.makeHtml(accumulatedText);
                    textElement.innerHTML = htmlContent;
                    
                    // 滚动到最新消息
                    messageElement.scrollIntoView({ behavior: 'smooth', block: 'end' });
                }
            };
            
            // 定义完成回调函数
            const onComplete = (processedResponse) => {
                // 更新最终的消息内容
                const messageElement = document.getElementById(messageId);
                if (messageElement) {
                    // 获取或创建消息文本元素
                    let textElement = messageElement.querySelector('.message-text-content');
                    if (!textElement) {
                        textElement = document.createElement('div');
                        textElement.className = 'message-text-content';
                        messageElement.appendChild(textElement);
                    }
                    
                    // 直接使用已经处理过的响应（包含引用标记和Sources区块）
                    // 不再调用processChatResponse，避免重复处理
                    if (typeof showdown !== 'undefined') {
                        try {
                            const converter = new showdown.Converter({
                                tables: true,
                                simplifiedAutoLink: true,
                                strikethrough: true,
                                tasklists: true
                            });
                            textElement.innerHTML = converter.makeHtml(processedResponse);
                        } catch (e) {
                            console.error('Showdown处理失败:', e);
                            textElement.innerHTML = processedResponse;
                        }
                    } else {
                        textElement.innerHTML = processedResponse;
                    }
                    
                    // 为消息添加操作按钮（传入原始Markdown用于复制）
                    const actionsContainer = createChatMessageActions(messageId, processedResponse, 'assistant');
                    
                    // 移除现有的操作按钮容器（如果有）
                    const existingActions = messageElement.querySelector('.message-actions');
                    if (existingActions) {
                        existingActions.remove();
                    }
                    
                    // 添加新的操作按钮容器
                    messageElement.appendChild(actionsContainer);
                    
                    // 滚动到最新消息
                    messageElement.scrollIntoView({ behavior: 'smooth', block: 'end' });
                }
                
                // 解析Promise，返回处理后的响应
                resolve(processedResponse);

                // 移除
                removeChatMessage(messageId);
            };
            
            // 定义错误回调函数
            const onError = (error) => {
                console.error('流式聊天API调用错误:', error);
                
                // 更新UI显示错误
                const messageElement = document.getElementById(messageId);
                if (messageElement) {
                    // 获取或创建消息文本元素
                    let textElement = messageElement.querySelector('.message-text-content');
                    if (!textElement) {
                        textElement = document.createElement('div');
                        textElement.className = 'message-text-content';
                        messageElement.appendChild(textElement);
                    }
                    
                    // 移除加载标识并添加错误样式
                    messageElement.classList.remove('loading');
                    messageElement.classList.add('error');
                    
                    // 显示错误信息
                    textElement.innerHTML = `<p>出错了: ${error.message || '未知错误'}</p>`;
                    
                    // 为消息添加操作按钮
                    const actionsContainer = createChatMessageActions(messageId, `出错了: ${error.message || '未知错误'}`, 'assistant');
                    
                    // 移除现有的操作按钮容器（如果有）
                    const existingActions = messageElement.querySelector('.message-actions');
                    if (existingActions) {
                        existingActions.remove();
                    }
                    
                    // 添加新的操作按钮容器
                    messageElement.appendChild(actionsContainer);
                }
                
                // 返回错误信息
                reject(error);
            };
            
            // 调用流式API
            callGeminiAPIStream(contents, '聊天', onChunk, onComplete, onError);
        });
    }
}

// 处理LLM聊天对话响应
function processChatResponse(llmResponse) {
    try {
        // console.log('处理聊天响应:', llmResponse);
        // 检查是否是多模态响应（包含图像）
        if (typeof llmResponse === 'object' && llmResponse.text !== undefined && Array.isArray(llmResponse.images)) {
            // 处理文本部分
            let htmlContent = '';
            
            // 处理文本
            if (llmResponse.text) {
                if (typeof showdown !== 'undefined') {
                    try {
                        const converter = new showdown.Converter({
                            tables: true,
                            simplifiedAutoLink: true,
                            strikethrough: true,
                            tasklists: true
                        });
                        htmlContent += converter.makeHtml(llmResponse.text);
                    } catch (e) {
                        console.error('Showdown处理失败:', e);
                        const div = document.createElement('div');
                        div.textContent = llmResponse.text;
                        htmlContent += div.innerHTML;
                    }
                } else {
                    const div = document.createElement('div');
                    div.textContent = llmResponse.text;
                    htmlContent += div.innerHTML;
                }
            }
            
            // 处理图像
            if (llmResponse.images && llmResponse.images.length > 0) {
                htmlContent += '<div class="deepread-generated-images">';
                
                // 添加每个图像
                for (const image of llmResponse.images) {
                    if (image.data && image.mimeType) {
                        htmlContent += `<div class="deepread-image-container">
                            <img src="data:${image.mimeType};base64,${image.data}" alt="生成的图像" class="deepread-generated-image">
                        </div>`;
                    }
                }
                
                htmlContent += '</div>';
            }
            
            return htmlContent;
        }
        
        // 如果不是多模态响应，则使用原来的处理方式 如果是字符串直接使用，否则尝试转换为字符串
        const responseText = typeof llmResponse === 'string' ?  llmResponse : JSON.stringify(llmResponse);
        // 使用Showdown库将Markdown转换为HTML
        if (typeof showdown !== 'undefined') {
            try {
                const converter = new showdown.Converter({
                    tables: true,
                    simplifiedAutoLink: true,
                    strikethrough: true,
                    tasklists: true
                });
                return converter.makeHtml(responseText);
            } catch (e) {
                console.error('Showdown处理失败:', e);
                // 如果Showdown处理失败，则使用基本文本处理
                const div = document.createElement('div');
                div.textContent = responseText;
                return div.innerHTML;
            }
        } else {
            // 如果Showdown库未加载，则使用基本文本处理
            const div = document.createElement('div');
            div.textContent = responseText;
            return div.innerHTML;
        }
    } catch (error) {
        console.error("处理聊天响应时出错:", error);
        return "抱歉，处理回答时出现了问题。";
    }
}

// *********************************************** 以下是业务工具函数 ***********************************************

// 导航到上一个或下一个概念（核心代码）
function navigateConcept(direction) {
    debugLog(`开始导航函数: 方向=${direction}`);
    
    // 打印当前概念历史以便调试
    console.log('navigateConcept 概念列表长度:', conceptHistory.length);
    // conceptHistory.forEach((concept, index) => {
    //     console.log(`概念[${index}]: ${concept.name}`);
    // });
    
    // 如果没有概念历史，则不需要操作
    if (conceptHistory.length <= 1) {
        console.log('没有足够的概念历史记录用于导航');
        return;
    }
    
    // 使用conceptKey而非概念名称进行导航
    let currentConceptKey = '';
    
    // 从概念标题元素获取conceptKey
    const conceptTitleElement = document.querySelector('.deepread-concept-title');
    if (conceptTitleElement) {
        // 尝试从数据属性中获取conceptKey
        currentConceptKey = conceptTitleElement.getAttribute('data-concept-key');
        
        if (currentConceptKey) {
            // console.log(`获取当前概念键: ${currentConceptKey}`);
        } else {
            // 如果没有data-concept-key属性，则使用文本内容作为名称
            const displayName = conceptTitleElement.textContent.trim();
            console.log(`当前概念显示名称: ${displayName}`);
            
            // 尝试通过显示名称找到概念对象，然后获取其conceptKey
            const matchedConcept = conceptHistory.find(c => (c.displayName === displayName || c.name === displayName));
            if (matchedConcept && matchedConcept.conceptKey) {
                currentConceptKey = matchedConcept.conceptKey;
                console.log(`通过显示名称找到概念键: ${currentConceptKey}`);
            }
        }
    }
    
    // 如果仍然无法获取概念键，则使用当前索引
    if (!currentConceptKey && currentConceptIndex >= 0 && currentConceptIndex < conceptHistory.length) {
        const currentConcept = conceptHistory[currentConceptIndex];
        currentConceptKey = currentConcept.conceptKey || getConceptKey(currentConcept.name);
        console.log(`获取概念键: ${currentConceptKey}`);
    }
    
    // 如果仍然无法获取概念键，则返回
    if (!currentConceptKey) {
        console.error(`无法获取当前概念键: 索引=${currentConceptIndex}, 历史长度=${conceptHistory.length}`);
        return;
    }
    
    // 使用概念键在历史中查找匹配项
    let existingIndex = -1;
    conceptHistory.forEach((concept, index) => {
        if ((concept.conceptKey && concept.conceptKey === currentConceptKey) || 
            (!concept.conceptKey && getConceptKey(concept.name) === currentConceptKey)) {
            existingIndex = index;
        }
    });
    
    if (existingIndex === -1) {
        console.warn(`当前概念键"${currentConceptKey}"不在历史中，这可能会导致导航问题`);
        // 注意: 概念应该在LLM返回解释后就添加到历史记录中，而不是在导航时添加
    }
    
    // 找到当前概念在历史中的所有索引
    const allIndicesOfCurrentConcept = [];
    conceptHistory.forEach((concept, index) => {
        if ((concept.conceptKey && concept.conceptKey === currentConceptKey) || 
            (!concept.conceptKey && getConceptKey(concept.name) === currentConceptKey)) {
            allIndicesOfCurrentConcept.push(index);
        }
    });
    
    console.log(`当前概念键"${currentConceptKey}"在历史中的所有索引:`, allIndicesOfCurrentConcept);
    
    // 导航逻辑，使用确定的导航顺序 全文分析始终是第一个，其他概念按照首次出现的顺序排列 使用简单的数组来跟踪唯一概念 
    
    // 步骤1: 创建概念导航顺序
    // 先收集所有唯一的概念键和名称，保持原始顺序
    let uniqueConceptKeys = [];
    let uniqueConceptMap = {}; // 映射概念键到概念对象
    
    // 查找当前页面的全文分析概念
    const fullAnalysisConcepts = conceptHistory.filter(concept => 
        concept.displayName === '全文分析');
    // 如果找到了全文分析概念，将其添加到导航顺序的第一位
    if (fullAnalysisConcepts.length > 0) {
        console.log('找到全文分析:', fullAnalysisConcepts);
        // 使用找到的第一个全文分析概念
        const fullAnalysisConcept = fullAnalysisConcepts[0];

        // 这里是我人肉实现的重点代码，处理全文分析和概念词汇的穿插问题
        fullAnalysisConcept.displayName = '全文分析';
        fullAnalysisConcept.name = '全文分析_' + window.cacheManager.normalizeUrl(currentUrl);
        window.cacheManager.loadPageContent(currentUrl)
            .then(cachedPageContent => {
                if (cachedPageContent && cachedPageContent.summary && cachedPageContent.keyTerms) {
                    fullAnalysisConcept.response.explanation = cachedPageContent.summary;
                    fullAnalysisConcept.response.relatedConcepts = cachedPageContent.keyTerms;
                    urlBasedKey = window.cacheManager.hashString(currentUrl);
                    debugLog('基于URL的全文分析键:' + urlBasedKey);
                    fullAnalysisConcept.conceptKey = 'concept_' + urlBasedKey;
                }
            })
        const fullAnalysisKey = fullAnalysisConcept.conceptKey || getConceptKey(fullAnalysisConcept.name);
        uniqueConceptKeys.push(fullAnalysisKey);
        uniqueConceptMap[fullAnalysisKey] = fullAnalysisConcept;
        debugLog('添加全文分析到导航首位:' + fullAnalysisKey);
    } else {
        console.log('未找到全文分析概念');
    }
    
    // 然后按照首次出现的顺序添加其他概念
    for (let i = 0; i < conceptHistory.length; i++) {
        const concept = conceptHistory[i];
        const conceptKey = concept.conceptKey || getConceptKey(concept.name);
        
        // 跳过全文分析概念（已在前面处理）和已添加的概念
        if (!uniqueConceptKeys.includes(conceptKey) && 
            !(concept.displayName === '全文分析')) {
            uniqueConceptKeys.push(conceptKey);
            uniqueConceptMap[conceptKey] = concept;
        }
    }
    
    // debugLog('概念字典大小:', Object.keys(uniqueConceptMap).length, uniqueConceptMap);
    debugLog('概念字典大小:' + Object.keys(uniqueConceptMap).length);
    
    // 步骤2: 确定当前概念在导航顺序中的位置
    const currentPosition = uniqueConceptKeys.indexOf(currentConceptKey);
    
    if (currentPosition === -1) {
        console.error(`无法在导航顺序中找到当前概念键: ${currentConceptKey}`);
        return;
    }
    
    // 步骤3: 根据导航方向确定目标概念键
    let targetKey;
    
    if (direction === 'prev' && currentPosition > 0) {
        targetKey = uniqueConceptKeys[currentPosition - 1];
        debugLog(`导航到上一个概念键: ${targetKey}`);
    } else if (direction === 'next' && currentPosition < uniqueConceptKeys.length - 1) {
        targetKey = uniqueConceptKeys[currentPosition + 1];
        debugLog(`导航到下一个概念键: ${targetKey}`);
    } else {
        debugLog('已经到达概念历史的边界');
        return;
    }
    
    // 从映射中获取目标概念对象
    const mappedConcept = uniqueConceptMap[targetKey];
    if (!mappedConcept) {
        console.error(`无法找到目标概念键 ${targetKey} 对应的概念对象`);
        return;
    }
    
    // 步骤4: 找到目标概念的最新索引
    let newConceptIndex = -1;
    
    // 从后向前查找目标概念的最新索引
    for (let i = conceptHistory.length - 1; i >= 0; i--) {
        const concept = conceptHistory[i];
        const conceptKey = concept.conceptKey || getConceptKey(concept.name);
        
        if (conceptKey === targetKey) {
            newConceptIndex = i;
            break;
        }
    }
    
    if (newConceptIndex === -1) {
        console.error(`无法找到目标概念键 ${targetKey} 的索引`);
        return;
    }
    
    // 更新当前概念索引
    // const targetConcept = conceptHistory[newConceptIndex];
    debugLog(`已导航到新概念, 索引: ${newConceptIndex}`);
    currentConceptIndex = newConceptIndex;
    
    // 获取选定的概念
    const selectedConcept = conceptHistory[currentConceptIndex];
    if (!selectedConcept) {
        console.error('无法获取概念，索引:', currentConceptIndex);
        return;
    }
    
    // 获取概念数据
    const concept = conceptHistory[currentConceptIndex];
    
    if (!concept) {
        console.error('找不到概念数据，索引:', currentConceptIndex);
        return;
    }
    
    // 检查概念数据是否完整
    if (!concept.response) {
        console.error('概念数据不完整:', concept);
        // 尝试修复数据
        if (concept.explanation) {
            concept.response = concept.explanation;
        } else {
            console.error('无法修复概念数据');
            return;
        }
    }
    
    // 更新UI
    debugLog('navigateConcept 调用 updateExplanationArea');
    updateExplanationArea(concept.name, concept.response, concept.displayName, concept.conceptKey);
    
    // 更新索引到缓存
    if (window.cacheManager) {
        window.cacheManager.setCurrentConceptIndex(currentConceptIndex)
            .catch(error => console.error('保存当前概念索引失败:', error));
    }
    
}

/**
 * 直接导航到指定索引的概念
 * @param {number} index 目标概念的索引
 */
function navigateToConceptByIndex(index) {
    // 检查索引是否有效
    if (index < 0 || index >= conceptHistory.length) {
        console.error(`无效的概念索引: ${index}, 概念历史长度: ${conceptHistory.length}`);
        return;
    }
    
    // 获取目标概念
    const targetConcept = conceptHistory[index];
    if (!targetConcept) {
        console.error(`指定索引处没有概念: ${index}`);
        return;
    }
    
    console.log(`导航到概念索引 ${index}: ${targetConcept.name || targetConcept.displayName}`);
    
    // 更新当前概念索引
    currentConceptIndex = index;
    
    // 保存当前概念索引到缓存
    if (window.cacheManager) {
        window.cacheManager.setCurrentConceptIndex(currentConceptIndex);
    }
    
    // 更新界面显示
    const conceptKey = targetConcept.conceptKey || getConceptKey(targetConcept.name);
    const displayName = targetConcept.displayName || targetConcept.name;
    
    // 更新解释区
    updateExplanationArea(targetConcept.name, targetConcept.response, displayName, conceptKey);
    
    // 重新绑定概念区相关的事件
    initConceptEvents();
}

/**
 * 重建导航数据结构
 * 在概念历史变化后，重新构建导航数据结构
 */
function rebuildNavigationData() {
    // 清空导航数据结构
    uniqueConceptKeys = [];
    uniqueConceptMap = {};
    
    // 步骤1: 首先将全文分析概念放在导航首位
    const fullAnalysisConcept = conceptHistory.find(concept => 
        concept.displayName === '全文分析' || 
        (concept.name && concept.name.startsWith('全文分析')));
    
    if (fullAnalysisConcept) {
        const fullAnalysisKey = fullAnalysisConcept.conceptKey || getConceptKey(fullAnalysisConcept.name);
        uniqueConceptKeys.push(fullAnalysisKey);
        uniqueConceptMap[fullAnalysisKey] = fullAnalysisConcept;
        console.log('重建导航数据: 添加全文分析到导航首位:', fullAnalysisKey);
    }
    
    // 步骤2: 然后按照首次出现的顺序添加其他概念
    for (let i = 0; i < conceptHistory.length; i++) {
        const concept = conceptHistory[i];
        const conceptKey = concept.conceptKey || getConceptKey(concept.name);
        
        // 跳过全文分析概念（已在前面处理）和已添加的概念
        if (!uniqueConceptKeys.includes(conceptKey) && 
            !(concept.displayName === '全文分析' || (concept.name && concept.name.startsWith('全文分析')))) {
            uniqueConceptKeys.push(conceptKey);
            uniqueConceptMap[conceptKey] = concept;
        }
    }
    
    console.log('重建导航数据: 导航顺序中的概念数量:', uniqueConceptKeys.length);
    return { uniqueConceptKeys, uniqueConceptMap };
}

/**
 * 删除当前概念
 * 从概念历史中移除当前概念，并更新界面
 */
async function deleteConcept() {
    try {
        // 确认是否要删除
        if (!confirm('确定要删除当前概念吗？这个操作不可恢复。')) {
            return;
        }
        
        // 检查当前概念是否有效
        if (currentConceptIndex < 0 || currentConceptIndex >= conceptHistory.length) {
            alert('当前没有有效的概念可以删除。');
            return;
        }
        
        // 获取当前概念信息
        const currentConcept = conceptHistory[currentConceptIndex];
        
        // 如果是全文分析，不允许删除
        if (currentConcept.displayName === '全文分析' || 
            (currentConcept.name && currentConcept.name.startsWith('全文分析'))) {
            alert('全文分析不能删除。');
            return;
        }
        
        // 调用缓存管理器删除概念
        const result = await window.cacheManager.deleteConceptByIndex(currentConceptIndex);
        
        if (result.success) {
            // 更新当前概念索引
            currentConceptIndex = result.newIndex;
            
            // 重新加载概念历史
            conceptHistory = await window.cacheManager.loadConceptHistory();
            
            // 重建导航数据结构
            rebuildNavigationData();
            
            // 更新界面
            if (conceptHistory.length > 0) {
                // 模拟导航操作来更新界面
                debugLog('删除概念后模拟导航操作');
                
                // 如果没有概念了，返回全文分析
                if (conceptHistory.length === 1 && conceptHistory[0].displayName === '全文分析') {
                    returnToFullContent();
                } else {
                    // 优先导航到最后一个概念
                    navigateToConceptByIndex(conceptHistory.length - 1);
                }
            } else {
                // 如果没有概念了，返回全文分析
                returnToFullContent();
            }
            
            alert(result.message);
        } else {
            alert(`删除概念失败: ${result.message}`);
        }
    } catch (error) {
        console.error('删除概念时出错:', error);
        alert(`删除概念时出错: ${error.message}`);
    }
}

// 点击 “返回全文” ，直接返回全文分析， 区别于 navigateConcept 单步导航
function returnToFullContent() {
    // 如果没有概念历史，则不需要操作
    if (conceptHistory.length === 0) {
        return;
    }
    
    // 将当前概念索引设置为0（全文分析）
    currentConceptIndex = 0;
    
    // 获取全文分析数据
    const full = conceptHistory[0];
    
    // 更新显示
    console.log('返回全文分析:', full);
    debugLog('returnToFullContent 调用 updateExplanationArea');
    updateExplanationArea(full.name, full.response, full.displayName, full.conceptKey);
    
    // 更新索引到缓存
    if (window.cacheManager) {
        window.cacheManager.setCurrentConceptIndex(currentConceptIndex)
            .catch(error => console.error('保存当前概念索引失败:', error));
    }
    
    console.log('返回全文分析');
}

/**
 * 初始化概念区相关的事件监听
 * 将所有概念区相关的事件监听集中在一个函数中管理
 */
function initConceptEvents() {
    // 返回全文按钮事件监听
    const returnToFullButton = document.getElementById('deepread-return-to-full');
    if (returnToFullButton && !returnToFullButton.hasAttribute('data-event-bound')) {
        returnToFullButton.addEventListener('click', returnToFullContent);
        returnToFullButton.setAttribute('data-event-bound', 'true');
    }
    
    // 插入对话按钮事件监听
    const insertChatButton = document.getElementById('deepread-insert-chat');
    if (insertChatButton && !insertChatButton.hasAttribute('data-event-bound')) {
        insertChatButton.addEventListener('click', insertConceptToChat);
        insertChatButton.setAttribute('data-event-bound', 'true');
    }
    
    // 将全文分析加入对话按钮事件监听
    const insertChatFullButton = document.getElementById('deepread-insert-chat-full');
    if (insertChatFullButton && !insertChatFullButton.hasAttribute('data-event-bound')) {
        insertChatFullButton.addEventListener('click', insertConceptToChat);
        insertChatFullButton.setAttribute('data-event-bound', 'true');
    }
    
    // 删除概念按钮事件监听
    const deleteConceptButton = document.getElementById('deepread-delete-concept');
    if (deleteConceptButton && !deleteConceptButton.hasAttribute('data-event-bound')) {
        deleteConceptButton.addEventListener('click', deleteConcept);
        deleteConceptButton.setAttribute('data-event-bound', 'true');
    }
    
    // 将来可以在这里添加更多概念区相关的事件监听
}

/**
 * 初始化聊天相关的事件监听
 * 将所有聊天相关的事件监听集中在一个函数中管理
 */
function initChatEvents() {
    // 清除按钮事件监听
    const clearChatBtn = document.getElementById('deepread-clear-chat');
    if (clearChatBtn && !clearChatBtn.hasAttribute('data-event-bound')) {
        clearChatBtn.addEventListener('click', clearChatHistory);
        // 添加标记，避免重复绑定
        clearChatBtn.setAttribute('data-event-bound', 'true');
    }
    
    // 为现有的聊天消息添加复制和删除按钮
    // addActionButtonsToExistingMessages();
    
    // 将来可以在这里添加更多聊天相关的事件监听
    // 例如：历史对话、新建对话、保存对话等按钮的事件监听
}

// 添加聊天消息到对话历史（核心代码）
// rawMessage: 原始Markdown文本，用于复制功能（可选，默认等于message）
function addChatMessage(message, role, isLoading = false, addToHistory = true, images = [], rawMessage = null) {
    const chatMessages = document.getElementById('deepread-chat-messages');
    if (!chatMessages) {
        console.log('未找到聊天消息容器');
        return null;
    }
    // console.log('添加聊天消息:', message);
    // 创建消息元素
    const messageElement = document.createElement('div');
    const messageId = generateUniqueId();
    messageElement.id = messageId;
    messageElement.className = `deepread-chat-message deepread-chat-message-${role}`;
    messageElement.dataset.messageId = messageId;

    // 如果消息包含图片，则渲染图片
    if (images && images.length > 0) {
        const imageContainer = document.createElement('div');
        imageContainer.className = 'message-image-container';
        images.forEach(image => {
            const imgElement = document.createElement('img');
            imgElement.src = image.data;
            imgElement.alt = '图片';
            imgElement.style.maxWidth = '100%'; // 保持图片响应式
            imgElement.style.borderRadius = '8px';
            imgElement.style.marginBottom = '8px';
            imageContainer.appendChild(imgElement);
        });
        messageElement.appendChild(imageContainer);
    }

    // 创建并添加文本内容
    const textElement = document.createElement('div');
    textElement.className = 'message-text-content';
    
    // 处理并追加文本内容
    let messageContent = '';
    // 只有在消息文本不为空时才创建和添加文本元素
    if (message && message.trim() !== '') {
        if (role === 'assistant' && /<[a-z][\s\S]*>/i.test(message)) {
            // 助手消息且包含HTML，使用innerHTML
            textElement.innerHTML = message;
        } else {
            // 用户消息或纯文本助手消息，使用textContent以防止XSS
            textElement.textContent = message;
        }
        messageElement.appendChild(textElement);
    }
    // 保存原始消息内容，用于后续的操作按钮（如复制）
    // 优先使用rawMessage（原始Markdown），否则使用message
    messageContent = rawMessage || message;
    
    // 如果不是加载状态消息（正在思考...），正常消息都会添加操作按钮
    if (!isLoading) {
        // 使用通用函数创建操作按钮
        debugLog("addChatMessage 调用 createChatMessageActions");
        const actionsContainer = createChatMessageActions(messageId, messageContent, role);
        
        // 添加操作按钮容器到消息元素
        messageElement.appendChild(actionsContainer);
    }
    
    // 添加到对话区域
    chatMessages.appendChild(messageElement);
    
    // 滚动到底部
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    // 如果不是加载状态消息且需要添加到历史，则添加到对话历史
    if (!isLoading && addToHistory) {
        chatHistory.push({ role, message, messageId });
        
        // 保存聊天历史到缓存
        if (window.cacheManager) {
            debugLog('addChatMessage 调用 saveChatHistory');
            window.cacheManager.saveChatHistory(chatHistory)
                .catch(error => console.error('保存聊天历史到缓存失败:', error));
        }
    }

    return messageId;
}

/**
 * 创建聊天消息操作按钮
 * @param {string} messageId 消息 ID
 * @param {string} messageContent 消息内容
 * @param {string} role 消息角色（user或assistant）
 * @returns {HTMLDivElement} 操作按钮容器
 */
function createChatMessageActions(messageId, messageContent, role) {
    // console.log("createChatMessageActions", messageId, role);
    // 创建操作按钮容器
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'deepread-chat-message-actions';
    
    // 复制按钮
    const copyButton = document.createElement('button');
    copyButton.className = 'deepread-chat-action-btn deepread-chat-action-copy';
    copyButton.title = '复制消息';
    copyButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    copyButton.addEventListener('click', (e) => {
        e.stopPropagation();
        copyMessageToClipboard(messageContent, role);
    });
    
    // 删除按钮
    const deleteButton = document.createElement('button');
    deleteButton.className = 'deepread-chat-action-btn deepread-chat-action-delete';
    deleteButton.title = '删除消息';
    deleteButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
    deleteButton.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteChatMessage(messageId);
    });
    
    // 添加按钮到容器
    actionsContainer.appendChild(copyButton);
    actionsContainer.appendChild(deleteButton);
    
    return actionsContainer;
}

/**
 * 复制消息到剪贴板（保留Markdown格式）
 * @param {string} message 要复制的消息（原始Markdown）
 * @param {string} role 消息角色（user或assistant）
 */
function copyMessageToClipboard(message, role) {
    try {
        // 直接复制消息内容（现在传入的是原始Markdown）
        navigator.clipboard.writeText(message)
            .then(() => {
                // 显示成功提示
                const toast = document.createElement('div');
                toast.textContent = '消息已复制到剪贴板';
                toast.style.position = 'fixed';
                toast.style.bottom = '20px';
                toast.style.left = '50%';
                toast.style.transform = 'translateX(-50%)';
                toast.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
                toast.style.color = 'white';
                toast.style.padding = '8px 16px';
                toast.style.borderRadius = '4px';
                toast.style.zIndex = '10000';
                document.body.appendChild(toast);
                
                // 2秒后移除提示
                setTimeout(() => {
                    document.body.removeChild(toast);
                }, 2000);
            })
            .catch(err => {
                console.error('复制失败:', err);
                alert('复制失败，请手动复制。');
            });
    } catch (error) {
        console.error('复制消息时出错:', error);
        alert('复制消息时出错，请手动复制。');
    }
}

/**
 * 移除聊天消息元素
 * 从 DOM 中移除消息元素，但不从历史记录中删除
 * @param {string} messageId 要移除的消息 ID
 * @returns {boolean} 是否成功移除
 */
function removeChatMessage(messageId) {
    if (!messageId) {
        debugLog('消息ID为空，无法移除');
        return false;
    }
    
    const messageElement = document.getElementById(messageId);
    
    if (messageElement) {
        messageElement.parentNode.removeChild(messageElement);
        return true;
    } else {
        // 尝试使用querySelector查找
        const altSelector = `#${messageId.replace(/:/g, '\\:')}`;  
        const altElement = document.querySelector(altSelector);
        if (altElement) {
            debugLog('通过选择器找到元素，正在移除');
            altElement.parentNode.removeChild(altElement);
            return true;
        }
        console.log('removeChatMessage从 DOM 中移除消息失败，未找到ID:', messageId);
        return false;
    }
}

/**
 * 删除聊天消息
 * 从 DOM 和历史记录中删除消息，并更新缓存
 * @param {string} messageId 要删除的消息 ID
 * @param {boolean} skipConfirm 是否跳过确认提示，默认为false
 */
function deleteChatMessage(messageId, skipConfirm = false) {
    try {
        // 确认是否要删除
        if (!skipConfirm && !confirm('确定要删除这条消息吗？')) {
            return;
        }
        
        // 从 DOM 中移除消息元素
        removeChatMessage(messageId);
        
        // 从消息ID（即HTML的DIV的id）中提取后缀数字
        const idMatch = messageId.match(/-(\d+)$/);
        if (idMatch && idMatch[1]) {
            const idSuffix = parseInt(idMatch[1], 10);
            // 如果后缀数字在有效范围内，直接使用它作为索引
            if (idSuffix >= 0 && idSuffix < chatHistory.length) {
                chatHistory.splice(idSuffix, 1);
                // 保存更新后的聊天历史到缓存
                if (window.cacheManager) {
                    debugLog('deleteChatMessage 调用 saveChatHistory');
                    window.cacheManager.saveChatHistory(chatHistory)
                        .catch(error => console.error('保存聊天历史到缓存失败:', error));
                }
                console.log('chatHistory 更新后长度:', chatHistory.length);
                // 更新所有消息ID，确保与chatHistory索引一致
                updateMessageIds();
                // 为所有消息基于新id重新添加操作按钮
                addActionButtonsToExistingMessages();
            } else {
                console.error('消息ID后缀数字超出范围:', idSuffix, '当前历史长度:', chatHistory.length);
            }
        } else {
            console.error('无法从消息ID中提取后缀数字:', messageId);
        }
    } catch (error) {
        console.error('删除消息时出错:', error);
        alert('删除消息时出错。');
    }
}

/**
 * 更新所有消息的ID和chatHistory中的messageId
 */
function updateMessageIds() {
    // 重置消息计数器，确保新生成的ID从0开始
    messageCounter = 0;
    
    // 获取所有消息元素
    const messageElements = document.querySelectorAll('.deepread-chat-message');
    
    // 检查消息元素的数量是否与chatHistory的长度一致
    if (messageElements.length !== chatHistory.length) {
        console.error('对话列表消息数量与缓存的chatHistory长度不一致，不进行更新:', 
                      messageElements.length, 'vs', chatHistory.length);
        return;
    }
    
    debugLog('开始更新所有消息ID...');
    
    // 遍历所有消息元素，更新ID
    messageElements.forEach((element, index) => {
        const oldId = element.id;
        const timestamp = Date.now();
        const newId = 'msg-' + timestamp + '-' + index;
        
        // 输出日志
        // debugLog(`更新消息[${index}] - 原来ID: ${oldId}, 新ID: ${newId}`);
        
        // 更新元素ID
        element.id = newId;
        
        // 同时更新chatHistory中的messageId
        if (chatHistory[index]) {
            chatHistory[index].messageId = newId;
        }
    });
    
    debugLog('所有消息ID更新完成');
}

// 为现有的聊天消息添加操作按钮
function addActionButtonsToExistingMessages() {
    try {
        // 获取所有聊天消息元素
        const chatMessages = document.querySelectorAll('.deepread-chat-message');
        
        // 遍历每个消息元素
        chatMessages.forEach(messageElement => {
            // 如果消息元素已经有操作按钮，则跳过
            // if (messageElement.querySelector('.deepread-chat-message-actions')) {
            //     return;
            // }
            
            // 获取消息角色
            const isUserMessage = messageElement.classList.contains('deepread-chat-message-user');
            const isAssistantMessage = messageElement.classList.contains('deepread-chat-message-assistant');
            const role = isUserMessage ? 'user' : (isAssistantMessage ? 'assistant' : '');
            
            // 如果不是用户或助手消息，则跳过
            if (!role) return;
            
            // 获取消息内容
            let messageContent = '';
            if (role === 'assistant' && messageElement.innerHTML) {
                messageContent = messageElement.innerHTML;
            } else {
                messageContent = messageElement.textContent || messageElement.innerText || '';
            }
            
            // 使用通用函数创建操作按钮
            debugLog("addActionButtonsToExistingMessages 调用 createChatMessageActions");
            const actionsContainer = createChatMessageActions(messageElement.id, messageContent, role);
            
            // 添加操作按钮容器到消息元素
            messageElement.appendChild(actionsContainer);
        });
        debugLog('已为所有消息添加操作按钮');
    } catch (error) {
        console.error('为现有消息添加操作按钮时出错:', error);
    }
}

// 将当前概念解释插入到聊天对话区域
function insertConceptToChat() {
    try {
        // 获取当前概念信息
        const fullText = document.querySelector('.deepread-concept-title').textContent;
        if (currentConceptIndex < 0 || currentConceptIndex >= conceptHistory.length) {
            console.debug('当前没有有效的概念可以插入到对话区');
            if (!fullText || fullText != '全文分析') {
                console.debug('当前没有全文分析可以插入到对话区');
                return;
            }
        }
        let conceptName = '';
        let explanation = '';
        // 如果是全文分析，则插入文章标题/页面标题作为conceptName
        if (fullText == '全文分析') {
            conceptName = `[${pageTitle}](${currentUrl}) 内容概要`
            explanation = document.querySelector('.deepread-concept-explanation-summary').textContent;
        } else {
            const currentConcept = conceptHistory[currentConceptIndex];
            // 获取概念名称和解释
            conceptName = currentConcept.name || currentConcept.displayName;
            conceptName = `请解释 "${conceptName}"`
            explanation = currentConcept.response?.explanation || '没有找到相关解释';
        }
        // 如果explanation不存在，返回
        // if (!explanation) {
        //     console.error('没有找到相关解释');
        //     return;
        // }
        
        // 插入用户提问和助手回答
        addChatMessage(conceptName, 'user');
        addChatMessage(explanation, 'assistant');
        
        // 滚动到对话区底部
        const chatMessages = document.getElementById('deepread-chat-messages');
        if (chatMessages) {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        
        console.log(`已将概念 “${conceptName}” 的解释插入到对话区`);
    } catch (error) {
        console.error('插入概念到对话区时出错:', error);
    }
}

// 清除聊天历史
async function clearChatHistory() {
    if (confirm('确定要清除所有聊天记录吗？')) {
        try {
            // 先清除UI显示，然后用mcp保存聊天记忆，然后清除缓存
            // 清除聊天消息显示区域
            const chatMessages = document.getElementById('deepread-chat-messages');
            if (chatMessages) {
                chatMessages.innerHTML = '';
                
                // 添加欢迎消息，但不将其添加到聊天历史
                addChatMessage(greetingMessage, 'assistant', false, false);
            }
            
            // 用mcp保存聊天记忆
            await saveChatHistoryToMCP(chatHistory);

            // 清除内存中的聊天历史
            chatHistory = [];
            
            // 清除缓存
            if (window.cacheManager) {
                debugLog('clearChatHistory 调用 saveChatHistory');
                await window.cacheManager.saveChatHistory([]);
            }
            
            alert('聊天记录已清除！');
            return true;
        } catch (error) {
            console.error('清除聊天记录时出错:', error);
            alert('清除聊天记录时出错，请重试。');
            return false;
        }
    }
    return false;
}

// *********************************************** 以下是全局公共工具函数 ***********************************************

// 调试输出函数（核心代码）
function debugLog(message) {
    console.debug('DEBUG <-----> ' + message);
    // 在Chrome扩展环境中，不需要显示调试区域
    if (!isExtensionEnvironment) {
        const debugLog = document.getElementById('debug-log');
        if (debugLog) {
            const logEntry = document.createElement('div');
            logEntry.textContent = message;
            debugLog.appendChild(logEntry);
            // 滚动到底部
            debugLog.scrollTop = debugLog.scrollHeight;
        }
    }
}

/**
 * 手动修复JSON字符串中的常见问题
 * @param {string} jsonString JSON字符串
 * @returns {string} 修复后的JSON字符串
 */
function manualJsonFix(jsonString) {
    if (!jsonString) return jsonString;
    
    let fixedJson = jsonString;
    
    try {
        // 先尝试解析，如果可以直接解析则不需要修复
        JSON.parse(fixedJson);
        return fixedJson; // 如果可以正常解析，直接返回
    } catch (e) {
        // 解析失败，需要修复
        console.log('原始 JSON 解析失败，尝试手动修复...');
    }
    
    // 如果字符串中有多个JSON对象，只保留第一个
    const firstBraceIndex = fixedJson.indexOf('{');
    const lastBraceIndex = fixedJson.lastIndexOf('}');
    
    if (firstBraceIndex !== -1 && lastBraceIndex !== -1 && lastBraceIndex > firstBraceIndex) {
        fixedJson = fixedJson.substring(firstBraceIndex, lastBraceIndex + 1);
    }
    
    // 检测并修复缺少右花括号的情况
    const leftBraces = (fixedJson.match(/\{/g) || []).length;
    const rightBraces = (fixedJson.match(/\}/g) || []).length;
    
    if (leftBraces > rightBraces) {
        console.log(`检测到缺少${leftBraces - rightBraces}个右花括号，正在修复...`);
        // 添加缺少的右花括号
        for (let i = 0; i < leftBraces - rightBraces; i++) {
            fixedJson += '}';
        }
    }
    
    return fixedJson;
}

/**
 * 修复常见的JSON格式错误
 * @param {string} jsonString JSON字符串
 * @returns {string} 修复后的JSON字符串
 */
function fixCommonJsonErrors(jsonString) {
    if (!jsonString) return jsonString;
    
    // 保存原始字符串，方便在所有修复方法失败时返回
    const originalJson = jsonString;
    
    // 首先使用手动修复函数进行基本修复
    let fixedJson = manualJsonFix(jsonString);
    
    try {
        // 尝试解析修复后的JSON
        JSON.parse(fixedJson);
        debugLog('基本修复后的JSON可以正常解析');
        return fixedJson;
    } catch (e) {
        // 如果基本修复后仍然无法解析，进行更多的修复
        debugLog('基本修复后仍无法解析，尝试更多修复...');
    }
    
    // 解析失败，需要修复
    debugLog('原始 JSON 解析失败，尝试修复...');
    
    // 检测并修复缺少右花括号的情况
    const leftBraces = (fixedJson.match(/\{/g) || []).length;
    const rightBraces = (fixedJson.match(/\}/g) || []).length;
    
    if (leftBraces > rightBraces) {
        debugLog(`检测到缺少${leftBraces - rightBraces}个右花括号，正在修复...`);
        // 添加缺少的右花括号
        for (let i = 0; i < leftBraces - rightBraces; i++) {
            fixedJson += '}';
        }
    }
    
    // 修复错误的逗号用法，如属性后面没有值就直接逗号
    fixedJson = fixedJson.replace(/"[^"]+"\s*,\s*([,\}])/g, '"$1"');
    
    // 修复属性名没有双引号的情况
    fixedJson = fixedJson.replace(/(\{|,)\s*([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
    
    // 修复数组中多余的逗号
    fixedJson = fixedJson.replace(/,\s*\]/g, ']');
    
    // 修复对象中多余的逗号
    fixedJson = fixedJson.replace(/,\s*\}/g, '}');
    
    // 特殊情况处理 1：": ]"
    // 如果数组元素后面有冒号和方括号，将其替换为正确的数组格式
    fixedJson = fixedJson.replace(/"([^"]+)"\s*:\s*\]/g, '"$1"]');
    
    // 特殊情况处理 2：":  }"
    // 如果属性值后面有冒号和大括号，将其替换为正确的对象格式
    fixedJson = fixedJson.replace(/"([^"]+)"\s*:\s*"([^"]*)"\s*:\s*\}/g, '"$1": "$2"}');
    
    // 特殊情况处理 3：属性值后面的多余冒号
    fixedJson = fixedJson.replace(/"([^"]+)"\s*:\s*"([^"]*)"\s*:/g, '"$1": "$2"');
    
    debugLog('修复后的JSON:', fixedJson);

    // 尝试解析修复后的JSON
    try {
        JSON.parse(fixedJson);
        debugLog('修复成功！');
    } catch (e) {
        debugLog('修复后仍然无法解析，尝试使用备用方法...');
        
        // 如果上述修复仍然无法解析，尝试使用更激进的方法
        try {
            // 尝试使用正则表达式匹配并提取JSON对象
            const jsonMatch = fixedJson.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const extractedJson = jsonMatch[0];
                // 尝试解析提取出的JSON
                JSON.parse(extractedJson);
                fixedJson = extractedJson;
                debugLog('使用提取方法修复成功！');
            }
        } catch (e2) {
            debugLog('所有修复方法均失败，返回原始字符串');
            // 如果所有方法都失败，返回原始字符串
            return originalJson;
        }
    }
    
    return fixedJson;
}

// 创建设置面板
function createSettingsPanel() {
    // 检查是否已存在设置面板
    if (document.getElementById('deepread-settings-panel')) {
        // 如果已存在，则显示
        const settingsPanel = document.getElementById('deepread-settings-panel');
        settingsPanel.style.display = 'block';
        return;
    }
    
    // 创建设置面板容器
    const settingsContainer = document.createElement('div');
    settingsContainer.id = 'deepread-settings-panel';
    settingsContainer.className = 'deepread-settings-panel';
    
    // 创建标题
    const header = document.createElement('div');
    header.className = 'deepread-settings-header';
    
    const title = document.createElement('h2');
    title.id = 'deepread-settings-title';
    title.textContent = 'DeepRead 设置';
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'deepread-close-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', function() {
        settingsContainer.style.display = 'none';
    });
    
    header.appendChild(title);
    header.appendChild(closeBtn);
    
    // 创建内容区域
    const content = document.createElement('div');
    content.className = 'deepread-settings-content';
    
    // 获取当前保存的API Key和MODEL
    let savedApiKey = '';
    let savedFeishuWebhookUrl = '';
    try{
        savedFeishuWebhookUrl = (localStorage.getItem('deepread_feishu_webhook_url') || '').trim();
    }catch{}
    
    // 使用Chrome存储API获取设置
    if (isExtensionEnvironment && chrome.storage) {
        chrome.storage.sync.get(['deepread_api_key', 'deepread_model', 'deepread_thinking_level', 'deepread_feishu_webhook_url'], function(result) {
            if (result.deepread_api_key) {
                document.getElementById('deepread-api-key').value = result.deepread_api_key;
            }
            if (result.deepread_model) {
                const savedModel = result.deepread_model;
                const modelSelect = document.getElementById('deepread-model-select');
                const customModelInput = document.getElementById('deepread-model-custom');
                // 检查是否是预置模型
                const presetOptions = Array.from(modelSelect.options).map(opt => opt.value);
                if (presetOptions.includes(savedModel)) {
                    modelSelect.value = savedModel;
                    customModelInput.style.display = 'none';
                } else {
                    modelSelect.value = 'custom';
                    customModelInput.style.display = 'block';
                    customModelInput.value = savedModel;
                }
            }
            if (result.deepread_thinking_level) {
                const thinkingSlider = document.getElementById('deepread-thinking-level');
                const thinkingValue = document.getElementById('deepread-thinking-value');
                const levelMap = { 'MINIMAL': 0, 'LOW': 1, 'MEDIUM': 2, 'HIGH': 3 };
                thinkingSlider.value = levelMap[result.deepread_thinking_level] || 0;
                thinkingValue.textContent = result.deepread_thinking_level;
            }
            if (result.deepread_feishu_webhook_url) {
                const v = String(result.deepread_feishu_webhook_url || '').trim();
                try{ localStorage.setItem('deepread_feishu_webhook_url', v); }catch{}
                const input = document.getElementById('deepread-feishu-webhook-url');
                if (input) input.value = v;
            }
        });
    }
    
    // 模型设置和缓存管理
    content.innerHTML = `
        <div class="deepread-settings-section">
            <h3 id="deepread-settings-title-api">API 设置</h3>
            <div class="deepread-settings-item">
                <a href="https://aistudio.google.com/apikey">Google Gemini API Key</a>
                <input type="text" id="deepread-api-key" class="deepread-settings-input" 
                       value="${savedApiKey}" placeholder="输入您的API Key...">
            </div>
            <div class="deepread-settings-item">
                <label for="deepread-model-select">模型选择</label>
                <select id="deepread-model-select" class="deepread-settings-select">
                    <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite</option>
                    <option value="gemini-flash-lite-latest">gemini-flash-lite-latest</option>
                    <option value="gemini-3-flash-preview" selected>gemini-3-flash-preview</option>
                    <option value="custom">自定义模型...</option>
                </select>
                <input type="text" id="deepread-model-custom" class="deepread-settings-input" 
                       style="display: none; margin-top: 8px;" placeholder="输入自定义模型名称...">
            </div>
            <div class="deepread-settings-item">
                <label for="deepread-thinking-level">Thinking Level: <span id="deepread-thinking-value">MINIMAL</span></label>
                <input type="range" id="deepread-thinking-level" class="deepread-settings-slider" 
                       min="0" max="3" value="0" step="1">
                <div class="deepread-slider-labels">
                    <span>MINIMAL</span>
                    <span>LOW</span>
                    <span>MEDIUM</span>
                    <span>HIGH</span>
                </div>
            </div>
            <button id="deepread-save-settings" class="deepread-btn">仅保存设置</button>
            <button id="deepread-save-settings-and-refresh" class="deepread-btn">保存并刷新</button>
        </div>
        <div class="deepread-settings-section">
            <h3 id="deepread-settings-title-cache">缓存管理</h3>
            <div class="deepread-settings-item">
                <p id="deepread-settings-cache-desc">DeepRead会保存您的聊天历史和概念查询记录，以便您下次打开时继续使用。</p>
            </div>
            <button id="deepread-clear-cache" class="deepread-btn deepread-btn-danger">清除所有缓存</button>
        </div>
        <div class="deepread-settings-section">
            <h3 id="deepread-settings-title-feishu">飞书</h3>
            <div class="deepread-settings-item">
                <label for="deepread-feishu-webhook-url">Feishu Webhook URL</label>
                <input type="text" id="deepread-feishu-webhook-url" class="deepread-settings-input" 
                       value="${savedFeishuWebhookUrl}" placeholder="https://www.feishu.cn/flow/api/trigger-webhook/...">
            </div>
        </div>
    `;
    
    // 组装面板
    settingsContainer.appendChild(header);
    settingsContainer.appendChild(content);
    
    // 添加到页面
    document.body.appendChild(settingsContainer);
    
    // 添加保存按钮事件
    document.getElementById('deepread-save-settings').addEventListener('click', function() {
        saveSettings(false);
    });
    
    // 添加保存并刷新按钮事件
    document.getElementById('deepread-save-settings-and-refresh').addEventListener('click', function() {
        saveSettings(true);
    });
    
    // 添加清除缓存按钮事件
    document.getElementById('deepread-clear-cache').addEventListener('click', function() {
        if (confirm('确定要清除所有缓存吗？这将删除所有聊天历史和概念查询记录。')) {
            clearAllCache();
        }
    });
    
    // 添加模型下拉选项事件
    document.getElementById('deepread-model-select').addEventListener('change', function() {
        const customInput = document.getElementById('deepread-model-custom');
        if (this.value === 'custom') {
            customInput.style.display = 'block';
            customInput.focus();
        } else {
            customInput.style.display = 'none';
        }
    });
    
    // 添加 thinkingLevel 拖动条事件
    document.getElementById('deepread-thinking-level').addEventListener('input', function() {
        const levels = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'];
        document.getElementById('deepread-thinking-value').textContent = levels[this.value];
    });
    
    // 点击设置面板外部区域时隐藏面板
    document.addEventListener('click', function(e) {
        const settingsPanel = document.getElementById('deepread-settings-panel');
        if (settingsPanel && settingsPanel.style.display !== 'none') {
            // 检查点击是否在设置面板外部
            if (!settingsPanel.contains(e.target) && !e.target.closest('#deepread-settings-btn')) {
                settingsPanel.style.display = 'none';
            }
        }
    });
}

// 保存设置
function saveSettings(shouldRefresh = false) {
    const apiKey = document.getElementById('deepread-api-key').value.trim();
    const feishuWebhookUrl = (document.getElementById('deepread-feishu-webhook-url')?.value || '').trim();
    
    // 获取模型设置
    const modelSelect = document.getElementById('deepread-model-select');
    const customModelInput = document.getElementById('deepread-model-custom');
    let modelId = modelSelect.value;
    if (modelId === 'custom') {
        modelId = customModelInput.value.trim() || 'gemini-3-flash-preview';
    }
    
    // 获取 thinkingLevel 设置
    const thinkingSlider = document.getElementById('deepread-thinking-level');
    const levels = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'];
    const thinkingLevel = levels[thinkingSlider.value];
    
    // 保存API Key、MODEL和thinkingLevel到Chrome存储
    if (isExtensionEnvironment && chrome.storage) {
        chrome.storage.sync.set({
            deepread_api_key: apiKey,
            deepread_model: modelId,
            deepread_thinking_level: thinkingLevel,
            deepread_feishu_webhook_url: feishuWebhookUrl
        }, function() {
            debugLog('设置已保存到Chrome存储: API Key, MODEL=' + modelId + ', thinkingLevel=' + thinkingLevel);
        });
        try{ localStorage.setItem('deepread_feishu_webhook_url', feishuWebhookUrl); }catch{}
    } else {
        // 如果不是在扩展环境中，使用localStorage作为后备
        localStorage.setItem('deepread_api_key', apiKey);
        localStorage.setItem('deepread_model', modelId);
        localStorage.setItem('deepread_thinking_level', thinkingLevel);
        localStorage.setItem('deepread_feishu_webhook_url', feishuWebhookUrl);
    }
    
    // 显示保存成功提示
    const saveBtn = document.getElementById('deepread-save-settings');
    const originalText = saveBtn.textContent;
    saveBtn.textContent = '保存成功!';
    saveBtn.disabled = true;
    
    // 2秒后恢复按钮状态
    setTimeout(() => {
        saveBtn.textContent = originalText;
        saveBtn.disabled = false;
    }, 2000);
    
    debugLog('设置已保存');
    
    // 根据参数决定是否刷新页面
    if (shouldRefresh) {
        location.reload();
    }
}

// 清除所有缓存
async function clearAllCache() {
    try {
        // 使用缓存管理器清除缓存
        if (window.cacheManager) {
            const success = await window.cacheManager.clearAllCache();
            if (success) {
                console.log('所有缓存已清除，包括页面分析状态');
                // 清除内存中的聊天历史和概念查询记录
                chatHistory = [];
                conceptHistory = [];
                currentConceptIndex = -1;
                
                // 清除聊天消息显示区域
                const chatMessages = document.getElementById('deepread-chat-messages');
                if (chatMessages) {
                    chatMessages.innerHTML = '';
                }
                
                // 重置内容区域到初始状态
                const contentArea = document.getElementById('deepread-content');
                if (contentArea) {
                    contentArea.innerHTML = `
                        <div class="deepread-response">
                            <button id="deepread-analyze-btn" class="deepread-btn">开始全文分析</button>
                        </div>
                    `;
                    
                    // 重新绑定全文分析按钮的点击事件
                    const analyzeBtn = document.getElementById('deepread-analyze-btn');
                    if (analyzeBtn) {
                        analyzeBtn.addEventListener('click', analyzePageContent);
                    }
                }
                
                // 重置页面分析状态
                pageAnalyzed = false;

                alert('缓存已成功清除！');
                return true;
            }
        }
        alert('清除缓存失败，请重试。');
        return false;
    } catch (error) {
        console.error('清除缓存时出错:', error);
        alert('清除缓存时出错，请重试。');
        return false;
    }
}

// 防重复点击控制
const clickCooldowns = {};

/**
* 防止重复点击的通用方法
* @param {string} actionKey - 操作的唯一标识符
* @param {Function} callback - 点击时要执行的回调函数
* @param {number} cooldownMs - 冷却时间（毫秒）
* @param {string} cooldownMessage - 冷却期间显示的提示消息
* @returns {boolean} 是否执行了回调
*/
function preventDuplicateClick(actionKey, callback, cooldownMs = 5000, cooldownMessage = '正在发送请求，请勿重复点击。') {
    const now = Date.now();
    
    // 检查是否在冷却期
    if (clickCooldowns[actionKey] && now < clickCooldowns[actionKey]) {
        debugLog(cooldownMessage);
        // 如果需要，可以在这里添加更明显的UI提示
        return false;
    }

    // 设置冷却期结束时间
    clickCooldowns[actionKey] = now + cooldownMs;

    // 执行回调
    try {
        callback();
    } catch (error) {
        console.error(`执行 ${actionKey} 的回调时出错:`, error);
        // 发生错误时，立即清除冷却，以便可以重试
        delete clickCooldowns[actionKey];
        return false;
    }

    // 冷却期结束后清除
    setTimeout(() => {
        delete clickCooldowns[actionKey];
    }, cooldownMs);

    return true;
}

// 生成唯一ID（核心代码）
let messageCounter = 0;
function generateUniqueId() {
    return 'msg-' + Date.now() + '-' + (messageCounter++);
}