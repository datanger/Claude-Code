import OpenAI from 'openai'
import type { AssistantMessage, UserMessage } from '../query.js'
import { Tool } from '../Tool.js'
import { getOpenAIApiKey } from '../utils/config.js'
import { logError, debugLog } from '../utils/log.js'

// DeepSeek API 配置
const DEEPSEEK_API_BASE = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com'
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY

let deepseekClient: OpenAI | null = null

/**
 * 检查 DeepSeek API 连接
 */
async function checkDeepSeekConnection(): Promise<boolean> {
  try {
    debugLog(`🔍 [DEBUG] Checking DeepSeek connection at: ${DEEPSEEK_API_BASE}`)
    const response = await fetch(`${DEEPSEEK_API_BASE}/models`, {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(10000) // 10秒超时
    })
    const isAvailable = response.ok
    debugLog(`🔍 [DEBUG] DeepSeek connection check result: ${isAvailable ? 'OK' : 'FAILED'}`)
    return isAvailable
  } catch (error) {
    debugLog(`❌ [DEBUG] DeepSeek connection check failed: ${error}`)
    return false
  }
}

/**
 * 获取 DeepSeek API Key
 */
export function getDeepSeekApiKey(): null | string {
  // 优先使用环境变量
  if (DEEPSEEK_API_KEY) {
    debugLog(`✅ [DEBUG] DeepSeek API key found: ${DEEPSEEK_API_KEY.substring(0, 20)}...`)
    return DEEPSEEK_API_KEY
  }
  
  console.warn('⚠️ [DEBUG] No DEEPSEEK_API_KEY found in environment variables')
  return null
}

/**
 * 获取 DeepSeek 客户端实例
 */
export function getDeepSeekClient(model: string): OpenAI {
  const apiKey = getDeepSeekApiKey()
  if (!apiKey) {
    throw new Error('DeepSeek API key not found. Please set DEEPSEEK_API_KEY environment variable.')
  }
  
  const baseURL = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com'
  
  // 检查是否需要重新创建客户端（当环境变量改变时）
  if (deepseekClient) {
    // 如果配置没有改变，直接返回现有客户端
    if (deepseekClient.apiKey === apiKey && 
        deepseekClient.baseURL === baseURL) {
      return deepseekClient
    }
    
    // 如果配置改变了，重置客户端
    console.log(`🔄 [DEBUG] DeepSeek configuration changed, recreating client`)
    deepseekClient = null
  }

  deepseekClient = new OpenAI({
    apiKey,
    baseURL: baseURL,
    maxRetries: 3,
    dangerouslyAllowBrowser: true, // 添加这个选项解决环境警告
  })
  
  console.log(`🔧 [DEBUG] Created DeepSeek client with base URL: ${baseURL}`)
  return deepseekClient
}

/**
 * 重置 DeepSeek 客户端
 */
export function resetDeepSeekClient(): void {
  deepseekClient = null
  console.log('🔄 [DEBUG] DeepSeek client reset')
}

/**
 * 验证 DeepSeek API Key
 */
export async function verifyDeepSeekApiKey(apiKey: string): Promise<boolean> {
  try {
    const client = new OpenAI({
      apiKey,
      baseURL: DEEPSEEK_API_BASE,
    })

    // 尝试调用一个简单的 API 来验证密钥
    await client.models.list()
    console.log('✅ [DEBUG] DeepSeek API key verification successful')
    return true
  } catch (error) {
    console.error('❌ [DEBUG] DeepSeek API key verification failed:', error)
    return false
  }
}

/**
 * 将用户消息转换为 OpenAI 格式
 */
