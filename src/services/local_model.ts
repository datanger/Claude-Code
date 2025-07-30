import crypto from 'crypto'
import type { AssistantMessage, UserMessage } from '../query.js'
import type { Tool } from '../Tool.js'
import { debugLog, logError } from '../utils/log.js'
import jwt from 'jsonwebtoken'

// 设置SSL验证跳过，必须在任何HTTPS请求之前设置
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

/**
 * 环境变量
 * LOCAL_MODEL_BASE 默认 https://192.168.10.173/sdw/chatbot/sysai/v1
 * LOCAL_MODEL_API_KEY 可选
 */
const LOCAL_MODEL_BASE = process.env.LOCAL_MODEL_BASE || 'https://192.168.10.173/sdw/chatbot/sysai/v1'
const LOCAL_MODEL_API_KEY = process.env.LOCAL_MODEL_API_KEY || ''

// 生成JWT token的函数
function generateJWTToken(): string {
  const payload = {
    appId: "agent",
    userId: "exampleUser",
    username: "Example Nickname",
    exp: Math.floor(Date.now() / 1000) + (3 * 24 * 60 * 60) // 3天后过期
  }
  const secretKey = '!@#DFwerw453n'
  return jwt.sign(payload, secretKey, { algorithm: 'HS256' })
}

interface LocalMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface LocalTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface LocalRequest {
  model: string
  messages: LocalMessage[]
  max_tokens?: number
  stream?: boolean
  temperature?: number
  top_p?: number
  presence_penalty?: number
  frequency_penalty?: number
  tools?: LocalTool[]
}

interface LocalStreamDelta {
  role?: string
  content?: string
  finish_reason?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    function: {
      name: string
      arguments: string
    }
  }>
}

interface LocalStreamChoice {
  index: number
  delta: LocalStreamDelta
  finish_reason: string | null
}

interface LocalStreamResponse {
  id: string
  object: string
  created: number
  model: string
  choices: LocalStreamChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

interface LocalResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      content?: string
      tool_calls?: Array<{
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
  error?: {
    message: string
    code: string
  }
}

/**
 * 将 UserMessage 转换为 LocalMessage - 参考 localAdapter.ts
 */
function userMessageToLocal(message: UserMessage): LocalMessage {
  if (typeof message.message.content === 'string') {
    return { role: 'user', content: message.message.content }
  }

  // 处理 content 数组 - 参考 localAdapter.ts 的 convertToDeepseekMessages
  const segments: string[] = []
  for (const part of message.message.content) {
    if (part.type === 'text') {
      segments.push(part.text)
    } else if ('functionCall' in part) {
      segments.push('[FunctionCall] ' + JSON.stringify(part.functionCall))
    } else if ('functionResponse' in part) {
      segments.push('[FunctionResponse] ' + JSON.stringify(part.functionResponse))
    }
  }
  
  const text = segments.join('\n')
  return { role: 'user', content: text }
}

/**
 * 将 AssistantMessage 转换为 LocalMessage - 参考 localAdapter.ts
 */
function assistantMessageToLocal(message: AssistantMessage): LocalMessage {
  if (message.message.content.length === 0) {
    return { role: 'assistant', content: '' }
  }
  
  // 处理 content 数组 - 参考 localAdapter.ts
  const segments: string[] = []
  for (const part of message.message.content) {
    if (part.type === 'text') {
      segments.push(part.text)
    } else if ('functionCall' in part) {
      segments.push('[FunctionCall] ' + JSON.stringify(part.functionCall))
    } else if ('functionResponse' in part) {
      segments.push('[FunctionResponse] ' + JSON.stringify(part.functionResponse))
    }
  }
  
  const text = segments.join('\n')
  return { role: 'assistant', content: text }
}

function toolsToLocal(tools: Tool[]): LocalTool[] {
  if (!tools || !Array.isArray(tools)) {
    return [];
  }

  return tools.map(tool => {
    // 获取工具的schema - 工具可能使用inputSchema而不是schema
    let schema = (tool as any).schema;
    if (!schema && (tool as any).inputSchema) {
      schema = (tool as any).inputSchema;
    }
    
    // 处理 Claude Code 格式的 Tool - 参考 localAdapter.ts
    const normalizedTool = {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: normalizeParameters(schema || {})
      }
    };
    
    debugLog(`🔧 [DEBUG] toolsToLocal - Converting tool: ${tool.name}`)
    debugLog(`🔧 [DEBUG] toolsToLocal - Tool schema:`, JSON.stringify(schema || {}, null, 2))
    
    return normalizedTool;
  });
}

