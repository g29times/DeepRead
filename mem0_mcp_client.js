// gemini_mcp_client.js

// 是否启用 mem0 记忆功能的开关（可被 chrome.storage.sync 覆盖）
const enableMCP = true; // 历史字段名保留：true=启用 mem0，false=禁用

const MEM0_API_BASE_V1 = 'https://api.mem0.ai/v1';
const MEM0_API_BASE_V2 = 'https://api.mem0.ai/v2';

const MEM0_ENABLED_KEY = 'deepread_mem0_enabled';
const MEM0_API_KEY_KEY = 'deepread_mem0_api_key';
const MEM0_USER_ID_KEY = 'deepread_mem0_user_id';
const MEM0_AGENT_ID_KEY = 'deepread_mem0_agent_id';

const MEM0_DEFAULT_API_KEY = 'm0-TJ4QvA1uHUXIHEbxbjRXL3kpSb7nw9ZUzElsiZXV';
const MEM0_DEFAULT_USER_ID = 'neo';
const MEM0_DEFAULT_AGENT_ID = 'deepread';

const MEM0_QUERY_TIMEOUT_MS = 3000;

// 兼容旧代码：历史上这里走本地 MCP 服务（已不再使用）。
// 仅用于避免未使用函数引用时出现 ReferenceError。
const api_url = "http://localhost:8009/api";

/**
 * 保存信息到MCP记忆系统
 * @param {Object|string|Array} data - 要保存的数据（单条消息或聊天历史数组）
 * @param {Object} options - 选项
 * @param {string} options.type - 数据类型，'message'或'chat_history'
 * @param {string} options.agentId - 代理ID
 * @param {string} options.userId - 用户ID
 * @returns {Promise<Object>} - 保存结果
 */
