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

// 设置选项
document.getElementById('options').addEventListener('click', function() {
    // 发送消息给content.js显示设置面板
    sendMessageToContentScript('showSettings');
    updateStatus('正在打开设置面板...');
});