/**
 * 标准化参数格式 - 参考 localAdapter.ts 的 normalizeParameters
 */
function normalizeParameters(parameters: unknown): Record<string, unknown> {
  if (!parameters) {
    return {};
  }

  // 如果是Zod schema对象，尝试提取其结构
  if (typeof parameters === 'object' && parameters !== null) {
    const zodObj = parameters as any;
    
    // 检查是否是Zod对象
    if (zodObj._def && zodObj._def.typeName === 'ZodObject') {
      debugLog(`🔧 [DEBUG] normalizeParameters - Detected Zod schema, converting to JSON Schema`)
      
      // 为Zod schema创建一个基本的JSON Schema结构
      return {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false
      };
    }
  }

  const normalizeType = (type: string): string => {
    const typeMap: Record<string, string> = {
      'STRING': 'string',
      'NUMBER': 'number',
      'BOOLEAN': 'boolean',
      'OBJECT': 'object',
      'ARRAY': 'array',
      'INTEGER': 'integer'
    };
    return typeMap[type] || type;
  };

  const normalizeSchema = (schema: unknown): Record<string, unknown> => {
    if (typeof schema !== 'object' || schema === null) {
      return {};
    }

    const normalized = { ...schema as Record<string, unknown> };

    if ('type' in normalized && typeof normalized.type === 'string') {
      normalized.type = normalizeType(normalized.type as string);
    }

    if ('items' in normalized) {
      normalized.items = normalizeSchema(normalized.items);
    }

    if ('properties' in normalized && normalized.properties && typeof normalized.properties === 'object') {
      const normalizedProperties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(normalized.properties as Record<string, unknown>)) {
        normalizedProperties[key] = normalizeSchema(value);
      }
      normalized.properties = normalizedProperties;
    }

    return normalized;
  };

  return normalizeSchema(parameters);
}

/**
 * 根据模型名称检测模型类型 - 参考 localAdapter.ts
 */
function detectModelType(modelName: string): string {
  const lowerModel = modelName.toLowerCase();
  
  // DeepSeek 模型检测
  if (lowerModel.includes('deepseek') || lowerModel.includes('coder')) {
    return 'deepseek-coder';
  }
  
  // OpenAI 兼容模型检测
  if (lowerModel.includes('gpt') || lowerModel.includes('openai')) {
    return 'gpt';
  }
  
  // Claude 模型检测
  if (lowerModel.includes('claude')) {
    return 'claude';
  }
  
  // Llama 模型检测
  if (lowerModel.includes('llama') || lowerModel.includes('llm')) {
    return 'llama';
  }
  
  // Qwen 模型检测
  if (lowerModel.includes('qwen')) {
    return 'qwen';
  }
  
  // ChatGLM 模型检测
  if (lowerModel.includes('chatglm') || lowerModel.includes('glm')) {
    return 'chatglm';
  }
  
  // 通用模型检测
  if (lowerModel.includes('chat') || lowerModel.includes('assistant')) {
    return 'chat';
  }
  
  // 默认返回模型名称
  return modelName;
}

/**
 * 根据模型类型调整请求参数 - 参考 localAdapter.ts
 */
