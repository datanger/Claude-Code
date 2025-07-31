import OpenAI from 'openai'
import type { AssistantMessage, UserMessage } from '../query.js'
import { Tool } from '../Tool'
import { getOpenAIApiKey } from '../utils/config.js'
import { logError, debugLog } from '../utils/log.js'
import { zodToJsonSchema } from 'zod-to-json-schema'
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
} from '../utils/messages.js'
import { addToTotalCost } from '../cost-tracker.js'
import { randomUUID } from 'crypto'

// DeepSeek API 配置
const DEEPSEEK_API_BASE = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com'
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY

// DeepSeek 成本计算 (每百万 token) - 继承自 openai.ts 但使用 DeepSeek 定价
const DEEPSEEK_COST_PER_MILLION_INPUT_TOKENS = 0.14  // $0.14 per 1K tokens
const DEEPSEEK_COST_PER_MILLION_OUTPUT_TOKENS = 0.28  // $0.28 per 1K tokens

export const API_ERROR_MESSAGE_PREFIX = 'DeepSeek API Error'
export const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'
export const CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE = 'Credit balance is too low'
export const INVALID_API_KEY_ERROR_MESSAGE = 'Invalid API key · Please run /login'
export const NO_CONTENT_MESSAGE = '(no content)'

const MAX_RETRIES = 10
const BASE_DELAY_MS = 500

interface RetryOptions {
  maxRetries?: number
}

function getRetryDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 32000)
}

function shouldRetry(error: any): boolean {
  if (error?.status === 429) return true // Rate limit
  if (error?.status >= 500) return true  // Server error
  if (error?.code === 'ECONNRESET') return true // Network error
  return false
}

async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  let lastError: unknown

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error

      if (attempt > maxRetries || !shouldRetry(error)) {
        throw error
      }

      const delayMs = getRetryDelay(attempt)
      debugLog(
        `  ⎿  DeepSeek API ${error instanceof Error ? error.message : String(error)} · Retrying in ${Math.round(delayMs / 1000)} seconds… (attempt ${attempt}/${maxRetries})`,
      )

      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  throw lastError
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

let deepseekClient: OpenAI | null = null

/**
 * 获取 DeepSeek 客户端实例 - 继承自 openai.ts 的 getOpenAIClient
 */
export function getDeepSeekClient(model: string): OpenAI {
  const apiKey = getDeepSeekApiKey()
  if (!apiKey) {
    throw new Error('DeepSeek API key not found. Please set DEEPSEEK_API_KEY environment variable.')
  }
  
  const baseURL = DEEPSEEK_API_BASE
  
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

  const clientConfig: any = {
    apiKey,
    baseURL: baseURL,
    maxRetries: 3,
    dangerouslyAllowBrowser: true, // 添加这个选项解决环境警告
  }
  
  console.log(`🔧 [DEBUG] Created DeepSeek client with base URL: ${baseURL}`)
  deepseekClient = new OpenAI(clientConfig)
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
 * 将用户消息转换为 OpenAI 格式 - 继承自 openai.ts
 */
export function userMessageToMessageParam(
  message: UserMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  return {
    role: 'user',
    content: typeof message.message.content === 'string' 
      ? message.message.content 
      : message.message.content.map((block: any) => 
          block.type === 'text' ? block.text : JSON.stringify(block)
        ).join('\n'),
  }
}

/**
 * 将助手消息转换为 OpenAI 格式 - 继承自 openai.ts
 */
export function assistantMessageToMessageParam(
  message: AssistantMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  // 处理字符串内容
  if (typeof message.message.content === 'string') {
    return {
      role: 'assistant',
      content: message.message.content,
    }
  }

  // 处理数组内容
  if (Array.isArray(message.message.content)) {
    // 检查是否有工具调用
    const toolUses = message.message.content.filter((block: any) => block.type === 'tool_use')
    if (toolUses.length > 0) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: toolUses.map((toolUse: any) => ({
          id: toolUse.id,
          type: 'function',
          function: {
            name: toolUse.name,
            arguments: JSON.stringify(toolUse.input),
          },
        })),
      }
    }

    // 处理文本内容
    const textContent = message.message.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('')

    return {
      role: 'assistant',
      content: textContent,
    }
  }

  return {
    role: 'assistant',
    content: '',
  }
}

