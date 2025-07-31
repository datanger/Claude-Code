import crypto from 'crypto'
import type { AssistantMessage, UserMessage } from '../query.js'
import type { Tool } from '../Tool.js'
import { debugLog, logError } from '../utils/log.js'
import { zodToJsonSchema } from 'zod-to-json-schema'
// @ts-ignore
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

// 检查本地模型服务是否可用
async function checkLocalModelAvailability(): Promise<boolean> {
  try {
    const url = LOCAL_MODEL_BASE.replace(/\/+$/, '') + '/health'
    debugLog(`🔍 [DEBUG] Checking local model availability at: ${url}`)
    const response = await fetch(url, { 
      method: 'GET',
      signal: AbortSignal.timeout(5000) // 5秒超时
    })
    const isAvailable = response.ok
    debugLog(`🔍 [DEBUG] Local model health check result: ${isAvailable ? 'OK' : 'FAILED'}`)
    return isAvailable
  } catch (error) {
    debugLog(`❌ [DEBUG] Local model health check failed: ${error}`)
    return false
  }
}

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
  tool_choice?: string
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
    } else if (part.type === 'tool_use') {
      // 处理工具调用
      segments.push(`[ToolCall] ${part.name}: ${JSON.stringify(part.input)}`)
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

  // 添加参数标准化函数，参考 localAdapter.ts
  const normalizeParameters = (parameters: unknown): Record<string, unknown> => {
    if (!parameters) {
      return {};
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
  };

  return tools.map(tool => {
    // 获取工具的schema - 工具可能使用inputSchema而不是schema
    let schema = (tool as any).schema;
    if (!schema && (tool as any).inputSchema) {
      schema = (tool as any).inputSchema;
    }
    
    // 如果schema是Zod schema，转换为JSON Schema
    if (schema && typeof schema === 'object' && schema._def) {
      try {
        schema = zodToJsonSchema(schema);
        debugLog(`🔧 [DEBUG] Converted Zod schema for tool ${tool.name}:`, JSON.stringify(schema, null, 2));
      } catch (error) {
        debugLog(`⚠️ [DEBUG] Failed to convert Zod schema for tool ${tool.name}:`, error);
        schema = { type: 'object', properties: {} };
      }
    }
    
    // 标准化参数格式
    const normalizedParameters = normalizeParameters(schema);
    debugLog(`🔧 [DEBUG] Normalized parameters for tool ${tool.name}:`, JSON.stringify(normalizedParameters, null, 2));
    
    // 处理description - 应该是字符串，如果工具定义中有description函数，使用默认描述
    let description = '';
    if (typeof tool.description === 'string') {
      description = tool.description;
    } else {
      // 如果description是函数，使用工具名称作为默认描述
      description = `Tool: ${tool.name}`;
    }
    
    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: description,
        parameters: normalizedParameters
      }
    };
  });
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
      requestObj.top_p = requestObj.top_p ?? 0.95; // 修正为 0.95
      break;
      
    case 'gpt':
      // OpenAI 兼容配置
      requestObj.temperature = requestObj.temperature ?? 0.7;
      requestObj.top_p = requestObj.top_p ?? 1; // 修正为 1
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
  
  // 使用 API Key 进行认证，与 localAdapter.ts 保持一致
  if (LOCAL_MODEL_API_KEY) {
    headers['Authorization'] = `Bearer ${LOCAL_MODEL_API_KEY}`
  }

  // 检查是否是 HTTPS 请求，如果是则设置环境变量忽略 SSL 证书验证 - 参考 localAdapter.ts
  const isHttps = LOCAL_MODEL_BASE.startsWith('https://');
  if (isHttps && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  debugLog(`🔍 [DEBUG] URL: ${url}`)

  try {
    debugLog(`🌐 [DEBUG] Making fetch request to: ${url}`)
    
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
    
    debugLog(`🔒 [DEBUG] Using HTTPS with SSL verification disabled`)
    
    const res = await fetch(url, fetchOptions)
    clearTimeout(timeoutId) // 清除超时定时器
    
    debugLog(`📥 [DEBUG] Response status: ${res.status}`)
    debugLog(`📥 [DEBUG] Response headers:`, Object.fromEntries(res.headers.entries()))

    // 获取响应文本
    const text = await res.text()
    debugLog(`📥 [DEBUG] Response text length: ${text.length}`)
    debugLog(`📥 [DEBUG] Response text: ${text.substring(0, 500)}${text.length > 500 ? '...' : ''}`)
    
    if (!res.ok) {
      debugLog(`❌ [DEBUG] HTTP error ${res.status}: ${text}`)
      throw new Error(`Local model HTTP error ${res.status}: ${text}`)
    }
    
    // 检查响应是否为空
    if (!text || text.trim().length === 0) {
      debugLog(`❌ [DEBUG] Empty response`)
      throw new Error('Local model returned empty response. Please check if the server is running and accessible.')
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
      
      // 检查 choices 中的 message 是否有 content
      const choice = parsed.choices[0]
      if (!choice || !choice.message) {
        throw new Error('Local model server returned invalid response: missing message in choice')
      }
      
      // 检查 content 是否为空或 null
      if (!choice.message?.content || choice.message.content.trim() === '') {
        debugLog(`⚠️ [DEBUG] Choice message content is empty or null`)
        // 不要抛出错误，而是继续处理，让上层处理空内容
      }
      
      debugLog(`✅ [DEBUG] Successfully parsed JSON response`)
      return parsed
      
    } catch (err) {
      debugLog(`❌ [DEBUG] JSON parse error:`, err)
      throw new Error(`Failed to parse local model JSON: ${err}`)
    }
  } catch (error) {
    debugLog(`❌ [DEBUG] Fetch error:`, error)
    debugLog(`❌ [DEBUG] Error type:`, typeof error)
    debugLog(`❌ [DEBUG] Error message:`, error instanceof Error ? error.message : String(error))
    
    // 参考localAdapter.ts的错误处理
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        const timeout = parseInt(process.env.LOCAL_MODEL_TIMEOUT || '30000')
        throw new Error(`Request timeout after ${timeout}ms. Please check your local model server response time or increase LOCAL_MODEL_TIMEOUT.`)
      }
      
      if (error.name === 'TypeError' && error.message.includes('fetch')) {
        throw new Error(`Cannot connect to local model server at ${LOCAL_MODEL_BASE}. Please check if the server is running and the URL is correct. You can set LOCAL_MODEL_BASE environment variable to point to your local model server.`)
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
  debugLog(`🚀 [DEBUG] queryLocalModel() started`)
  debugLog(`🤖 [DEBUG] Model: ${options.model}`)
  debugLog(`📨 [DEBUG] Messages count: ${messages.length}`)
  debugLog(`🔧 [DEBUG] Tools count: ${tools.length}`)
  debugLog(`🔐 [DEBUG] Skip permissions: ${options.dangerouslySkipPermissions}`)
  debugLog(`🌐 [DEBUG] LOCAL_MODEL_BASE: ${LOCAL_MODEL_BASE}`)
  debugLog(`🔑 [DEBUG] LOCAL_MODEL_API_KEY: ${LOCAL_MODEL_API_KEY ? 'set' : 'not set'}`)
  
  try {
    // Build messages
    const localMessages: LocalMessage[] = []
    if (systemPrompt.length) {
      localMessages.push({ role: 'system', content: systemPrompt.join('\n\n') })
      debugLog(`📝 [DEBUG] Added system prompt`)
    }
    for (const m of messages) {
      if (m.type === 'user') {
        localMessages.push(userMessageToLocal(m))
        // debugLog(`📝 [DEBUG] Added user message: ${typeof m.message.content === 'string' ? m.message.content.substring(0, 50) : 'complex content'}`)
      } else {
        localMessages.push(assistantMessageToLocal(m as AssistantMessage))
        debugLog(`📝 [DEBUG] Added assistant message`)
      }
    }

    // 如果没有消息，添加默认系统消息 - 参考 localAdapter.ts
    if (localMessages.length === 0) {
      localMessages.push({ role: 'system', content: 'You are a helpful assistant.' })
      debugLog(`📝 [DEBUG] Added default system message`)
    }

    // 获取模型名称并检测模型类型
    const modelName = options.model;
    const modelType = detectModelType(modelName);
    debugLog(`🔧 [DEBUG] Model name: ${modelName}, detected type: ${modelType}`)

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
    debugLog(`🔧 [DEBUG] Model: ${modelName}, type: ${modelType}, max_tokens: ${maxTokens}`)

    // 构造请求体 - 最简单的版本，只包含最基本参数
    const requestObj: any = {
      model: modelName,
      messages: localMessages,
    };

    // 根据模型类型调整请求参数 - 参考 localAdapter.ts
    adjustRequestForModel(requestObj, modelType);
    
    // 添加工具
    if (tools.length > 0) {
      // 重新启用 tools
      const localTools = toolsToLocal(tools) 
      requestObj.tools = localTools
      debugLog(`🔧 [DEBUG] Tools enabled: ${localTools.length} tools`)
      // debugLog(`🔧 [DEBUG] Tools: ${JSON.stringify(localTools, null, 2)}`)
    }

    // 如果是JSON请求，添加格式要求到系统消息 - 参考 localAdapter.ts
    const isJsonRequest = false; // 暂时设为 false，因为我们没有 JSON 请求的检测逻辑
    if (isJsonRequest && localMessages.length > 0) {
      const lastMessage = localMessages[localMessages.length - 1];
      if (lastMessage.role === 'user') {
        lastMessage.content += '\n\n请严格按照JSON格式回复，不要包含任何其他文本，不要使用markdown代码块。';
        debugLog(`📝 [DEBUG] Added JSON format requirement to last user message`);
      }
    }

    debugLog(`📤 [DEBUG] Converted ${localMessages.length} messages to Local format`)
    
    // 添加 DEBUG 日志显示消息内容 - 参照 deepseek.ts
    debugLog(`📝 [DEBUG] Messages being sent to Local Model:`)
    localMessages.forEach((msg, index) => {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      debugLog(`   [${index}] Role: ${msg.role}, Content: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`)
    })

    // 添加详细的请求体调试信息
    debugLog(`📤 [DEBUG] Request body being sent:`, JSON.stringify(requestObj, null, 2))

    debugLog(`🌐 [DEBUG] Calling callLocalModel...`)
    const response = await callLocalModel(requestObj, signal)
    debugLog(`✅ [DEBUG] Local Model API call successful`)
    debugLog(`📥 [DEBUG] Response:`, JSON.stringify(response, null, 2))

    const durationMs = Date.now() - startTime
    debugLog(`⏱️ [DEBUG] Total duration: ${durationMs}ms`)

    const choice = response.choices[0]
    if (!choice) {
      debugLog(`❌ [DEBUG] No choices in response`)
      throw new Error('Local model returned no choices')
    }

    const content = choice.message?.content || ''
    const toolCalls = choice.message?.tool_calls || []

    debugLog(`📝 [DEBUG] Generated content: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`)
    debugLog(`🔧 [DEBUG] Tool calls: ${toolCalls.length}`)

    const assistantMsg: AssistantMessage = {
      costUSD: 0,
      durationMs,
      type: 'assistant',
      uuid: crypto.randomUUID(),
      message: {
        id: response.id || `local_${Date.now()}`,
        type: 'assistant',
        role: 'assistant',
        content: choice.message?.content ? [{ type: 'text', text: choice.message.content }] : [],
        model: options.model,
        stop_reason: choice.finish_reason || 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: response.usage?.prompt_tokens || 0,
          output_tokens: response.usage?.completion_tokens || 0,
        },
      },
    }

    debugLog(`✅ [DEBUG] Created assistant message successfully`)

    // tool calls
    if (choice.message?.tool_calls?.length) {
      debugLog(`🔧 [DEBUG] Tool calls: ${choice.message.tool_calls.length}`)
      debugLog(`🔧 [DEBUG] Tool calls from server:`, JSON.stringify(choice.message.tool_calls, null, 2))
      
      // 去重逻辑：使用 Set 来跟踪已处理的工具调用
      const processedToolCalls = new Set<string>()
      
      for (const tc of choice.message.tool_calls) {
        // 创建工具调用的唯一标识符
        const toolCallId = (tc as any).id || crypto.randomUUID()
        const toolCallSignature = `${tc.function.name}:${JSON.stringify(tc.function.arguments)}`
        
        debugLog(`🔧 [DEBUG] Processing tool call: ${tc.function.name}`)
        debugLog(`🔧 [DEBUG] Tool call signature: ${toolCallSignature}`)
        debugLog(`🔧 [DEBUG] Already processed: ${processedToolCalls.has(toolCallSignature)}`)
        
        // 检查是否已经处理过相同的工具调用
        if (processedToolCalls.has(toolCallSignature)) {
          debugLog(`⚠️ [DEBUG] Skipping duplicate tool call: ${tc.function.name}`)
          continue
        }
        
        // 标记为已处理
        processedToolCalls.add(toolCallSignature)
        
        assistantMsg.message.content.push({
          type: 'tool_use',
          id: toolCallId,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        })
        
        debugLog(`✅ [DEBUG] Added tool call: ${tc.function.name}`)
      }
    } else {
      debugLog(`🔧 [DEBUG] No tool calls found in response`)
    }

    return assistantMsg
  } catch (error) {
    const durationMs = Date.now() - startTime
    debugLog(`❌ [DEBUG] Local Model API call failed after ${durationMs}ms`)
    debugLog(`❌ [DEBUG] Error:`, error)
    debugLog(`❌ [DEBUG] Error type:`, typeof error)
    debugLog(`❌ [DEBUG] Error message:`, error instanceof Error ? error.message : String(error))
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