function adjustRequestForModel(requestObj: any, modelType: string): void {
  debugLog(`🔧 [DEBUG] adjustRequestForModel - Model type: ${modelType}`)
  
  switch (modelType) {
    case 'deepseek-coder':
      // DeepSeek 特定配置
      requestObj.temperature = requestObj.temperature ?? 0.7;
      requestObj.top_p = requestObj.top_p ?? 0.95;
      break;
      
    case 'gpt':
      // OpenAI 兼容配置
      requestObj.temperature = requestObj.temperature ?? 0.7;
      requestObj.top_p = requestObj.top_p ?? 1;
      break;
      
    case 'claude':
      // Claude 配置
      requestObj.temperature = requestObj.temperature ?? 0.7;
      requestObj.top_p = requestObj.top_p ?? 0.9;
      break;
      
    case 'llama':
      // Llama 配置
      requestObj.temperature = requestObj.temperature ?? 0.8;
      requestObj.top_p = requestObj.top_p ?? 0.9;
      break;
      
    case 'qwen':
      // Qwen 配置
      requestObj.temperature = requestObj.temperature ?? 0.7;
      requestObj.top_p = requestObj.top_p ?? 0.9;
      break;
      
    case 'chatglm':
      // ChatGLM 配置
      requestObj.temperature = requestObj.temperature ?? 0.7;
      requestObj.top_p = requestObj.top_p ?? 0.9;
      break;
      
    default:
      // 通用配置
      requestObj.temperature = requestObj.temperature ?? 0.7;
      requestObj.top_p = requestObj.top_p ?? 0.9;
      break;
  }
  
  debugLog(`🔧 [DEBUG] adjustRequestForModel - Adjusted temperature: ${requestObj.temperature}`)
  debugLog(`🔧 [DEBUG] adjustRequestForModel - Adjusted top_p: ${requestObj.top_p}`)
}

/**
 * 构造 HTTP 请求并解析响应
 */