function userMessageToMessageParam(message: UserMessage): any {
  debugLog(`🔍 [DEBUG] userMessageToMessageParam - message structure:`, JSON.stringify(message, null, 2))
  
  // 检查消息结构 - 处理字符串类型的 content
  if (typeof message.message.content === 'string') {
    return {
      role: 'user',
      content: message.message.content,
    }
  }
  
  // 检查消息结构 - 处理 type: 'text' 的情况
  if (message.message.type === 'text') {
    return {
      role: 'user',
      content: message.message.text,
    }
  }
  
  // 处理 content 数组格式
  if (Array.isArray(message.message.content)) {
    // 检查是否是工具结果消息
    const toolResults = message.message.content.filter((block: any) => block.type === 'tool_result')
    if (toolResults.length > 0) {
      return {
        role: 'tool',
        tool_call_id: toolResults[0].tool_use_id,
        content: toolResults[0].content,
      }
    }
    
    // 处理普通文本内容
    const textContent = message.message.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('')
    
    if (textContent) {
      return {
        role: 'user',
        content: textContent,
      }
    }
  }
  
  // 如果都没有找到，返回空内容
  console.warn(`⚠️ [DEBUG] Could not extract text content from user message`)
  return {
    role: 'user',
    content: '',
  }
}

/**
 * 将助手消息转换为 OpenAI 格式
 */
function assistantMessageToMessageParam(message: AssistantMessage): any {
  if (message.message.content.length === 0) {
    return {
      role: 'assistant',
      content: '',
    }
  }

  const content = message.message.content[0]
  if (content.type === 'text') {
    return {
      role: 'assistant',
      content: content.text,
    }
  }

  // 处理工具使用
  if (content.type === 'tool_use') {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: content.id,
          type: 'function',
          function: {
            name: content.name,
            arguments: JSON.stringify(content.input),
          },
        },
      ],
    }
  }

  return {
    role: 'assistant',
    content: '',
  }
}

/**
 * 格式化系统提示词
 */
function formatSystemPromptWithContext(systemPrompt: string[]): string {
  // 自动识别当前操作系统
  let osHint = ''
  if (typeof process !== 'undefined' && process.platform) {
    if (process.platform === 'win32') {
      osHint = `\n[Environment Notice]\nYou are running on a Windows system. Only use Windows shell commands (e.g., 'type' for file content, 'dir' for listing files). Do NOT use Linux commands like 'cat', 'ls', 'grep', 'echo' with Unix syntax, etc.`
    } else {
      osHint = `\n[Environment Notice]\nYou are running on a Unix/Linux system. Use bash/zsh shell commands. Avoid Windows-specific commands like 'dir' or 'type'.`
    }
  }
  return [
    ...systemPrompt,
    osHint,
  ].join('\n\n')
}

/**
 * 计算 DeepSeek 模型成本
 */
function calculateDeepSeekCost(model: string, inputTokens: number, outputTokens: number): number {
  // DeepSeek 定价 (示例，需要根据实际定价调整)
  const pricing: { [key: string]: { input: number; output: number } } = {
    'deepseek-chat': { input: 0.00014, output: 0.00028 }, // $0.14/$0.28 per 1K tokens
    'deepseek-coder': { input: 0.00014, output: 0.00028 },
    'deepseek-reasoner': { input: 0.00014, output: 0.00028 },
  }

  const modelKey = model.toLowerCase()
  const price = pricing[modelKey] || pricing['deepseek-chat']
  
  const inputCost = (inputTokens / 1000) * price.input
  const outputCost = (outputTokens / 1000) * price.output
  
  return inputCost + outputCost
}

/**
 * 查询 DeepSeek 模型
 */
