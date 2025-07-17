// DeepRead 缓存管理模块
// 负责处理聊天历史、概念查询和页面内容的缓存

// 缓存键名
const CACHE_KEYS = {
    PAGE_CONTENT: 'deepread_page_content', // 全文分析缓存
    CONCEPT_HISTORY: 'deepread_concept_history', // 概念解析缓存
    CHAT_HISTORY: 'deepread_chat_history', // 对话缓存
    CURRENT_CONCEPT_INDEX: 'deepread_current_concept_index',
    PAGE_ANALYZED_STATUS: 'deepread_page_analyzed_status', // 页面分析状态缓存
    URL_INDEX: 'deepread_url_index' // URL索引缓存
};

/**
 * 规范化URL，去除片段标识符和查询参数
 * @param {string} url 原始URL
 * @returns {string} 规范化后的URL
 */
function normalizeUrl(url) {
    if (!url) return '';
    
    try {
        // 创建URL对象
        const urlObj = new URL(url);
        
        // 清除片段标识符（#后面的部分）
        urlObj.hash = '';
        
        // 对于某些特定的网站，我们可能还需要清除特定的查询参数
        // 例如，微信公众号文章的URL可能包含一些不影响内容的参数
        if (urlObj.hostname.includes('mp.weixin.qq.com')) {
            // 微信公众号文章只保留文章ID（s参数）
            const articleId = urlObj.searchParams.get('s') || urlObj.searchParams.get('__biz');
            urlObj.search = articleId ? `?s=${articleId}` : '';
        } else {
            // 对于其他网站，可以根据需要决定是否清除查询参数
            // 这里我们选择保留查询参数，因为在大多数情况下，查询参数可能会影响页面内容
            // urlObj.search = '';
        }
        
        // 返回规范化后的URL字符串
        return urlObj.toString();
    } catch (error) {
        console.error('规范化URL失败:', error, url);
        return url; // 如果出错，返回原始URL
    }
}

/**
 * 生成基于URL的缓存键名
 * @param {string} baseKey 基础键名
 * @param {string} url URL
 * @returns {string} 基于URL的缓存键名
 */
function getUrlBasedKey(baseKey, url) {
    // 如果提供URL，则使用URL作为键名的一部分
    if (url) {
        // 先规范化URL
        const normalizedUrl = normalizeUrl(url);
        // console.log('原始URL:', url);
        // console.log('规范化后URL:', normalizedUrl);
        
        // 使用规范化后URL的哈希值作为键名的一部分
        const urlHash = hashString(normalizedUrl);
        return `${baseKey}_${urlHash}`;
    }
    console.log('没有URL，返回baseKey');
    return baseKey;
}

// 简单的字符串哈希函数
function hashString(str) {
    let hash = 0;
    if (str.length === 0) return hash;
    
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    
    return Math.abs(hash).toString(16); // 转换为16进制字符串
}

/**
 * 缓存聊天历史
 * @param {Array} chatHistory 聊天历史数组
 */
async function saveChatHistory(chatHistory) {
    try {
        await chrome.storage.local.set({ [CACHE_KEYS.CHAT_HISTORY]: chatHistory });
        console.log('聊天历史已缓存', chatHistory.length);
    } catch (error) {
        console.error('缓存聊天历史失败:', error);
    }
}

/**
 * 从缓存加载聊天历史
 * @returns {Promise<Array>} 聊天历史数组
 */
async function loadChatHistory() {
    try {
        const result = await chrome.storage.local.get([CACHE_KEYS.CHAT_HISTORY]);
        const chatHistory = result[CACHE_KEYS.CHAT_HISTORY] || [];
        console.log('从缓存加载聊天历史', chatHistory.length);
        return chatHistory;
    } catch (error) {
        console.error('加载聊天历史失败:', error);
        return [];
    }
}

/**
 * 缓存概念查询历史
 * @param {Array} conceptHistory 概念查询历史数组
 */
async function saveConceptHistory(conceptHistory) {
    try {
        await chrome.storage.local.set({ 
            [CACHE_KEYS.CONCEPT_HISTORY]: conceptHistory,
            [CACHE_KEYS.CURRENT_CONCEPT_INDEX]: conceptHistory.length - 1
        });
        console.log('概念查询历史已缓存', conceptHistory.length);
    } catch (error) {
        console.error('缓存概念查询历史失败:', error);
    }
}

/**
 * 从缓存加载概念查询历史
 * @returns {Promise<Array>} 概念查询历史数组
 */
async function loadConceptHistory() {
    try {
        const result = await chrome.storage.local.get([CACHE_KEYS.CONCEPT_HISTORY]);
        const conceptHistory = result[CACHE_KEYS.CONCEPT_HISTORY] || [];
        console.log('从缓存加载概念查询历史', conceptHistory.length);
        return conceptHistory;
    } catch (error) {
        console.error('加载概念查询历史失败:', error);
        return [];
    }
}