async function callLocalModel(request: LocalRequest, signal: AbortSignal): Promise<LocalResponse> {
  const url = LOCAL_MODEL_BASE.replace(/\/+$/, '') + '/chat/completions'
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  
  // 使用JWT token进行认证
  const jwtToken = generateJWTToken()
  headers['Authorization'] = `Bearer ${jwtToken}`

  debugLog(`🔍 [DEBUG] callLocalModel - URL: ${url}`)
  debugLog(`🔍 [DEBUG] callLocalModel - Headers:`, JSON.stringify(headers, null, 2))
  debugLog(`🔍 [DEBUG] callLocalModel - Request body:`, JSON.stringify(request, null, 2))
  debugLog(`🔍 [DEBUG] callLocalModel - LOCAL_MODEL_BASE: ${LOCAL_MODEL_BASE}`)
  debugLog(`🔍 [DEBUG] callLocalModel - JWT Token generated: ${jwtToken.substring(0, 20)}...`)

  // 添加详细的请求数据打印
  debugLog(`\n📋 [DEBUG] callLocalModel - ===== 完整请求数据 =====`)
  debugLog(`📋 [DEBUG] callLocalModel - 请求URL: ${url}`)
  debugLog(`📋 [DEBUG] callLocalModel - 请求方法: POST`)
  debugLog(`📋 [DEBUG] callLocalModel - 请求Headers:`)
  Object.entries(headers).forEach(([key, value]) => {
    debugLog(`📋 [DEBUG] callLocalModel -   ${key}: ${key === 'Authorization' ? value.substring(0, 50) + '...' : value}`)
  })
  debugLog(`📋 [DEBUG] callLocalModel - 请求体大小: ${JSON.stringify(request).length} 字符`)
  debugLog(`📋 [DEBUG] callLocalModel - 请求体内容:`)
  debugLog(JSON.stringify(request, null, 2))
  debugLog(`📋 [DEBUG] callLocalModel - ===== 请求数据结束 =====\n`)

  try {
    debugLog(`🌐 [DEBUG] callLocalModel - Making fetch request to: ${url}`)
    
    // 设置超时 - 参考localAdapter.ts的实现
    const timeout = parseInt(process.env.LOCAL_MODEL_TIMEOUT || '30000') // 默认30秒
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)
    
    // 合并signal
    const combinedSignal = new AbortController()
    signal.addEventListener('abort', () => combinedSignal.abort())
    controller.signal.addEventListener('abort', () => combinedSignal.abort())
    
    const fetchOptions: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: combinedSignal.signal,
    }
    
    debugLog(`🔒 [DEBUG] callLocalModel - Using HTTPS with SSL verification disabled`)
    
    const res = await fetch(url, fetchOptions)
    clearTimeout(timeoutId) // 清除超时定时器
    
    debugLog(`📥 [DEBUG] callLocalModel - Response status: ${res.status}`)
    debugLog(`📥 [DEBUG] callLocalModel - Response headers:`, JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2))

    // 获取响应文本
    const text = await res.text()
    debugLog(`📥 [DEBUG] callLocalModel - Response text:`, text.substring(0, 500))
    
    if (!res.ok) {
      debugLog(`❌ [DEBUG] callLocalModel - HTTP error ${res.status}: ${text}`)
      throw new Error(`Local model HTTP error ${res.status}: ${text}`)
    }
    
    // 检查响应是否为空
    if (!text || text.trim().length === 0) {
      debugLog(`❌ [DEBUG] callLocalModel - Empty response`)
      throw new Error('Local model returned empty response')
    }
    
    try {
      const parsed = JSON.parse(text) as LocalResponse
      
      // 检查响应是否包含错误信息 - 参考localAdapter.ts
      if (parsed.error) {
        const errorMessage = parsed.error.message || parsed.error.code || 'Unknown error'
        throw new Error(`Local model server error: ${errorMessage}`)
      }
      
      // 检查是否有 choices 数组 - 参考localAdapter.ts
      if (!parsed.choices || !Array.isArray(parsed.choices) || parsed.choices.length === 0) {
        throw new Error('Local model server returned invalid response: missing choices array')
      }
      
      debugLog(`✅ [DEBUG] callLocalModel - Successfully parsed JSON response`)
      return parsed
      
    } catch (err) {
      debugLog(`❌ [DEBUG] callLocalModel - JSON parse error:`, err)
      throw new Error(`Failed to parse local model JSON: ${err}`)
    }
  } catch (error) {
    debugLog(`❌ [DEBUG] callLocalModel - Fetch error:`, error)
    debugLog(`❌ [DEBUG] callLocalModel - Error type:`, typeof error)
    debugLog(`❌ [DEBUG] callLocalModel - Error message:`, error instanceof Error ? error.message : String(error))
    debugLog(`❌ [DEBUG] callLocalModel - Error stack:`, error instanceof Error ? error.stack : 'No stack trace')
    
    // 参考localAdapter.ts的错误处理
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        const timeout = parseInt(process.env.LOCAL_MODEL_TIMEOUT || '30000')
        throw new Error(`Request timeout after ${timeout}ms. Please check your local model server response time or increase LOCAL_MODEL_TIMEOUT.`)
      }
      
      if (error.name === 'TypeError' && error.message.includes('fetch')) {
        throw new Error(`Cannot connect to local model server at ${LOCAL_MODEL_BASE}. Please check if the server is running and the URL is correct.`)
      }
    }
    
    throw error
  }
}

/**
 * 查询 local 模型
 */
