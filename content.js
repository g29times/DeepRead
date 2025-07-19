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
const pageSummaryFallback = '无法分析页面内容。';
const conceptExplanationFallback = '的解释暂时无法获取。';
const chatResponseFallback = '关于您的问题，我暂时无法回答。请稍后再试。';
const imageGenerationFallback = '生成图像失败，请稍后再试。';

// 页面分析状态
let pageAnalyzed = false; // 标记页面是否已经分析过
// 获取当前页面URL
const currentUrl = window.location.href;
let pageTitle = document.title;
let pageContent = ''; // 存储页面内容
let pageSummary = ''; // 存储页面摘要
let pageKeyTerms = []; // 存储页面关键术语

// 聊天历史
let chatHistory = [];
// 概念查询历史
let conceptHistory = [];
let currentConceptIndex = -1; // 当前浏览的概念索引

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
    console.log('已设置清除缓存快捷键 Alt+Shift+C');
}

// 初始化 注意：不要再这个init方法里自动展开面板，
// 这会导致打开新页面或页面刷新时，助手（作为chrome插件）自动打开，对用户体验不好
// 只有用户主动点击助手进行操作时，才打开面板，
// 具体方法是：if (isExtensionEnvironment) { chrome.runtime.onMessage.addListener
async function init() {
    console.log('DeepRead 初始化中...');
    
    // 设置清除缓存的快捷键
    setupClearCacheShortcut();
    
    // 从缓存加载数据
    if (window.cacheManager) {
        try {
            // 获取当前页面URL
            // const currentUrl = window.location.href;
            
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
            
            // 加载页面内容
            const cachedPageContent = await window.cacheManager.loadPageContent(currentUrl);
            if (cachedPageContent) {
                // 更新页面内容变量
                pageContent = cachedPageContent.content || '';
                pageSummary = cachedPageContent.summary || '';
                pageKeyTerms = cachedPageContent.keyTerms || [];
            
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
                    && pageKeyTerms.length > 0;
                
                // 如果缓存内容有效，更新页面分析状态
                if (contentValid) {
                    // 更新内存中的状态
                    pageAnalyzed = true;
                    // 同时更新缓存中的状态
                    await window.cacheManager.savePageAnalyzedStatus(currentUrl, true);
                    console.log('缓存内容有效，设置pageAnalyzed = true');
                    console.log('摘要长度:', pageSummary.length, '关键术语数量:', pageKeyTerms.length);
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
                            console.log('加载全文分析缓存，关键术语数量:', cachedPageContent.keyTerms.length);
                            // 更新全局变量
                            pageSummary = cachedPageContent.summary;
                            pageKeyTerms = cachedPageContent.keyTerms;
                        } else {
                            console.log('缓存加载失败或缓存内容不完整，使用当前内存中的数据');
                        }
                        // 全文分析结果
                        showAnalysisResults({
                            summary: pageSummary,
                            keyTerms: pageKeyTerms
                        });
                    })
                    .catch(error => {
                        console.error('加载缓存内容失败:', error);
                        // 出错时使用当前内存中的数据
                        showAnalysisResults({
                            summary: pageSummary,
                            keyTerms: pageKeyTerms
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

// 页面加载时 创建DeepRead面板
function createDeepReadPanel() {
    // 检查是否已存在面板
    if (document.getElementById('deepread-panel')) {
        return;
    }
    
    // 创建主容器
    const container = document.createElement('div');
    container.id = 'deepread-container';
    container.className = 'deepread-container deepread-hidden';
    
    // 创建可拖动边界
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'deepread-resize-handle';
    container.appendChild(resizeHandle);
    
    // 添加拖动事件处理
    initResizeHandlers(container, resizeHandle);
    
    // 创建面板
    const panel = document.createElement('div');
    panel.id = 'deepread-panel';
    panel.className = 'deepread-panel';

    // 创建标题
    const header = document.createElement('div');
    header.className = 'deepread-header';
    
    const title = document.createElement('h2');
    title.textContent = 'DeepRead 深度阅读助手';
    
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
    document.getElementById('deepread-analyze-btn').addEventListener('click', analyzeFullContent);

    // 创建导航指示器
    const navIndicator = document.createElement('div');
    navIndicator.id = 'deepread-nav-indicator';
    navIndicator.className = 'deepread-nav-indicator';
    navIndicator.style.display = 'none';
    document.body.appendChild(navIndicator);
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
        if (container.classList.contains('deepread-hidden')) {
            debugLog('隐藏面板');
        } else {
            debugLog('显示面板');
        }
    } else {
        console.error('面板显示失败');
    }
}

// createDeepReadPanel -> initResizeHandlers 初始化拖动功能(窗口变宽)
function initResizeHandlers(container, resizeHandle) {
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    
    // 开始拖动
    resizeHandle.addEventListener('mousedown', function(e) {
        isResizing = true;
        startX = e.clientX;
        startWidth = parseInt(document.defaultView.getComputedStyle(container).width, 10);
        resizeHandle.classList.add('active');
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none'; // 防止拖动时选中文本
        
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
    document.addEventListener('mouseup', function() {
        if (isResizing) {
            isResizing = false;
            resizeHandle.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

/**
 * 查找页面中的内容区域
 * @returns {Array} 内容区域元素数组
 */
function findContentAreas() {
    // 尝试查找所有可能的内容区域
    const contentSelectors = [
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

// 页面加载时 添加文本选择（用户选择文本，点击浮动按钮）事件监听
function addTextSelectionListener() {
    debugLog('添加文本选择事件监听');
    
    document.addEventListener('mouseup', function(event) {
        const selection = window.getSelection();
        const selectedText = selection.toString().trim();
        
        if (selectedText && selectedText.length > 1) { // 至少选择2个字符
            // debugLog('选中文本: ' + selectedText);
            
            // 移除现有的浮动按钮
            const existingButtons = document.querySelectorAll('.deepread-float-button');
            existingButtons.forEach(button => {
                if (document.body.contains(button)) {
                    document.body.removeChild(button);
                }
            });
            
            // 创建浮动按钮
            const floatButton = document.createElement('div');
            floatButton.className = 'deepread-float-button';
            floatButton.textContent = 'DR';
            floatButton.title = '深度阅读该概念';
            
            // 定位浮动按钮到鼠标位置
            floatButton.style.left = (event.pageX + 10) + 'px';
            floatButton.style.top = (event.pageY + 10) + 'px';
            
            // 添加点击事件
            floatButton.addEventListener('click', function() {
                debugLog('点击了浮动按钮，选中文本: ' + selectedText);
                
                // 移除浮动按钮
                document.body.removeChild(floatButton);
                
                // 打开阅读助手并跳转到相应词条
                openDeepReadWithConcept(selectedText);
            });
            
            // 添加到页面
            document.body.appendChild(floatButton);
            
            // 5秒后自动移除浮动按钮
            setTimeout(function() {
                if (document.body.contains(floatButton)) {
                    document.body.removeChild(floatButton);
                }
            }, 5000);
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
        
        // 使用用户配置的MODEL，如果没有则使用默认值
        let MODEL_ID = 'gemini-2.5-flash-lite-preview-06-17'; // 默认值
        
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
        
        // 请求配置
        const requestBody = {
            contents: contents,
            generationConfig: {
                responseMimeType: 'text/plain',
                temperature: 0.7,
                topP: 0.95,
                topK: 64,
                maxOutputTokens: 8192
            },
            tools: [
              {
                googleSearch: {}
              },
            ],
        };
        
        debugLog(`发送 ${apiType} 请求到 Google Gemini API \n ${API_URL}`);
        
        // 创建AbortController来设置超时
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000); // 300秒超时
        // 发送请求
        let response;
        try {
            
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
        
        // 使用新的解析函数处理响应
        return parseGeminiResponse(responseData, apiType, expectJson, fallbackResponse);
    } catch (error) {
        console.error(`${apiType} 调用出错:`, error);
        // 返回预设的回退响应
        return fallbackResponse;
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
            
            // 检查是否包含groundingMetadata（搜索结果）
            if (candidate.groundingMetadata) {
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
            } else {
                // 没有groundingMetadata，按原来的方式处理
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
        return expectJson ? fallbackResponse : (typeof fallbackResponse === 'string' ? fallbackResponse : '处理响应时出错');
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
        // 如果没有groundingMetadata或者groundingSupports，直接返回原文
        if (!groundingMetadata || !groundingMetadata.groundingSupports || !groundingMetadata.groundingChunks) {
            return responseText;
        }
        
        debugLog('处理groundingMetadata，添加引用标记和Sources区块');
        debugLog('groundingSupports 数量:', groundingMetadata.groundingSupports.length);
        debugLog('groundingChunks 数量:', groundingMetadata.groundingChunks.length);
        
        // 首先收集所有唯一的引用源
        const sources = [];
        const sourceMap = new Map(); // 用于去重
        
        // 遍历所有groundingChunks，收集唯一的源
        groundingMetadata.groundingChunks.forEach((chunk, index) => {
            if (chunk && chunk.web) {
                const { uri, title } = chunk.web;
                if (!sourceMap.has(uri)) {
                    sourceMap.set(uri, sources.length + 1); // 索引从1开始
                    sources.push({ uri, title });
                    debugLog(`添加源 ${sources.length}: ${title || uri}`);
                }
            }
        });
        
        // 创建一个副本，避免修改原始文本
        let processedText = responseText;
        debugLog('原始文本长度:', responseText.length);
        
        // 按照endIndex从大到小排序，这样我们可以从后向前插入引用标记，避免位置偏移
        const sortedSupports = [...groundingMetadata.groundingSupports].sort((a, b) => 
            b.segment.endIndex - a.segment.endIndex
        );
        
        debugLog('按endIndex排序后的supports:');
        sortedSupports.forEach((support, index) => {
            if (support.segment) {
                debugLog(`Support ${index}: startIndex=${support.segment.startIndex}, endIndex=${support.segment.endIndex}`);
                debugLog(`  段落文本: "${support.segment.text ? support.segment.text.substring(0, 100) : 'undefined'}..."`);
                debugLog(`  引用索引: [${support.groundingChunkIndices.join(', ')}]`);
            } else {
                debugLog(`Support ${index}: 没有segment`);
            }
        });
        
        // 创建一个映射来跟踪每个segment的处理状态
        const segmentProcessed = new Set();
        
        // 遍历每个支持段落，从后向前添加引用标记
        for (let i = 0; i < sortedSupports.length; i++) {
            const support = sortedSupports[i];
            const { segment, groundingChunkIndices } = support;
            
            if (!segment || !segment.text) {
                debugLog(`Support ${i}: 没有segment或segment.text，跳过`);
                continue;
            }
            
            const expectedText = segment.text;
            // 使用更精确的segmentKey，包含位置信息避免误判
            const segmentKey = `${segment.startIndex || 0}_${segment.endIndex}_${expectedText.substring(0, 50)}`;
            
            // 避免重复处理相同的segment
            if (segmentProcessed.has(segmentKey)) {
                debugLog(`Support ${i}: segment已处理过，跳过`);
                continue;
            }
            
            debugLog(`Support ${i}: 处理segment "${expectedText.substring(0, 50)}..."`);
            debugLog(`Support ${i}: 完整segment文本: "${expectedText}"`);
            debugLog(`Support ${i}: segment长度: ${expectedText.length}`);
            
            // 在当前处理的文本中查找匹配的段落
            let foundIndex = -1;
            let searchStartIndex = 0;
            
            // 尝试多次搜索，以防有重复文本
            while (true) {
                const tempIndex = processedText.indexOf(expectedText, searchStartIndex);
                if (tempIndex === -1) break;
                
                // 检查这个位置是否已经被处理过（是否已经有引用标记）
                const afterText = processedText.substring(tempIndex + expectedText.length, tempIndex + expectedText.length + 50);
                if (!afterText.includes('<a href=')) {
                    foundIndex = tempIndex;
                    break;
                }
                
                searchStartIndex = tempIndex + 1;
            }
            
            if (foundIndex === -1) {
                debugLog(`Support ${i}: 未找到匹配文本`);
                // 添加更详细的调试信息
                debugLog(`Support ${i}: 原文长度: ${processedText.length}`);
                debugLog(`Support ${i}: 尝试模糊匹配...`);
                
                // 尝试去掉空格和换行符的匹配
                const normalizedExpected = expectedText.replace(/\s+/g, ' ').trim();
                const normalizedProcessed = processedText.replace(/\s+/g, ' ');
                const fuzzyIndex = normalizedProcessed.indexOf(normalizedExpected);
                
                if (fuzzyIndex !== -1) {
                    debugLog(`Support ${i}: 模糊匹配成功，位置: ${fuzzyIndex}`);
                    
                    // 根据模糊匹配的位置，在原文中找到实际位置
                    // 计算在原文中的大概位置
                    let charCount = 0;
                    let realIndex = -1;
                    
                    for (let j = 0; j < processedText.length; j++) {
                        if (processedText[j] !== ' ' && processedText[j] !== '\n' && processedText[j] !== '\t') {
                            if (charCount === fuzzyIndex) {
                                realIndex = j;
                                break;
                            }
                            charCount++;
                        }
                    }
                    
                    // 从找到的位置开始，寻找最佳匹配
                    if (realIndex !== -1) {
                        // 在附近区域搜索最佳匹配
                        const searchStart = Math.max(0, realIndex - 50);
                        const searchEnd = Math.min(processedText.length, realIndex + expectedText.length + 50);
                        const searchArea = processedText.substring(searchStart, searchEnd);
                        
                        // 尝试找到最佳匹配位置
                        const bestMatch = searchArea.indexOf(expectedText.substring(0, 10)); // 用前10个字符匹配
                        if (bestMatch !== -1) {
                            foundIndex = searchStart + bestMatch;
                            debugLog(`Support ${i}: 找到最佳匹配位置: ${foundIndex}`);
                        }
                    }
                }
                
                if (foundIndex === -1) {
                    debugLog(`Support ${i}: 所有匹配方法都失败`);
                    continue;
                }
            }
            
            const correctedEndIndex = foundIndex + expectedText.length;
            debugLog(`Support ${i}: 在位置 ${foundIndex}-${correctedEndIndex} 找到匹配文本`);
            
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
                // 将引用编号排序后生成HTML链接
                const sortedCitations = Array.from(citations).sort((a, b) => a - b);
                const citationStr = sortedCitations.map(idx => {
                    const source = sources[idx - 1];
                    if (source) {
                        return `<a href="${source.uri}" target="_blank" style="color: #1a73e8; text-decoration: none; font-weight: 500;">[${idx}]</a>`;
                    }
                    return `[${idx}]`;
                }).join('');
                
                // 在段落末尾插入引用标记
                processedText = processedText.substring(0, correctedEndIndex) + 
                               citationStr + 
                               processedText.substring(correctedEndIndex);
                
                debugLog(`Support ${i}: 添加引用 ${citationStr}`);
                
                // 标记这个segment已经处理过
                segmentProcessed.add(segmentKey);
            } else {
                debugLog(`Support ${i}: 没有找到有效的引用源`);
            }
        }
        
        debugLog(`总共处理了 ${segmentProcessed.size} 个segment`);
        
        // 如果有引用源，添加Sources区块
        if (sources.length > 0) {
            // 在文本末尾添加空行和Sources区块
            processedText += '\n\n**Sources** \n';
            
            // 添加每个源的信息，带有超链接
            sources.forEach((source, index) => {
                const displayTitle = source.title || new URL(source.uri).hostname;
                processedText += `${index + 1}. <a href="${source.uri}" target="_blank" style="color: #1a73e8; text-decoration: none;">${displayTitle}</a>\n`;
            });
        }
        
        debugLog('处理后文本长度:', processedText.length);
        return processedText;
    } catch (error) {
        console.error('处理groundingMetadata时出错:', error);
        return responseText; // 出错时返回原始文本
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
async function callGeminiDrawAPI(contents, apiType, expectJson = false, fallbackResponse = {}) {
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

        // 使用用户配置的MODEL，如果没有则使用默认值
        // 注意：对于多模态，我们需要使用支持图像生成的模型
        let MODEL_ID = 'gemini-2.5-flash-lite-preview-06-17';
		// 'gemini-2.0-flash-preview-image-generation'; // 默认值
        
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
    
// 1 全文分析 - 附加文本编辑和确认流程
function analyzeFullContent() {
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
    
    // 显示文本编辑区域
    showTextEditor(pageContent);

}

// a 全文分析 提取页面内容
function extractPageContent() {
    debugLog('第一步：提取页面内容 --->');
    
    // 获取所有内容区域
    const contentAreas = findContentAreas();
    
    // 获取排除UI元素的选择器
    const excludeSelectors = getExcludeSelectors();
    
    // 获取所有段落，但排除UI元素中的段落
    const paragraphs = [];
    let processedElements = new Set(); // 用于跟踪已处理过的元素，避免重复
    // 为每个段落添加ID
    let idCounter = 0;
    
    // 处理每个内容区域
    contentAreas.forEach(contentArea => {
        // 获取所有段落、标题和列表项
        const elements = contentArea.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li');
        
        elements.forEach(element => {
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
            if (!text || text.length < 5) { // 排除非常短的段落
                shouldExclude = true;
            }
            
            if (!shouldExclude) {
                paragraphs.push(element);
                // // 添加ID
                // element.id = 'paragraph-' + idCounter;
                // idCounter++;
            }
        });
    });
    
    // 构建内容
    let content = '';
    paragraphs.forEach((paragraph, index) => {
        // 添加段落ID信息
        content += `[paragraph-${index}] ${paragraph.textContent.trim()}\n\n`;
    });
    
    // 如果提取的内容为空，尝试获取所有可见文本
    if (!content.trim()) {
        debugLog('提取的内容为空，尝试获取所有可见文本');
        const textNodes = [];
        const walker = document.createTreeWalker(
            document.body, 
            NodeFilter.SHOW_TEXT, 
            { acceptNode: node => node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT }
        );
        
        let node;
        let idCounter = paragraphs.length; // 从已有段落数量开始计数
        
        while (node = walker.nextNode()) {
            const text = node.textContent.trim();
            if (text && text.length >= 8) { // 只获取有意义的文本
                // 检查节点的父元素是否已经处理过
                const parentElement = node.parentElement;
                if (parentElement && !processedElements.has(parentElement)) {
                    // 标记为已处理
                    processedElements.add(parentElement);
                    
                    // 为父元素添加ID
                    // if (!parentElement.id) {
                    //     parentElement.id = 'paragraph-' + idCounter;
                    // }
                    
                    // 添加到内容中
                    textNodes.push(text);
                    content += `[paragraph-${idCounter}] ${text}\n\n`;
                    
                    // 增加计数器
                    idCounter++;
                }
            }
        }
        
        debugLog(`使用TreeWalker提取了 ${textNodes.length} 个文本节点`);
    }
    
    debugLog('第一步：---> 提取页面内容长度: ' + content.length);
    return content;
}

// b 全文分析 显示文本编辑区域（待确认）
function showTextEditor(content) {
    debugLog('第二步：显示文本编辑区域 待确认分析内容');
    
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
                    <button id="deepread-analyze-btn">确认分析</button>
                    <button id="deepread-reanalyze-btn" title="重新提取页面内容">重新提取</button>
                    <button id="deepread-cancel-btn">取消</button>
                </div>
                <textarea class="deepread-text-editor" id="deepread-text-input">${content}</textarea>
            </div>
        `;
        
        // 添加确认分析按钮事件
        const analyzeBtn = document.getElementById('deepread-analyze-btn');
        if (analyzeBtn) {
            analyzeBtn.addEventListener('click', function() {
                const textInput = document.getElementById('deepread-text-input');
                if (textInput) {
                    const editedContent = textInput.value;
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

// c 全文分析 调用LLM API（已确认）
async function analyzeContent(content) {
    debugLog('第三步：确认分析字数：' + content.length + '，预览: ' + content.substring(0, 100) + '...');
    
    // 显示加载状态
    const deepreadContent = document.getElementById('deepread-content');
    if (deepreadContent) {
        deepreadContent.innerHTML = '<div class="deepread-loading">正在分析内容，请稍等...</div>';
    }
    try {
        // 调用LLM API获取分析结果
        const llmResponse = await getFullContentAnalyze(content);
        // 如果调用失败，使用预设数据
        if (!llmResponse || llmResponse.summary == pageSummaryFallback) {
            console.error('获取分析结果失败');
            return;
        }
        // 存储关键术语以供后续使用
        if (llmResponse && llmResponse.keyTerms) {
            window.keyTerms = llmResponse.keyTerms;
            pageContent = content;
            pageKeyTerms = llmResponse.keyTerms;
            pageSummary = llmResponse.summary || '';
            
            // 保存页面内容到缓存
            if (window.cacheManager) {
                const pageData = {
                    url: currentUrl,
                    title: pageTitle,
                    content: pageContent,
                    summary: pageSummary,
                    keyTerms: pageKeyTerms,
                    timestamp: Date.now()
                };
                window.cacheManager.savePageContent(pageData)
                    .catch(error => console.error('保存页面内容到缓存失败:', error));
                await window.cacheManager.savePageAnalyzedStatus(currentUrl, true);
                debugLog('页面分析状态已更新并保存到缓存');
            }

            // 显示分析结果
            showAnalysisResults(llmResponse);
            // 更新页面分析状态
            pageAnalyzed = true;
            // 为段落添加ID
            addParagraphIds()
        }
    } catch (error) {
        console.error('分析内容时出错:', error);
        // 在出错时显示错误信息
        if (deepreadContent) {
            deepreadContent.innerHTML = '<div class="deepread-error">抱歉，分析内容时出错。</div>';
        }
    }
}

// d 全文分析完成 为段落添加ID 这个方法对于长文会导致页面卡顿 谨慎！
async function addParagraphIds() {
    debugLog('第四步：为段落添加ID --->');
    
    // 获取内容区域
    const contentAreas = findContentAreas();
    
    // 获取排除UI元素的选择器
    const excludeSelectors = getExcludeSelectors();
    
    // 为每个段落添加ID
    let idCounter = 0;
    let processedElements = new Set(); // 用于跟踪已处理过的元素，避免重复
    
    // 处理每个内容区域
    contentAreas.forEach(contentArea => {
        // 获取所有段落、标题和列表项
        const elements = contentArea.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li');
        
        elements.forEach((element) => {
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
            
            if (!shouldExclude) {
                // 添加ID
                element.id = 'paragraph-' + idCounter;
                idCounter++;
            }
        });
    });

    // 如果没有给任何元素分配ID，则为可见文本的父元素补充ID
    if (idCounter === 0) {
        debugLog('未找到有效段落，为可见文本父元素补充ID');
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
                !parentElement.id &&
                node.textContent.trim().length >= 8 // 只处理有意义的文本
            ) {
                processedElements.add(parentElement);
                parentElement.id = 'paragraph-' + idCounter;
                idCounter++;
            }
        }
    } else {
        debugLog('跳过段落ID' + idCounter);
    }
    
    debugLog(`第四步：---> 共添加了 ${idCounter} 个段落ID`);
}

/**
 * Google API 获取全文理解
 * @param {string} content 页面内容
 * @returns {Promise<Object>} 分析结果，包含摘要和关键术语
 */
async function getFullContentAnalyze(content) {
    debugLog('开始分析全文内容，长度：' + content.length);
    
    // 系统提示词
    const systemPrompt = `
        我是一个专业的深度阅读助手DeepRead，帮助用户进行网页浏览和理解。
        我和用户正在查看一个网页，网页的内容是文章/资料/视频等，
        我会使用中文进行总结，但对于部分必要的专有名字，我会在括号中附上原文。
        对于普通页面，我会给出核心主题/摘要和关键术语（方便用户点击并跳转以进一步浏览）。
            如果是论文等学术研究内容，我可能会为内容摘要提供“背景知识、主要内容、研究方法、应用场景、面临挑战、结论”等信息。
        对于视频页，我会基于视频字幕脚本给出视频内容摘要，但不提供关键术语（视频页无需跳转）。

        ---
        
        网页内容：'''
        ${content}
        '''
        
        ---
        
        我会按以下JSON格式返回结果：
        {
            "summary": "内容摘要，简要描述网页的主题和要点",
            "keyTerms": ["关键术语1", "关键术语2", ...]
        }
        
        注意：
        1. summary必选，应简洁清晰，不超过500字
        2. keyTerms可选，1~10个文中最重要的术语或概念(保留文中原始语言和格式，不翻译)
        3. 所有输出必须严格遵循JSON格式，不要添加额外的文本
    `;
    
    // 构建请求内容
    const contents = [
        {
            role: 'model',
            parts: [{ text: systemPrompt }]
        },
        {
            role: 'user',
            parts: [{ text: '请分析这篇文章的内容并提取关键信息' }]
        }
    ];
    
    // 预设的回退响应
    const fallbackResponse = {
        summary: pageSummaryFallback,
        keyTerms: []
    };
    
    // 调用通用API函数
    return await callGeminiAPI(contents, '全文分析', true, fallbackResponse);
}
    
// analyzeFullContent|analyzeContent -> 显示LLM全文分析结果
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
    } else if (!analysisResult.summary && (!analysisResult.keyTerms || analysisResult.keyTerms.length === 0)) {
        console.error('分析结果不完整:', analysisResult);
    }
    
    // 使用默认值，如果没有提供分析结果
    const summary = analysisResult?.summary || "这是一篇关于深度学习模型的文章，讨论了模型解释性的重要性、现有技术和未来发展方向。";
    
    // 显示分析结果
    const deepreadContent = document.getElementById('deepread-content');
    if (deepreadContent) {
        // 准备关键术语列表HTML
        let keyTermsHtml = '';
        if (analysisResult?.keyTerms && analysisResult.keyTerms.length > 0) {
            keyTermsHtml = `
                <div class="deepread-key-terms">
                    <h4>关键术语</h4>
                    <ul>
                        ${analysisResult.keyTerms.map(term => 
                            `<li><a href="#" class="deepread-concept" data-concept="${term}">${term}</a></li>`
                        ).join('')}
                    </ul>
                </div>
            `;
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
                    explanation: `我已完成阅读。${summary}`,
                    relatedConcepts: analysisResult?.keyTerms || [],
                    relatedParagraphs: []
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
                <p>我已完成阅读。</p>
                <p class="deepread-concept-explanation-summary">${summary}</p>
                ${keyTermsHtml}
                <p>请浏览文章，选择任意文本并点击出现的DR按钮，我将提供更深入的解读和相关段落导航。</p>
                <div id="deepread-concept-explanation-info"></div>
            </div>
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
            addChatMessage('您好！我是DeepRead助手。您可以向我提问有关本页面内容的问题，我将尽力为您解答。', 'assistant');
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
        
        // 注意：重新分析按钮已移至文本编辑区域
        
        // 开始处理页面内容，识别关键概念
        identifyKeyConcepts(analysisResult?.keyTerms);
    }
}

// showAnalysisResults -> identifyKeyConcepts
// 识别页面中的关键概念，并添加交互功能，使用户可以点击获取更详细的解释
function identifyKeyConcepts(llmKeyTerms) {
    // 使用LLM返回的关键术语，如果没有则使用预设值
    const keyTerms = llmKeyTerms || [
        '模型解释性', '深度学习', '黑盒', '决策透明度', '特征重要性',
        '注意力机制', '局部解释', '模型诊断', '人机协作'
    ];

    // 查找页面中的段落
    const paragraphs = document.querySelectorAll('p');
    
    // 为每个段落添加ID（如果没有）
    // paragraphs.forEach((p, index) => {
    //     if (!p.id) {
    //         p.id = `paragraph-${index}`;
    //     }
    // });

    // 遍历段落，查找关键术语
    paragraphs.forEach(p => {
        keyTerms.forEach(term => {
            // 简单的文本替换，实际应用中需要更复杂的NLP
            const regex = new RegExp(`\\b${term}\\b`, 'g');
            p.innerHTML = p.innerHTML.replace(regex, 
                `<span class="deepread-concept" data-concept="${term}">${term}</span>`);
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

// 划词 打开阅读助手并跳转到解释指定概念 - 已合并到explainConcept函数
async function openDeepReadWithConcept(conceptName) {
    // 直接调用explainConcept函数，传入null作为element参数
    await explainConcept(conceptName, null);
}

/**
 * 解释概念
 * @param {string} conceptName 概念名称
 * @param {HTMLElement} element 概念所在的HTML元素
 */
async function explainConcept(conceptName, element) {
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
                debugLog(`当前概念已存在于缓存中，索引为: ${currentConceptIndex}`);
                
                // 即使使用缓存，也要确保元素的高亮状态被正确处理
                if (element) {
                    // 移除所有已有的高亮样式
                    document.querySelectorAll('.deepread-concept-active').forEach(el => {
                        el.classList.remove('deepread-concept-active');
                    });
                    // 添加新的高亮样式
                    element.classList.add('deepread-concept-active');
                }
            } else {
                // 如果不存在，调用LLM API获取概念解释
                debugLog(`概念"${displayName}"不在缓存中，调用LLM获取解释`);
                const conceptInfo = await getConceptExplanation(conceptName, pageContent);
                // 如果调用失败，显示错误
                if (!conceptInfo) {
                    console.error('获取概念解释失败:', conceptName);
                    explanationDiv.innerHTML = `<div class="deepread-error">获取"${displayName}"的解释失败。请稍后再试。</div>`;
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
                    timestamp: Date.now()
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
            // 出错时显示错误信息
            const explanationDiv = document.getElementById('deepread-concept-explanation-info');
            if (explanationDiv) {
                explanationDiv.innerHTML = `<div class="deepread-error">获取"${displayName}"的解释时出错。请稍后再试。</div>`;
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
async function getConceptExplanation(conceptName, pageContent = '') {
    // 系统提示词
    const systemPrompt = `
        我是一个专业的深度阅读助手DeepRead，帮助用户进行网页浏览和理解。
        用户选择了一段文本，我会结合页面内容给出适合语境的中文解释以及相关概念。
        对于普通页面，我会给出解释和相关概念和段落（方便用户点击并跳转以进一步浏览）。
        对于视频页，我会基于视频字幕脚本给出解释，但不提供相关概念和段落（视频页无需跳转）。
        如果页面缺失原始段落编号，我会给出解释和相关概念，但不提供相关段落。

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
            role: 'model',
            parts: [{ text: systemPrompt }]
        }
    ];
    
    // 添加用户消息
    contents.push({
        role: 'user',
        parts: [{ text: `请解释"${conceptName}"这个概念` }]
    });

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
        relatedParagraphsHtml = `<div class="deepread-related-paragraphs"><p><strong>文章中的相关段落：</strong></p>`;
        
        llmResponse.relatedParagraphs.forEach(paragraphInfo => {
            // 检查是否是新格式（对象包含id和reason）
            const paragraphId = typeof paragraphInfo === 'object' ? paragraphInfo.id : paragraphInfo;
            const reason = typeof paragraphInfo === 'object' ? paragraphInfo.reason : '';
            
            const paragraph = document.getElementById(paragraphId);
            if (paragraph) {
                relatedParagraphsHtml += `
                    <div class="deepread-related-content" data-target="${paragraphId}">
                        ${reason ? `<p class="deepread-paragraph-reason"><strong>相关原因：</strong> ${reason}</p>` : ''}
                        <button class="deepread-navigate-btn">跳转到此</button>
                        <button class="deepread-navigate-btn deepread-explain-btn">解释此段</button>
                        <p>${paragraph.textContent.length > 120 ? paragraph.textContent.substring(0, 120) + '...' : paragraph.textContent}</p>
                    </div>
                `;
            }
        });
        relatedParagraphsHtml += '</div>';
    }
    
    // 更新解释区内容，保留对话区
    if (chatSection) {
        // 如果已经有对话区，只更新解释部分
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
                <p class="deepread-concept-explanation-summary">${llmResponse.explanation}</p>
                ${relatedConceptsHtml}
                ${relatedParagraphsHtml}
            `;
        } else {
            // 如果没有解释区，在对话区前插入
            const explanationSection = document.createElement('div');
            explanationSection.className = 'deepread-explanation-section';
            explanationSection.innerHTML = `
                <h3 data-concept-key="${conceptKey}">${displayName}</h3>
                <p>${llmResponse.explanation}</p>
                ${relatedConceptsHtml}
                ${relatedParagraphsHtml}
            `;
            content.insertBefore(explanationSection, chatSection);
        }
    } else {
        // 如果没有对话区，创建完整的内容
        content.innerHTML = `
            <div class="deepread-explanation-section">
                <h3 data-concept-key="${conceptKey}">${displayName}</h3>
                <p>${llmResponse.explanation}</p>
                ${relatedConceptsHtml}
                ${relatedParagraphsHtml}
            </div>
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
            addChatMessage('您好！我是DeepRead助手。您可以向我提问有关本页面内容的问题，我将尽力为您解答。', 'assistant');
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
    
    // 为相关段落添加跳转按钮事件
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

// 聊天对话
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
        const responseText = await getChatResponse(message, chatHistory, pageContent, selectedImages);
        const response = processChatResponse(responseText);
        addChatMessage(response, 'assistant');
        
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
        addChatMessage('抱歉，处理您的消息时出现了问题。', 'assistant');
    }
}

/**
 * 调用 LLM API 聊天对话
 * @param userMessage 用户消息
 * @param chatHistory 聊天历史
 * @param pageContent 页面内容摘要
 * @returns 聊天回答
 */
async function getChatResponse(userMessage, chatHistory = [], pageContent = '', images = []) {
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
    let systemPrompt = `
        我是一个专业的深度阅读助手DeepRead，帮助用户进行网页浏览和理解。
        我和用户可能会围绕当前页面对话，也可能穿插讨论多个不同的页面。
        我将主要参考当前的页面的内容和对话历史，辅以参考记忆，和用户对话。
        （记忆是基于之前的各种页面的对话历史记录，通过外部工具总结并存取。
        用向量对比提取topK，因此记忆不一定准确，甚至可能与当前话题无关，我会有选择的参考记忆）
        我的语言风格将与用户相仿。
        
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
    //     return await callGeminiDrawAPI(contents, '绘画聊天', false, chatResponseFallback);
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
    if (images && images.length > 0) {
        // 有图片，调用多模态API
        debugLog('对话总字符数：' + totalChars + "调用多模态API (callGeminiAPI)");
        return await callGeminiAPI(contents, '多模态聊天', false, chatResponseFallback);
    } else {
        // 没有图片，调用常规文本API
        debugLog('对话总字符数：' + totalChars + "调用文本API (callGeminiAPI)");
        return await callGeminiAPI(contents, '聊天', false, chatResponseFallback);
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

// 导航到上一个或下一个概念
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

// 添加聊天消息到对话历史
function addChatMessage(message, role, isLoading = false, addToHistory = true, images = []) {
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
    messageContent = message;
    
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
 * 复制消息到剪贴板
 * @param {string} message 要复制的消息
 * @param {string} role 消息角色（user或assistant）
 */
function copyMessageToClipboard(message, role) {
    try {
        // 如果是助手消息且包含HTML标签，则提取纯文本
        let textToCopy = message;
        if (role === 'assistant' && /<[a-z][\s\S]*>/i.test(message)) {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = message;
            textToCopy = tempDiv.textContent || tempDiv.innerText || message;
        }
        
        // 复制到剪贴板
        navigator.clipboard.writeText(textToCopy)
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

// 将当前概念解释插入到聊天区域
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
                addChatMessage('您好！我是DeepRead助手。您可以向我提问有关本页面内容的问题，我将尽力为您解答。', 'assistant', false, false);
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

// 调试输出函数
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
    let savedModel = 'gemini-2.5-flash-lite-preview-06-17'; // 默认值
    
    // 使用Chrome存储API获取设置
    if (isExtensionEnvironment && chrome.storage) {
        chrome.storage.sync.get(['deepread_api_key', 'deepread_model'], function(result) {
            if (result.deepread_api_key) {
                document.getElementById('deepread-api-key').value = result.deepread_api_key;
            }
            if (result.deepread_model) {
                document.getElementById('deepread-model').value = result.deepread_model;
            } else {
                // 如果没有保存的MODEL，使用默认值
                document.getElementById('deepread-model').value = savedModel;
            }
        });
    }
    
    // 添加API Key设置和缓存管理
    // <input type="text" id="deepread-model" class="deepread-settings-input" 
                //        value="${savedModel}" placeholder="可选，请配置MODEL...">
    content.innerHTML = `
        <div class="deepread-settings-section">
            <h3 id="deepread-settings-title-api">API 设置</h3>
            <div class="deepread-settings-item">
                <a href="https://aistudio.google.com/apikey">Google Gemini API Key</a>
                <input type="text" id="deepread-api-key" class="deepread-settings-input" 
                       value="${savedApiKey}" placeholder="输入您的API Key...">
                
            </div>
            <button id="deepread-save-settings" class="deepread-btn">保存设置</button>
        </div>
        <div class="deepread-settings-section">
            <h3 id="deepread-settings-title-cache">缓存管理</h3>
            <div class="deepread-settings-item">
                <p id="deepread-settings-cache-desc">DeepRead会保存您的聊天历史和概念查询记录，以便您下次打开时继续使用。</p>
            </div>
            <button id="deepread-clear-cache" class="deepread-btn deepread-btn-danger">清除所有缓存</button>
        </div>
    `;
    
    // 组装面板
    settingsContainer.appendChild(header);
    settingsContainer.appendChild(content);
    
    // 添加到页面
    document.body.appendChild(settingsContainer);
    
    // 添加保存按钮事件
    document.getElementById('deepread-save-settings').addEventListener('click', saveSettings);
    
    // 添加清除缓存按钮事件
    document.getElementById('deepread-clear-cache').addEventListener('click', function() {
        if (confirm('确定要清除所有缓存吗？这将删除所有聊天历史和概念查询记录。')) {
            clearAllCache();
        }
    });
}

// 保存设置
function saveSettings() {
    const apiKey = document.getElementById('deepread-api-key').value.trim();
    // const modelId = document.getElementById('deepread-model').value.trim();
    
    // 保存API Key和MODEL到Chrome存储
    if (isExtensionEnvironment && chrome.storage) {
        chrome.storage.sync.set({
            deepread_api_key: apiKey,
            // deepread_model: modelId
        }, function() {
            debugLog('API Key和MODEL已保存到Chrome存储');
        });
    } else {
        // 如果不是在扩展环境中，使用localStorage作为后备
        localStorage.setItem('deepread_api_key', apiKey);
        // localStorage.setItem('deepread_model', modelId);
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
    // 保存设置后，刷新页面
    location.reload();
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
                        analyzeBtn.addEventListener('click', analyzeFullContent);
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

// 生成唯一ID
let messageCounter = 0;
function generateUniqueId() {
    return 'msg-' + Date.now() + '-' + (messageCounter++);
}