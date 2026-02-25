// DeepRead 深度阅读助手 - 弹出界面脚本

// 添加调试信息
console.log('DeepRead popup script loaded!');

// 向当前标签页发送消息
function sendMessageToContentScript(action) {
    console.log('Sending message to content script:', action);
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (tabs && tabs.length > 0) {
            console.log('Active tab found:', tabs[0].id);
            chrome.tabs.sendMessage(tabs[0].id, {action: action}, function(response) {
                console.log('Response received:', response);
                if (chrome.runtime.lastError) {
                    console.error('Error sending message:', chrome.runtime.lastError);
                    updateStatus('发送消息错误: ' + chrome.runtime.lastError.message);
                } else if (response) {
                    updateStatus(response.message || '操作成功');
                }
            });
        } else {
            console.error('No active tab found');
            updateStatus('未找到活动标签页');
        }
    });
}

const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'];

function setThinkingLabel(v) {
    const n = Number(v);
    const idx = Number.isFinite(n) ? Math.max(0, Math.min(3, Math.round(n))) : 0;
    const el = document.getElementById('dr-popup-thinking-label');
    if (el) el.textContent = THINKING_LEVELS[idx];
}

async function loadSettingsToPopup() {
    try {
        const res = await chrome.storage.sync.get([
            'deepread_api_key',
            'deepread_model',
            'deepread_thinking_level',
            'deepread_feishu_webhook_url'
        ]);

        const apiKey = res && res.deepread_api_key ? String(res.deepread_api_key) : '';
        const model = res && res.deepread_model ? String(res.deepread_model) : 'gemini-3-flash-preview';
        const thinkingLevel = (res && typeof res.deepread_thinking_level !== 'undefined') ? Number(res.deepread_thinking_level) : 0;
        const feishu = res && res.deepread_feishu_webhook_url ? String(res.deepread_feishu_webhook_url) : '';

        const apiInput = document.getElementById('dr-popup-api-key');
        if (apiInput) apiInput.value = apiKey;

        const modelSel = document.getElementById('dr-popup-model');
        const modelCustom = document.getElementById('dr-popup-model-custom');

        if (modelSel) {
            const builtins = ['gemini-2.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3-flash-preview'];
            if (builtins.includes(model)) {
                modelSel.value = model;
                if (modelCustom) {
                    modelCustom.style.display = 'none';
                    modelCustom.value = '';
                }
            } else {
                modelSel.value = 'custom';
                if (modelCustom) {
                    modelCustom.style.display = 'block';
                    modelCustom.value = model;
                }
            }
        }

        const thinking = document.getElementById('dr-popup-thinking');
        if (thinking) thinking.value = String(Number.isFinite(thinkingLevel) ? thinkingLevel : 0);
        setThinkingLabel(thinkingLevel);

        const feishuInput = document.getElementById('dr-popup-feishu');
        if (feishuInput) feishuInput.value = feishu;
    } catch (e) {
        // ignore
    }
}

async function saveSettingsFromPopup() {
    const apiKey = String(document.getElementById('dr-popup-api-key')?.value || '').trim();
    const modelSel = String(document.getElementById('dr-popup-model')?.value || '').trim();
    const modelCustom = String(document.getElementById('dr-popup-model-custom')?.value || '').trim();
    const thinkingLevel = Number(document.getElementById('dr-popup-thinking')?.value || 0);
    const feishu = String(document.getElementById('dr-popup-feishu')?.value || '').trim();

    const modelId = modelSel === 'custom' ? modelCustom : modelSel;

    await chrome.storage.sync.set({
        deepread_api_key: apiKey,
        deepread_model: modelId,
        deepread_thinking_level: Number.isFinite(thinkingLevel) ? thinkingLevel : 0,
        deepread_feishu_webhook_url: feishu,
    });
}

// 更新状态信息
function updateStatus(message) {
    document.getElementById('status').textContent = '状态: ' + message;
}

// 开始深度阅读
document.getElementById('startReading').addEventListener('click', function() {
    sendMessageToContentScript('startReading');
    updateStatus('正在分析页面内容...');
    
    // 模拟分析完成后的状态更新
    setTimeout(function() {
        updateStatus('分析完成！请在页面上点击带下划线的概念词汇获取解读。');
    }, 2000);
});

// 显示/隐藏面板
document.getElementById('togglePanel').addEventListener('click', function() {
    sendMessageToContentScript('togglePanel');
    updateStatus('面板显示状态已切换。');
});

document.getElementById('dr-popup-model').addEventListener('change', function() {
    const v = String(this.value || '');
    const custom = document.getElementById('dr-popup-model-custom');
    if (!custom) return;
    custom.style.display = v === 'custom' ? 'block' : 'none';
});

document.getElementById('dr-popup-thinking').addEventListener('input', function() {
    setThinkingLabel(this.value);
});

document.getElementById('dr-popup-save').addEventListener('click', async function() {
    try {
        await saveSettingsFromPopup();
        updateStatus('设置已保存');
    } catch (e) {
        updateStatus('保存失败: ' + String(e && e.message ? e.message : e));
    }
});

document.getElementById('dr-popup-open-sidepanel').addEventListener('click', function() {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        try {
            const tab = tabs && tabs[0];
            if (!tab || typeof tab.id !== 'number') {
                updateStatus('未找到活动标签页');
                return;
            }
            if (chrome.sidePanel && chrome.sidePanel.open) {
                await chrome.sidePanel.open({ tabId: tab.id });
                updateStatus('已打开侧栏');
            } else {
                updateStatus('当前浏览器不支持 side panel');
            }
        } catch (e) {
            updateStatus('打开侧栏失败: ' + String(e && e.message ? e.message : e));
        }
    });
});

loadSettingsToPopup();