/**
 * 格式化系统提示词 - 继承自 openai.ts
 */
export function formatSystemPromptWithContext(
  systemPrompt: string[],
  context: { [k: string]: string },
): string {
  // 自动识别当前操作系统
  let osHint = ''
  if (typeof process !== 'undefined' && process.platform) {
    if (process.platform === 'win32') {
      osHint = `\n[Environment Notice]\nYou are running on a Windows system. Only use Windows shell commands (e.g., 'type' for file content, 'dir' for listing files). Do NOT use Linux commands like 'cat', 'ls', 'grep', 'echo' with Unix syntax, etc.`
    } else {
      osHint = `\n[Environment Notice]\nYou are running on a Unix/Linux system. Use bash/zsh shell commands. Avoid Windows-specific commands like 'dir' or 'type'.`
    }
  }
  if (Object.entries(context).length === 0) {
    return [
      ...systemPrompt,
      osHint,
    ].join('\n')
  }
  return [
    ...systemPrompt,
    osHint,
    `\nAs you answer the user's questions, you can use the following context:\n`,
    ...Object.entries(context).map(
      ([key, value]) => `<context name="${key}">${value}</context>`,
    ),
  ].join('\n')
}

/**
 * 查询 DeepSeek 模型 - 继承自 openai.ts 的 queryGPT
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
  debugLog(`🌐 [DEBUG] queryDeepSeek() function started`)
  debugLog(`📨 [DEBUG] Messages count: ${messages.length}`)
  debugLog(`📝 [DEBUG] System prompt items: ${systemPrompt.length}`)
  debugLog(`🤔 [DEBUG] Max thinking tokens: ${maxThinkingTokens}`)
  debugLog(`🔧 [DEBUG] Tools count: ${tools.length}`)
  debugLog(`🔐 [DEBUG] dangerouslySkipPermissions: ${options.dangerouslySkipPermissions}`)
  debugLog(`🤖 [DEBUG] Model: ${options.model}`)
  debugLog(`📋 [DEBUG] prependCLISysprompt: ${options.prependCLISysprompt}`)

  const deepseek = getDeepSeekClient(options.model)
  
  const system = options.prependCLISysprompt
    ? systemPrompt.join('\n')
    : systemPrompt.join('\n')

  const toolSchemas = tools.map(tool => {
    // 获取工具的schema - 工具可能使用inputSchema而不是schema
    let schema = (tool as any).schema;
    if (!schema && (tool as any).inputSchema) {
      schema = (tool as any).inputSchema;
    }
    
    // 如果schema是Zod schema，转换为JSON Schema
    if (schema && typeof schema === 'object' && schema._def) {
      schema = zodToJsonSchema(schema);
    }
    
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
        parameters: schema || { type: 'object', properties: {} }
      }
    };
  })
  
  debugLog(`🛠️ [DEBUG] Tool schemas count: ${toolSchemas.length}`)

  const messageParams = messages.map(m =>
    m.type === 'user'
      ? userMessageToMessageParam(m)
      : assistantMessageToMessageParam(m),
  )

  debugLog(`📨 [DEBUG] Message params count: ${messageParams.length}`)
  debugLog(`📊 [DEBUG] Total tokens estimate: ${JSON.stringify([system, ...messageParams, ...toolSchemas]).length}`)

  const startIncludingRetries = Date.now()
  let start = Date.now()
  let attemptNumber = 0
  let response
  
  debugLog(`🚀 [DEBUG] About to call deepseek.chat.completions.create...`)
  debugLog(`⏱️ [DEBUG] API call started at: ${new Date().toISOString()}`)
  
  try {
    response = await withRetry(async attempt => {
      attemptNumber = attempt
      start = Date.now()
      debugLog(`🔄 [DEBUG] API call attempt ${attempt} started`)
      
      debugLog(`🌐 [DEBUG] Calling deepseek.chat.completions.create with:`)
      debugLog(`   - Model: ${options.model}`)
      debugLog(`   - Max tokens: ${Math.max(maxThinkingTokens + 1, 4096)}`)
      debugLog(`   - Messages count: ${messageParams.length}`)
      debugLog(`   - Tools count: ${toolSchemas.length}`)
      
      const stream = await deepseek.chat.completions.create(
        {
          model: options.model,
          max_tokens: Math.max(maxThinkingTokens + 1, 4096),
          messages: [
            { role: 'system', content: system },
            ...messageParams
          ],
          temperature: 1,
          tools: toolSchemas.length > 0 ? toolSchemas : undefined,
          stream: true,
        },
        { signal },
      )
      
      debugLog(`✅ [DEBUG] deepseek.chat.completions.create call initiated successfully`)
      
      // 处理流式响应
      let finalResponse: any = null
      for await (const chunk of stream) {
        if (chunk.choices[0]?.delta) {
          if (!finalResponse) {
            finalResponse = {
              id: chunk.id,
              model: chunk.model,
              created: chunk.created,
              choices: [chunk.choices[0]],
              usage: chunk.usage,
            }
          } else {
            // 累积内容
            if (chunk.choices[0].delta.content) {
              if (!finalResponse.choices[0].message) {
                finalResponse.choices[0].message = { role: 'assistant', content: '' }
              }
              finalResponse.choices[0].message.content += chunk.choices[0].delta.content
            }
          }
        }
      }
      
      return finalResponse
    })
    
    debugLog(`✅ [DEBUG] API call completed successfully`)
    debugLog(`⏱️ [DEBUG] API call finished at: ${new Date().toISOString()}`)
  } catch (error) {
    debugLog(`❌ [DEBUG] API call failed: ${error}`)
    debugLog(error)
    return getAssistantMessageFromError(error)
  }
  
  const durationMs = Date.now() - start
  const durationMsIncludingRetries = Date.now() - startIncludingRetries
  
  debugLog(`📊 [DEBUG] API call statistics:`)
  debugLog(`   - Duration: ${durationMs}ms`)
  debugLog(`   - Duration including retries: ${durationMsIncludingRetries}ms`)
  debugLog(`   - Input tokens: ${response.usage?.prompt_tokens || 0}`)
  debugLog(`   - Output tokens: ${response.usage?.completion_tokens || 0}`)
  
  // 成本计算 - 使用 DeepSeek 定价
  const inputTokens = response.usage?.prompt_tokens || 0
  const outputTokens = response.usage?.completion_tokens || 0
  
  const costUSD = (inputTokens / 1_000_000) * DEEPSEEK_COST_PER_MILLION_INPUT_TOKENS +
                  (outputTokens / 1_000_000) * DEEPSEEK_COST_PER_MILLION_OUTPUT_TOKENS

  debugLog(`💰 [DEBUG] DeepSeek cost calculation: $${costUSD.toFixed(6)}`)
  
  // 转换为 AssistantMessage 格式
  const assistantMessage: AssistantMessage = {
    durationMs,
    message: {
      id: response.id,
      model: response.model,
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: response.choices[0]?.message?.content || '',
        }
      ],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    },
    costUSD,
    uuid: crypto.randomUUID(),
    type: 'assistant',
  }

  return assistantMessage
}

/**
 * 从错误创建助手消息 - 继承自 openai.ts
 */
function getAssistantMessageFromError(error: unknown): AssistantMessage {
  if (error instanceof Error && error.message.includes('prompt is too long')) {
    return createAssistantAPIErrorMessage(PROMPT_TOO_LONG_ERROR_MESSAGE)
  }
  if (error instanceof Error && error.message.includes('billing')) {
    return createAssistantAPIErrorMessage(CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE)
  }
  if (error instanceof Error && error.message.includes('api_key')) {
    return createAssistantAPIErrorMessage(INVALID_API_KEY_ERROR_MESSAGE)
  }
  if (error instanceof Error) {
    return createAssistantAPIErrorMessage(
      `${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
    )
  }
  return createAssistantAPIErrorMessage(API_ERROR_MESSAGE_PREFIX)
} 