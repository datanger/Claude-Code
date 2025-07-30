import OpenAI from 'openai'
import chalk from 'chalk'
import { randomUUID } from 'crypto'
import 'dotenv/config'

import { addToTotalCost } from '../cost-tracker.js'
import type { AssistantMessage, UserMessage } from '../query.js'
import { Tool } from '../Tool.js'
import { getOpenAIApiKey, getOrCreateUserID } from '../utils/config.js'
import { debugLog } from '../utils/log.js'
import { USER_AGENT } from '../utils/http.js'
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
} from '../utils/messages.js'
import { countTokens } from '../utils/tokens.js'
import { logEvent } from './statsig.js'
import { withVCR } from './vcr.js'
import { zodToJsonSchema } from 'zod-to-json-schema'

// OpenAI 成本计算 (每百万 token)
const GPT4_COST_PER_MILLION_INPUT_TOKENS = 30
const GPT4_COST_PER_MILLION_OUTPUT_TOKENS = 60
const GPT35_COST_PER_MILLION_INPUT_TOKENS = 0.5
const GPT35_COST_PER_MILLION_OUTPUT_TOKENS = 1.5

export const API_ERROR_MESSAGE_PREFIX = 'OpenAI API Error'
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
        `  ⎿  ${chalk.red(`OpenAI API ${error?.message || error} · Retrying in ${Math.round(delayMs / 1000)} seconds… (attempt ${attempt}/${maxRetries})`)}`,
      )

      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  throw lastError
}

export async function verifyOpenAIApiKey(apiKey: string): Promise<boolean> {
  const openai = new OpenAI({
    apiKey,
    maxRetries: 3,
  })

  try {
    await withRetry(async () => {
      await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'test' }],
      })
      return true
    }, { maxRetries: 2 })
    return true
  } catch (error) {
    debugLog(error)
    if (error?.status === 401) {
      return false
    }
    throw error
  }
}

let openaiClient: OpenAI | null = null

export function getOpenAIClient(model: string): OpenAI {
  const apiKey = getOpenAIApiKey()!
  const baseURL = process.env.OPENAI_API_BASE || 'https://api.openai.com'
  
  // 检查是否需要重新创建客户端（当环境变量改变时）
  if (openaiClient) {
    const currentConfig = {
      apiKey,
      baseURL,
    }
    
    // 如果配置没有改变，直接返回现有客户端
    if (openaiClient.apiKey === apiKey && 
        (!baseURL || openaiClient.baseURL === baseURL)) {
      return openaiClient
    }
    
    // 如果配置改变了，重置客户端
    debugLog(`🔄 [DEBUG] OpenAI configuration changed, recreating client`)
    openaiClient = null
  }
  
  const clientConfig: any = {
    apiKey,
    maxRetries: 3,
    dangerouslyAllowBrowser: true, // 添加这个选项解决环境警告
  }
  
  // 如果设置了baseURL，则添加到配置中
  if (baseURL) {
    clientConfig.baseURL = baseURL
    debugLog(`🔧 [DEBUG] Using OpenAI base URL: ${baseURL}`)
  }
  
  openaiClient = new OpenAI(clientConfig)
  return openaiClient
}

export function resetOpenAIClient(): void {
  openaiClient = null
}

function getMetadata() {
  return {
    user_id: `${getOrCreateUserID()}_${SESSION_ID}`,
  }
}

export function userMessageToMessageParam(
  message: UserMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  return {
    role: 'user',
    content: typeof message.message.content === 'string' 
      ? message.message.content 
      : message.message.content.map(block => 
          block.type === 'text' ? block.text : JSON.stringify(block)
        ).join('\n'),
  }
}

export function assistantMessageToMessageParam(
  message: AssistantMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  return {
    role: 'assistant',
    content: typeof message.message.content === 'string' 
      ? message.message.content 
      : message.message.content.map(block => 
          block.type === 'text' ? block.text : JSON.stringify(block)
        ).join('\n'),
  }
}

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

export async function queryGPT(
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
  debugLog(`🌐 [DEBUG] queryGPT() function started`)
  debugLog(`📨 [DEBUG] Messages count: ${messages.length}`)
  debugLog(`📝 [DEBUG] System prompt items: ${systemPrompt.length}`)
  debugLog(`🤔 [DEBUG] Max thinking tokens: ${maxThinkingTokens}`)
  debugLog(`🔧 [DEBUG] Tools count: ${tools.length}`)
  debugLog(`🔐 [DEBUG] dangerouslySkipPermissions: ${options.dangerouslySkipPermissions}`)
  debugLog(`🤖 [DEBUG] Model: ${options.model}`)
  debugLog(`📋 [DEBUG] prependCLISysprompt: ${options.prependCLISysprompt}`)

  const openai = getOpenAIClient(options.model)
  
  const system = options.prependCLISysprompt
    ? systemPrompt.join('\n')
    : systemPrompt.join('\n')

  const toolSchemas = tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.schema,
    }
  }))
  
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
  
  debugLog(`🚀 [DEBUG] About to call openai.chat.completions.create...`)
  debugLog(`⏱️ [DEBUG] API call started at: ${new Date().toISOString()}`)
  
  try {
    response = await withRetry(async attempt => {
      attemptNumber = attempt
      start = Date.now()
      debugLog(`🔄 [DEBUG] API call attempt ${attempt} started`)
      
      debugLog(`🌐 [DEBUG] Calling openai.chat.completions.create with:`)
      debugLog(`   - Model: ${options.model}`)
      debugLog(`   - Max tokens: ${Math.max(maxThinkingTokens + 1, 4096)}`)
      debugLog(`   - Messages count: ${messageParams.length}`)
      debugLog(`   - Tools count: ${toolSchemas.length}`)
      
      const stream = await openai.chat.completions.create(
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
      
      debugLog(`✅ [DEBUG] openai.chat.completions.create call initiated successfully`)
      
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
  
  // 成本计算
  const inputTokens = response.usage?.prompt_tokens || 0
  const outputTokens = response.usage?.completion_tokens || 0
  
  const isGPT4 = options.model.includes('gpt-4')
  const costUSD = isGPT4
    ? (inputTokens / 1_000_000) * GPT4_COST_PER_MILLION_INPUT_TOKENS +
      (outputTokens / 1_000_000) * GPT4_COST_PER_MILLION_OUTPUT_TOKENS
    : (inputTokens / 1_000_000) * GPT35_COST_PER_MILLION_INPUT_TOKENS +
      (outputTokens / 1_000_000) * GPT35_COST_PER_MILLION_OUTPUT_TOKENS

  debugLog(`💰 [DEBUG] Cost calculation: $${costUSD.toFixed(6)}`)
  addToTotalCost(costUSD, durationMsIncludingRetries)

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
    uuid: randomUUID(),
    type: 'assistant',
  }

  return assistantMessage
}

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