async function addMemory(data, options = {}) {
    // 设置默认值
    const {
        type = 'single_message', // single_message 单条消息 chat_session 多轮聊天对话
        agentId = 'gemini',
        userId = 'neo',
        role = 'user'
    } = options;
    
    const settings = await getMem0Settings();
    if (!settings.enabled) {
        debugLog('mem0功能已禁用，跳过记忆保存');
        return { success: false, reason: 'mem0功能已禁用' };
    }
    
    try {
        // 如果数据为空或默认提示语，则不保存
        if (!data || data == "正在思考..." || data === "您好！我是DeepRead助手。您可以向我提问有关本页面内容的问题，我将尽力为您解答。") {
            debugLog('跳过记忆保存');
            return { success: false, reason: '跳过' };
        }
        
        let messages = [];
        const normalizedType = (type === 'chat_history') ? 'chat_session' : type;
        if (normalizedType === 'chat_session') {
            const chatHistory = Array.isArray(data) ? data : [data];
            if (chatHistory.length === 0) {
                debugLog('没有聊天历史需要保存');
                return { success: false, reason: '没有聊天历史' };
            }
            messages = chatHistory
                .map((msg) => ({
                    role: msg && msg.role ? String(msg.role) : 'user',
                    content: String(msg && (msg.message || msg.content || msg.rawMessage || '') ? (msg.message || msg.content || msg.rawMessage) : '').trim(),
                }))
                .filter((m) => m.content);
        } else if (normalizedType === 'single_message') {
            const messageContent = typeof data === 'string'
                ? data
                : (data && (data.message || data.content || data.rawMessage))
                    ? (data.message || data.content || data.rawMessage)
                    : JSON.stringify(data);

            const roleRaw = options && options.role ? String(options.role) : role;
            messages = [{
                role: roleRaw,
                content: String(messageContent || '').trim(),
            }].filter((m) => m.content);
        } else {
            console.error('未知类型，不处理');
            return { success: false, reason: '未知类型' };
        }

        if (!messages.length) {
            debugLog('没有可写入的消息内容，跳过记忆保存');
            return { success: false, reason: 'empty messages' };
        }

        const scopeRole = (options && options.role) ? String(options.role) : String(role || '');
        const isAssistant = scopeRole === 'assistant' || scopeRole === 'model';
        const payload = {
            messages,
            version: 'v2'
        };
        // 区分实体：
        // - user 消息写到 user_id（个人记忆）
        // - assistant 消息写到 agent_id（助手/agent 记忆）
        if (isAssistant) {
            payload.agent_id = settings.agentId || agentId || MEM0_DEFAULT_AGENT_ID;
        } else {
            payload.user_id = settings.userId || userId || MEM0_DEFAULT_USER_ID;
        }

        const response = await fetch(`${MEM0_API_BASE_V1}/memories/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Token ${settings.apiKey}`,
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const text = await safeReadResponseText(response);
            console.error('mem0保存记忆失败:', response.status, response.statusText, text);
            return { success: false, error: response.statusText, status: response.status, detail: text };
        }

        const result = await safeReadResponseJson(response);
        return { success: true, result };
    } catch (error) {
        console.error('调用mem0保存记忆时出错:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 保存聊天历史到MCP (兼容旧接口)
 * @param {Array} chatHistory - 聊天历史数组
 * @param {string} userId - 用户ID
 * @returns {Promise<Object>} - 保存结果
 */
async function saveChatHistoryToMCP(chatHistory, userId = "neo") {
    return addMemory(chatHistory, {
        type: 'chat_history',
        userId: userId,
        agentId: "gemini"
    });
}

/**
 * 搜索与查询相关的记忆
 * @param {string} query - 用户的查询
 * @param {string} userId - 用户ID
 * @returns {Promise<Array>} - 返回相关记忆数组
 */
async function searchMemories(query, pageContent, userId = "neo") {
    const settings = await getMem0Settings();
    if (!settings.enabled) {
        console.log('mem0功能已禁用，跳过记忆搜索');
        return [];
    }
    
    try {
        debugLog(`正在搜索与"${query}"相关的记忆...`);

        const finalUserId = settings.userId || userId || MEM0_DEFAULT_USER_ID;
        const configuredAgentId = settings.agentId || MEM0_DEFAULT_AGENT_ID;
        // 跨项目共享 agent 记忆：deepread + jiji 都纳入检索范围（去重）
        const agentIds = Array.from(new Set([
            configuredAgentId,
            'deepread',
            'jiji',
        ].map((s) => String(s || '').trim()).filter(Boolean)));

        const filters = {
            OR: [
                { user_id: finalUserId },
                { agent_id: { in: agentIds } },
            ]
        };

        const payload = {
            query: String(query || ''),
            filters,
        };

        const response = await withTimeout(fetch(`${MEM0_API_BASE_V2}/memories/search/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Token ${settings.apiKey}`,
            },
            body: JSON.stringify(payload),
        }), MEM0_QUERY_TIMEOUT_MS);

        if (!response) {
            // 超时：不影响主流程
            debugLog('mem0搜索超时，跳过记忆注入');
            return [];
        }

        if (!response.ok) {
            const text = await safeReadResponseText(response);
            console.error('mem0搜索记忆失败:', response.status, response.statusText, text);
            return [];
        }

        const result = await safeReadResponseJson(response);
        // mem0 可能返回两种格式：
        // 1) { results: [...] }
        // 2) [ ... ]
        const rows = Array.isArray(result)
            ? result
            : (result && Array.isArray(result.results))
                ? result.results
                : [];

        const memories = rows
            .map((r) => {
                if (!r) return '';
                if (typeof r === 'string') return r;
                // 常见字段：memory
                if (r.memory) return String(r.memory);
                // 兼容少见字段
                if (r.content) return String(r.content);
                if (r.text) return String(r.text);
                return '';
            })
            .map((s) => String(s || '').trim())
            .filter(Boolean);

        debugLog(`找到${memories.length}条相关记忆`);
        return memories;
    } catch (error) {
        console.error('搜索记忆时出错:', error);
        return [];
    }
}

async function getMem0Settings() {
    const fallback = {
        enabled: !!enableMCP,
        apiKey: MEM0_DEFAULT_API_KEY,
        userId: MEM0_DEFAULT_USER_ID,
        agentId: MEM0_DEFAULT_AGENT_ID,
    };

    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
            const obj = await new Promise((resolve) => {
                try {
                    chrome.storage.sync.get([
                        MEM0_ENABLED_KEY,
                        MEM0_API_KEY_KEY,
                        MEM0_USER_ID_KEY,
                        MEM0_AGENT_ID_KEY,
                    ], (result) => resolve(result || {}));
                } catch (e) {
                    resolve({});
                }
            });

            const enabledRaw = obj && Object.prototype.hasOwnProperty.call(obj, MEM0_ENABLED_KEY) ? obj[MEM0_ENABLED_KEY] : undefined;
            const enabled = (enabledRaw === undefined || enabledRaw === null) ? fallback.enabled : !!enabledRaw;

            const apiKey = (obj && obj[MEM0_API_KEY_KEY] ? String(obj[MEM0_API_KEY_KEY]).trim() : '') || fallback.apiKey;
            const userId = (obj && obj[MEM0_USER_ID_KEY] ? String(obj[MEM0_USER_ID_KEY]).trim() : '') || fallback.userId;
            const agentId = (obj && obj[MEM0_AGENT_ID_KEY] ? String(obj[MEM0_AGENT_ID_KEY]).trim() : '') || fallback.agentId;

            return { enabled, apiKey, userId, agentId };
        }
    } catch (e) {
        // ignore
    }

    return fallback;
}

async function withTimeout(promise, timeoutMs) {
    const ms = Math.max(0, Number(timeoutMs) || 0);
    if (!ms) return await promise;
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(null), ms);
            })
        ]);
    } finally {
        if (timer) {
            try { clearTimeout(timer); } catch (e) { /* no-op */ }
        }
    }
}

async function safeReadResponseText(resp) {
    try {
        return await resp.text();
    } catch (e) {
        return '';
    }
}

async function safeReadResponseJson(resp) {
    try {
        const text = await resp.text();
        if (!text) return null;
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

// 未使用
async function sendMessageToGemini(userCommand, chatHistory = [], pageContent = "") {
    try {
        const response = await fetch(api_url + '/mcp_service', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                userCommand,
                chatHistory,
                pageContent
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.error) {
            console.error("Error from server:", data.error);
            return { error: data.error };
        }
        
        return { text: data.text };
    } catch (error) {
        console.error("Failed to send message:", error);
        return { error: error.message };
    }
}

// 使用示例
async function example() {
    const chatHistory = [
        { role: "user", content: "你好，我是Neo" },
        { role: "assistant", content: "你好Neo，有什么我可以帮助你的吗？" }
    ];
    
    const result = await sendMessageToGemini(
        "我需要添加一个任务：明天去超市买蔬菜", 
        chatHistory,
        "当前页面是待办事项管理页面"
    );
    
    console.log(result.text);
}