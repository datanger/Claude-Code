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
 * 获取 DeepSeek API Key
 */
export function getDeepSeekApiKey(): null | string {
  // 优先使用环境变量
  if (DEEPSEEK_API_KEY) {
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
        parameters: tool.schema,
      },
    }))
    
    debugLog(`🛠️ [DEBUG] Converted ${openaiTools.length} tools to OpenAI format`)
    
    // 根据模型类型设置max_tokens
    const getMaxTokensForDeepSeekModel = (model: string): number => {
      const lowerModel = model.toLowerCase()
      if (lowerModel.includes('v3')) {
        return 128000  // DeepSeek V3 支持128K
      }
      if (lowerModel.includes('v2.5')) {
        return 128000  // DeepSeek V2.5 支持128K
      }
      if (lowerModel.includes('coder')) {
        return 32000   // DeepSeek Coder 支持32K
      }
      if (lowerModel.includes('chat')) {
        return 32000   // DeepSeek Chat 支持32K
      }
      return 32000     // 默认32K
    }
    
    const maxTokens = getMaxTokensForDeepSeekModel(options.model)
    debugLog(`🔧 [DEBUG] DeepSeek model: ${options.model}, max_tokens: ${maxTokens}`)
    
    // 调用 DeepSeek API
    debugLog(`🌐 [DEBUG] Calling DeepSeek API...`)
    const response = await client.chat.completions.create({
      model: options.model,
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      tool_choice: openaiTools.length > 0 ? 'auto' : undefined,
      max_tokens: maxTokens,
      temperature: 0,
      stream: false,
    }, {
      signal,
    })
    
    const endTime = Date.now()
    const durationMs = endTime - startTime
    
    debugLog(`✅ [DEBUG] DeepSeek API call completed in ${durationMs}ms`)
    debugLog(`📊 [DEBUG] Usage:`, response.usage)
    
    // 添加 DEBUG 日志显示 API 响应内容
    debugLog(`📤 [DEBUG] API Response content:`, response.choices[0].message.content)
    
    // 计算成本
    const costUSD = calculateDeepSeekCost(
      options.model,
      response.usage?.prompt_tokens || 0,
      response.usage?.completion_tokens || 0,
    )
    
    debugLog(`💰 [DEBUG] Estimated cost: $${costUSD.toFixed(6)}`)
    
    // 转换响应格式
    const choice = response.choices[0]
    if (!choice) {
      throw new Error('No response from DeepSeek API')
    }
    
    const message = choice.message
    
    // 转换为 Anthropic 格式的助手消息
    const assistantMessage: AssistantMessage = {
      costUSD,
      durationMs,
      message: {
        id: `deepseek_${Date.now()}`,
        type: 'assistant',
        role: 'assistant',
        content: message.content ? [{ type: 'text', text: message.content }] : [],
        model: options.model,
        stop_reason: choice.finish_reason || 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: response.usage?.prompt_tokens || 0,
          output_tokens: response.usage?.completion_tokens || 0,
        },
      },
      type: 'assistant',
      uuid: crypto.randomUUID(),
    }
    
    // 处理工具调用
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        assistantMessage.message.content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: JSON.parse(toolCall.function.arguments),
        })
      }
    }
    
    debugLog(`📝 [DEBUG] Response converted to Anthropic format`)
    debugLog(`🎯 [DEBUG] queryDeepSeek() completed successfully`)
    
    return assistantMessage
    
  } catch (error) {
    const endTime = Date.now()
    const durationMs = endTime - startTime
    
    console.error(`❌ [DEBUG] DeepSeek API call failed after ${durationMs}ms:`, error)
    
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
          text: `Error calling DeepSeek API: ${error instanceof Error ? error.message : String(error)}` 
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