export async function queryDeepSeek(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[],
  maxThinkingTokens: number,
  tools: Tool[],
  signal: AbortSignal,
  options: {
    dangerouslySkipPermissions: boolean
    model: string
    prependCLISysprompt: boolean
  },
): Promise<AssistantMessage> {
  debugLog(`🚀 [DEBUG] queryDeepSeek() started`)
  debugLog(`🤖 [DEBUG] Model: ${options.model}`)
  debugLog(`📨 [DEBUG] Messages count: ${messages.length}`)
  debugLog(`🔧 [DEBUG] Tools count: ${tools.length}`)
  debugLog(`🔐 [DEBUG] Skip permissions: ${options.dangerouslySkipPermissions}`)

  const startTime = Date.now()
  
  try {
    const client = getDeepSeekClient(options.model)
    
    // 转换消息格式
    const openaiMessages: any[] = []
    
    // 添加系统消息
    if (systemPrompt.length > 0) {
      openaiMessages.push({
        role: 'system',
        content: formatSystemPromptWithContext(systemPrompt),
      })
    }
    
    // 转换用户和助手消息
    for (const message of messages) {
      if (message.type === 'user') {
        openaiMessages.push(userMessageToMessageParam(message))
      } else if (message.type === 'assistant') {
        openaiMessages.push(assistantMessageToMessageParam(message))
      }
    }
    
    debugLog(`📤 [DEBUG] Converted ${openaiMessages.length} messages to OpenAI format`)
    
    // 添加 DEBUG 日志显示消息内容
    debugLog(`📝 [DEBUG] Messages being sent to API:`)
    openaiMessages.forEach((msg, index) => {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      debugLog(`   [${index}] Role: ${msg.role}, Content: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`)
    })
    
    // 转换工具格式
    const openaiTools = tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }))
    
    debugLog(`🔧 [DEBUG] Converted ${openaiTools.length} tools to OpenAI format`)
    
    // 构造请求参数
    const requestParams: any = {
      model: options.model,
      messages: openaiMessages,
      max_tokens: 4096,
      temperature: 0.7,
      top_p: 0.9,
    }
    
    if (openaiTools.length > 0) {
      requestParams.tools = openaiTools
      requestParams.tool_choice = 'auto'
    }
    
    debugLog(`📤 [DEBUG] Making API call to DeepSeek with params:`, JSON.stringify(requestParams, null, 2))
    
    const completion = await client.chat.completions.create(requestParams)
    
    debugLog(`✅ [DEBUG] DeepSeek API call successful`)
    debugLog(`📥 [DEBUG] Response:`, JSON.stringify(completion, null, 2))
    
    const choice = completion.choices[0]
    if (!choice) {
      throw new Error('DeepSeek returned no choices')
    }
    
    const content = choice.message.content || ''
    debugLog(`📝 [DEBUG] Generated content: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`)
    
    const endTime = Date.now()
    const durationMs = endTime - startTime
    
    const assistantMessage: AssistantMessage = {
      costUSD: calculateDeepSeekCost(options.model, completion.usage?.prompt_tokens || 0, completion.usage?.completion_tokens || 0),
      durationMs,
      message: {
        id: completion.id,
        type: 'assistant',
        role: 'assistant',
        content: [{ type: 'text', text: content }],
        model: options.model,
        stop_reason: choice.finish_reason || 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: completion.usage?.prompt_tokens || 0,
          output_tokens: completion.usage?.completion_tokens || 0,
        },
      },
      type: 'assistant',
      uuid: crypto.randomUUID(),
    }
    
    return assistantMessage
    
  } catch (error) {
    const endTime = Date.now()
    const durationMs = endTime - startTime
    
    console.error(`❌ [DEBUG] DeepSeek API call failed after ${durationMs}ms:`, error)
    
    // 提供更详细的错误信息
    let errorMessage = 'Unknown error'
    if (error instanceof Error) {
      if (error.message.includes('401')) {
        errorMessage = 'DeepSeek API key is invalid or expired. Please check your DEEPSEEK_API_KEY.'
      } else if (error.message.includes('403')) {
        errorMessage = 'Access denied. Please check your DeepSeek API permissions.'
      } else if (error.message.includes('429')) {
        errorMessage = 'Rate limit exceeded. Please try again later.'
      } else if (error.message.includes('500')) {
        errorMessage = 'DeepSeek server error. Please try again later.'
      } else if (error.message.includes('fetch')) {
        errorMessage = 'Network error. Please check your internet connection and DEEPSEEK_API_BASE setting.'
      } else {
        errorMessage = error.message
      }
    }
    
    // 返回错误消息
    return {
      costUSD: 0,
      durationMs,
      message: {
        id: `deepseek_error_${Date.now()}`,
        type: 'assistant',
        role: 'assistant',
        content: [{ 
          type: 'text', 
          text: `Error calling DeepSeek API: ${errorMessage}` 
        }],
        model: options.model,
        stop_reason: 'error',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      type: 'assistant',
      uuid: crypto.randomUUID(),
      isApiErrorMessage: true,
    }
  }
} 