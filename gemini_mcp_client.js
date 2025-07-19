// gemini_mcp_client.js

// 是否启用MCP功能的开关
const enableMCP = true; // 设置为false可以禁用所有MCP相关功能

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
    
    if (!enableMCP) {
        debugLog('MCP功能已禁用，跳过记忆保存');
        return { success: false, reason: 'MCP功能已禁用' };
    }
    
    try {
        // 如果数据为空或默认提示语，则不保存
        if (!data || data == "正在思考..." || data === "您好！我是DeepRead助手。您可以向我提问有关本页面内容的问题，我将尽力为您解答。") {
            debugLog('跳过记忆保存');
            return { success: false, reason: '跳过' };
        }
        
        // 获取当前页面URL和标题
        const currentUrl = window.location.href;
        const pageTitle = document.title || '未知页面';
        
        // 准备请求数据
        let mcpData, userCommand, messageContent;
        if (type === 'chat_session') {
            // 处理聊天历史数组
            const chatHistory = Array.isArray(data) ? data : [data];
            if (chatHistory.length === 0) {
                console.log('没有聊天历史需要保存');
                return { success: false, reason: '没有聊天历史' };
            }
            
            // 准备聊天历史数据
            const chatHistoryForMCP = chatHistory.map(msg => ({
                role: msg.role,
                content: msg.message || msg.content || ''
            }));
            
            console.log(`正在保存${chatHistoryForMCP.length}条聊天历史到MCP...`);
            userCommand = "保存这些聊天记录到记忆库";
            mcpData = {
                messages: chatHistoryForMCP,
                source: currentUrl,
                title: pageTitle,
                agent_id: agentId,
                user_id: userId
            };
        } else if (type === 'single_message') {
            // 处理单条消息
            messageContent = typeof data === 'string' ? data : 
                               (data.message || data.content || JSON.stringify(data));
            
            console.log(`正在保存单条记忆到MCP...`);
            userCommand = "保存这条信息到记忆库 ";
            console.log("options --->", options);
            mcpData = {
                role: options.role,
                content: messageContent,
                source: currentUrl,
                title: pageTitle,
                agent_id: agentId,
                user_id: userId
            };
        } else {
            // 未知类型，不处理
            console.error('未知类型，不处理');
            return { success: false, reason: '未知类型' };
        }
        
        // 发送请求
        const response = await fetch(api_url + '/mcp_service', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                userCommand: userCommand,
                chatHistory: [{
                    role: options.role,
                    content: messageContent // "请保存这条记忆"
                }],
                pageContent: "",
                mcpAction: "add_mem",
                mcpData: mcpData
            })
        });
        
        if (response.ok) {
            const text = await response.text();
            debugLog('MCP保存记忆结果:' + text);
            let result;
            try {
                result = JSON.parse(text);
                return { success: true, result };
            } catch (e) {
                console.error('MCP响应不是有效的JSON:', e);
                return { success: false, error: e, rawResponse: text };
            }
        } else {
            console.error('MCP保存记忆失败:', response.statusText);
            return { success: false, error: response.statusText };
        }
    } catch (error) {
        console.error('调用MCP保存记忆时出错:', error);
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
    if (!enableMCP) {
        console.log('MCP功能已禁用，跳过记忆搜索');
        return [];
    }
    
    try {
        debugLog(`正在搜索与"${query}"相关的记忆...`);
        
        const response = await fetch(api_url + '/mcp_service', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                userCommand: "搜索与这个问题相关的记忆",
                chatHistory: [{
                    role: "user",
                    content: query
                }],
                pageContent: pageContent,
                mcpAction: "search_mem",
                mcpData: {
                    query: query,
                    user_id: userId
                }
            })
        });
        
        if (!response.ok) {
            throw new Error(`搜索记忆失败: ${response.statusText}`);
        }
        
        const result = await response.json();
        
        if (result.error) {
            console.error("搜索记忆时出错:", result.error);
            return [];
        }
        
        if (result.memories && Array.isArray(result.memories)) {
            debugLog(`找到${result.memories.length}条相关记忆`);
            return result.memories;
        } else {
            debugLog('未找到相关记忆或返回格式不正确');
            return [];
        }
    } catch (error) {
        console.error('搜索记忆时出错:', error);
        return [];
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