export async function queryLocalModel(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[],
  maxThinkingTokens: number, // unused for now
  tools: Tool[],
  signal: AbortSignal,
  options: {
    dangerouslySkipPermissions: boolean
    model: string
    prependCLISysprompt: boolean
  },
): Promise<AssistantMessage> {
  const startTime = Date.now()
  debugLog(`🚀 [DEBUG] queryLocalModel - Starting with model: ${options.model}`)
  debugLog(`🚀 [DEBUG] queryLocalModel - Messages count: ${messages.length}`)
  debugLog(`🚀 [DEBUG] queryLocalModel - System prompt items: ${systemPrompt.length}`)
  debugLog(`🚀 [DEBUG] queryLocalModel - Tools count: ${tools.length}`)
  debugLog(`🚀 [DEBUG] queryLocalModel - LOCAL_MODEL_BASE: ${LOCAL_MODEL_BASE}`)
  debugLog(`🚀 [DEBUG] queryLocalModel - LOCAL_MODEL_API_KEY: ${LOCAL_MODEL_API_KEY ? 'set' : 'not set'}`)
  
  try {
    // Build messages
    const localMessages: LocalMessage[] = []
    if (systemPrompt.length) {
      localMessages.push({ role: 'system', content: systemPrompt.join('\n\n') })
      debugLog(`📝 [DEBUG] queryLocalModel - Added system prompt`)
    }
    for (const m of messages) {
      if (m.type === 'user') {
        localMessages.push(userMessageToLocal(m))
        debugLog(`📝 [DEBUG] queryLocalModel - Added user message: ${typeof m.message.content === 'string' ? m.message.content.substring(0, 50) : 'complex content'}`)
      } else {
        localMessages.push(assistantMessageToLocal(m as AssistantMessage))
        debugLog(`📝 [DEBUG] queryLocalModel - Added assistant message`)
      }
    }

    // 获取模型名称并检测模型类型
    const modelName = options.model;
    const modelType = detectModelType(modelName);
    debugLog(`🔧 [DEBUG] queryLocalModel - Model name: ${modelName}, detected type: ${modelType}`)

    // 根据模型类型设置max_tokens - 参考 localAdapter.ts
    const getMaxTokensForLocalModel = (model: string, modelType: string): number => {
      const lowerModel = model.toLowerCase()
      if (lowerModel.includes('v3')) {
        return 128000  // V3 模型支持128K
      }
      if (lowerModel.includes('v2.5')) {
        return 128000  // V2.5 模型支持128K
      }
      if (lowerModel.includes('coder')) {
        return 32000   // Coder 模型支持32K
      }
      if (lowerModel.includes('chat')) {
        return 32000   // Chat 模型支持32K
      }
      if (modelType === 'deepseek-coder') {
        return 32000   // DeepSeek Coder 类型
      }
      if (modelType === 'gpt') {
        return 32000   // GPT 兼容模型
      }
      return 32000     // 默认32K
    }
    
    const maxTokens = getMaxTokensForLocalModel(modelName, modelType)
    debugLog(`🔧 [DEBUG] queryLocalModel - Model: ${modelName}, type: ${modelType}, max_tokens: ${maxTokens}`)

    // 构造请求体 - 参考 localAdapter.ts 的 convertToLocalRequest
    const requestObj: any = {
      model: modelName,
      messages: localMessages,
      stream: false,
      temperature: 0,
      max_tokens: 300,  // 使用与curl相同的值
      // 移除所有服务器不支持的字段
      // presence_penalty: 0,
      // frequency_penalty: 0,
      // top_p: 1,
    };

    // 根据模型类型调整请求参数 - 参考 localAdapter.ts
    adjustRequestForModel(requestObj, modelType);
    
    // 添加工具
    if (tools.length > 0) {
      const limitedTools = tools.slice(0, 2)
      debugLog(`🔧 [DEBUG] queryLocalModel - Limiting tools from ${tools.length} to ${limitedTools.length}`)
      requestObj.tools = toolsToLocal(limitedTools)
    }

    // 添加简化模式测试 - 只移除tools但保留system prompt
    const simplifiedMode = process.env.LOCAL_MODEL_SIMPLIFIED === 'true'
    if (simplifiedMode) {
      debugLog(`🔧 [DEBUG] queryLocalModel - Using simplified mode - removing tools but keeping system prompt`)
      
      // 移除tools
      if (requestObj.tools && requestObj.tools.length > 0) {
        debugLog(`🔧 [DEBUG] queryLocalModel - Removing ${requestObj.tools.length} tools`)
        delete requestObj.tools
      }
      
      // 简化system prompt - 使用非常简单的prompt进行测试
      if (requestObj.messages.length > 0 && requestObj.messages[0].role === 'system') {
        const originalSystemPrompt = requestObj.messages[0].content
        const simplifiedSystemPrompt = 'You are a helpful assistant.'
        requestObj.messages[0].content = simplifiedSystemPrompt
        debugLog(`🔧 [DEBUG] queryLocalModel - Simplified system prompt from ${originalSystemPrompt.length} to ${simplifiedSystemPrompt.length} characters`)
      }
      
      // 完全移除system prompt进行测试
      requestObj.messages = requestObj.messages.filter(msg => msg.role !== 'system')
      debugLog(`🔧 [DEBUG] queryLocalModel - Removed system prompt, remaining messages: ${requestObj.messages.length}`)
    }

    debugLog(`📤 [DEBUG] queryLocalModel - Built request with ${localMessages.length} messages`)
    debugLog('🌐 [local_model] Request:', JSON.stringify(requestObj).substring(0, 500))

    debugLog(`🌐 [DEBUG] queryLocalModel - Calling callLocalModel...`)
    const response = await callLocalModel(requestObj, signal)
    debugLog(`✅ [DEBUG] queryLocalModel - callLocalModel completed successfully`)

    const durationMs = Date.now() - startTime
    debugLog(`⏱️ [DEBUG] queryLocalModel - Total duration: ${durationMs}ms`)

    const choice = response.choices[0]
    if (!choice) {
      debugLog(`❌ [DEBUG] queryLocalModel - No choices in response`)
      throw new Error('Local model returned no choices')
    }

    debugLog(`✅ [DEBUG] queryLocalModel - Response has ${response.choices.length} choices`)
    debugLog(`✅ [DEBUG] queryLocalModel - Choice content: ${choice.message.content || 'no content'}`)

    const assistantMsg: AssistantMessage = {
      costUSD: 0,
      durationMs,
      type: 'assistant',
      uuid: crypto.randomUUID(),
      message: {
        id: response.id || `local_${Date.now()}`,
        type: 'assistant',
        role: 'assistant',
        content: choice.message.content ? [{ type: 'text', text: choice.message.content }] : [],
        model: options.model,
        stop_reason: choice.finish_reason || 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: response.usage?.prompt_tokens || 0,
          output_tokens: response.usage?.completion_tokens || 0,
        },
      },
    }

    debugLog(`✅ [DEBUG] queryLocalModel - Created assistant message successfully`)
    debugLog(`✅ [DEBUG] queryLocalModel - Final message content: ${assistantMsg.message.content[0]?.text || 'no content'}`)

    // tool calls
    if (choice.message.tool_calls?.length) {
      debugLog(`🔧 [DEBUG] queryLocalModel - Processing ${choice.message.tool_calls.length} tool calls`)
      for (const tc of choice.message.tool_calls) {
        assistantMsg.message.content.push({
          type: 'tool_use',
          id: (tc as any).id || crypto.randomUUID(),
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        })
      }
    }

    return assistantMsg
  } catch (error) {
    const durationMs = Date.now() - startTime
    debugLog(`❌ [DEBUG] queryLocalModel - Error occurred after ${durationMs}ms`)
    debugLog(`❌ [DEBUG] queryLocalModel - Error:`, error)
    debugLog(`❌ [DEBUG] queryLocalModel - Error type:`, typeof error)
    debugLog(`❌ [DEBUG] queryLocalModel - Error message:`, error instanceof Error ? error.message : String(error))
    logError(error)
    return {
      costUSD: 0,
      durationMs,
      type: 'assistant',
      uuid: crypto.randomUUID(),
      isApiErrorMessage: true,
      message: {
        id: `local_error_${Date.now()}`,
        type: 'assistant',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `Error calling local model: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        model: options.model,
        stop_reason: 'error',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }
  }
}