/**
 * 获取当前概念索引
 * @returns {Promise<number>} 当前概念索引
 */
async function getCurrentConceptIndex() {
    try {
        const result = await chrome.storage.local.get([CACHE_KEYS.CURRENT_CONCEPT_INDEX]);
        return result[CACHE_KEYS.CURRENT_CONCEPT_INDEX] || -1;
    } catch (error) {
        console.error('获取当前概念索引失败:', error);
        return -1;
    }
}

/**
 * 设置当前概念索引
 * @param {number} index 当前概念索引
 */
async function setCurrentConceptIndex(index) {
    try {
        await chrome.storage.local.set({ [CACHE_KEYS.CURRENT_CONCEPT_INDEX]: index });
    } catch (error) {
        console.error('设置当前概念索引失败:', error);
    }
}

/**
 * 从概念历史中删除指定索引的概念
 * @param {number} index 要删除的概念索引
 * @returns {Promise<{success: boolean, newIndex: number, message: string}>} 删除结果
 */
async function deleteConceptByIndex(index) {
    try {
        // 加载当前概念历史
        const conceptHistory = await loadConceptHistory();
        const currentIndex = await getCurrentConceptIndex();
        
        // 检查索引是否有效
        if (index < 0 || index >= conceptHistory.length) {
            return {
                success: false,
                newIndex: currentIndex,
                message: '无效的概念索引'
            };
        }
        
        // 删除指定概念
        const deletedConcept = conceptHistory.splice(index, 1)[0];
        
        // 计算新的当前索引
        let newIndex = currentIndex;
        if (conceptHistory.length === 0) {
            // 如果删除后没有概念了
            newIndex = -1;
        } else if (index === currentIndex) {
            // 如果删除的是当前概念，则选择上一个概念
            newIndex = Math.max(0, index - 1);
        } else if (index < currentIndex) {
            // 如果删除的是当前概念之前的概念，则当前索引减1
            newIndex = currentIndex - 1;
        }
        
        // 缓存更新后的概念历史和当前索引
        await chrome.storage.local.set({
            [CACHE_KEYS.CONCEPT_HISTORY]: conceptHistory,
            [CACHE_KEYS.CURRENT_CONCEPT_INDEX]: newIndex
        });
        
        console.log(`成功删除概念: ${deletedConcept?.name || '未命名概念'}, 新的当前索引: ${newIndex}`);
        
        return {
            success: true,
            newIndex: newIndex,
            message: `成功删除概念: ${deletedConcept?.name || deletedConcept?.displayName || '未命名概念'}`
        };
    } catch (error) {
        console.error('删除概念失败:', error);
        return {
            success: false,
            newIndex: await getCurrentConceptIndex(),
            message: `删除概念失败: ${error.message}`
        };
    }
}

/**
 * 缓存页面内容到缓存
 * @param {Object} pageData 页面数据对象，包含URL、标题、内容和分析结果
 */
async function savePageContent(pageData) {
    try {
        if (!pageData || !pageData.url || !pageData.content || pageData.summary == pageSummaryFallback) {
            console.error('缓存页面内容失败');
            return;
        }
        
        // 使用基于URL的键名
        const urlBasedKey = getUrlBasedKey(CACHE_KEYS.PAGE_CONTENT, pageData.url);
        console.debug('savePageContent 调用 getUrlBasedKey 缓存页面内容: ', urlBasedKey);
        
        await chrome.storage.local.set({ [urlBasedKey]: pageData });
        
        // 同时在一个索引中缓存所有页面的URL，便于后续管理
        const urlIndex = await getUrlIndex();
        if (!urlIndex.includes(pageData.url)) {
            urlIndex.push(pageData.url);
            await chrome.storage.local.set({ [CACHE_KEYS.URL_INDEX]: urlIndex });
        }
        
        console.log('页面内容已缓存:', pageData.url);
    } catch (error) {
        console.error('缓存页面内容失败:', error);
    }
}

/**
 * 获取URL索引
 * @returns {Promise<Array>} URL列表
 */
async function getUrlIndex() {
    try {
        const result = await chrome.storage.local.get([CACHE_KEYS.URL_INDEX]);
        return result[CACHE_KEYS.URL_INDEX] || [];
    } catch (error) {
        console.error('获取URL索引失败:', error);
        return [];
    }
}

/**
 * 从缓存加载页面内容
 * @param {string} url 可选的URL参数，如果提供，则加载指定URL的页面内容
 * @returns {Promise<Object>} 页面数据对象
 */
async function loadPageContent(url) {
    try {
        // 如果没有提供URL，使用当前页面的URL
        const currentUrl = url || (window && window.location ? window.location.href : null);
        
        if (!currentUrl) {
            console.error('加载页面内容失败: 缺少URL');
            return null;
        }
        
        // 使用基于URL的键名
        const urlBasedKey = getUrlBasedKey(CACHE_KEYS.PAGE_CONTENT, currentUrl);
        console.debug('loadPageContent 调用 getUrlBasedKey 加载页面内容缓存: ', urlBasedKey);
        
        const result = await chrome.storage.local.get([urlBasedKey]);
        const pageData = result[urlBasedKey];
        
        if (pageData) {
            console.log('从缓存加载页面内容成功:', currentUrl);
        } else {
            console.log('没有找到页面缓存:', currentUrl);
        }
        
        return pageData || null;
    } catch (error) {
        console.error('加载页面内容失败:', error);
        return null;
    }
}

/**
 * 清除所有缓存
 * @returns {Promise<boolean>} 是否成功清除缓存
 */
async function clearAllCache() {
    try {
        // 获取所有缓存键
        const allKeys = await chrome.storage.local.get(null);
        console.log('清除前的缓存键:', Object.keys(allKeys));
        
        // 添加基本缓存键
        const keysToRemove = [
            CACHE_KEYS.CHAT_HISTORY,
            CACHE_KEYS.CONCEPT_HISTORY,
            CACHE_KEYS.CURRENT_CONCEPT_INDEX,
            CACHE_KEYS.URL_INDEX
        ];
        
        // 添加所有与页面内容和分析状态相关的缓存键
        for (const key in allKeys) {
            // 删除所有以PAGE_CONTENT开头的键
            if (key.startsWith(CACHE_KEYS.PAGE_CONTENT)) {
                keysToRemove.push(key);
                // console.log('添加页面内容缓存键到删除列表:', key);
            }
            
            // 删除所有以PAGE_ANALYZED_STATUS开头的键
            if (key.startsWith(CACHE_KEYS.PAGE_ANALYZED_STATUS)) {
                keysToRemove.push(key);
                // console.log('添加页面分析状态缓存键到删除列表:', key);
            }
        }
        
        // 清除所有缓存
        await chrome.storage.local.remove(keysToRemove);
        
        // 验证是否清除成功
        const remainingKeys = await chrome.storage.local.get(null);
        console.log('清除后的缓存键:', Object.keys(remainingKeys));
        
        return true;
    } catch (error) {
        console.error('清除缓存失败:', error);
        return false;
    }
}

/**
 * 缓存页面分析状态
 * @param {string} url 页面URL
 * @param {boolean} analyzed 是否已分析
 * @returns {Promise<void>}
 */
async function savePageAnalyzedStatus(url, analyzed) {
    try {
        if (!url) {
            console.error('缓存页面分析状态失败: 缺少URL');
            return;
        }
        
        // 使用规范化的URL
        const normalizedUrl = normalizeUrl(url);
        // 使用基于URL的键名
        const urlBasedKey = getUrlBasedKey(CACHE_KEYS.PAGE_ANALYZED_STATUS, normalizedUrl);
        console.debug('savePageAnalyzedStatus 调用 getUrlBasedKey 缓存页面分析状态', urlBasedKey);

        await chrome.storage.local.set({ [urlBasedKey]: analyzed });
        console.log('页面分析状态已缓存:', analyzed, normalizedUrl);
    } catch (error) {
        console.error('缓存页面分析状态失败:', error);
    }
}

/**
 * 加载页面分析状态
 * @param {string} url 页面URL
 * @returns {Promise<boolean>} 页面是否已分析
 */
async function loadPageAnalyzedStatus(url) {
    try {
        if (!url) {
            console.error('加载页面分析状态失败: 缺少URL');
            return false;
        }
        
        // 使用规范化的URL
        const normalizedUrl = normalizeUrl(url);
        // 使用基于URL的键名
        const urlBasedKey = getUrlBasedKey(CACHE_KEYS.PAGE_ANALYZED_STATUS, normalizedUrl);
        console.debug('loadPageAnalyzedStatus 调用 getUrlBasedKey 加载页面分析状态', urlBasedKey);
        
        const result = await chrome.storage.local.get([urlBasedKey]);
        const analyzed = result[urlBasedKey] || false;
        
        console.log('加载页面分析状态:', normalizedUrl, analyzed);
        return analyzed;
    } catch (error) {
        console.error('加载页面分析状态失败:', error);
        return false;
    }
}

// 导出缓存管理器函数
window.cacheManager = {
    getUrlBasedKey,
    hashString,
    saveChatHistory,
    loadChatHistory,
    saveConceptHistory,
    loadConceptHistory,
    getCurrentConceptIndex,  // 添加获取当前概念索引函数
    setCurrentConceptIndex,  // 添加设置当前概念索引函数
    deleteConceptByIndex,    // 添加删除指定索引概念函数
    savePageContent,
    loadPageContent,
    savePageAnalyzedStatus,  // 添加缓存页面分析状态函数
    loadPageAnalyzedStatus,  // 添加加载页面分析状态函数
    normalizeUrl,  // 导出规范化URL函数
    clearAllCache,  // 导出清除所有缓存函数
    CACHE_KEYS
};
