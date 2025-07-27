import '@anthropic-ai/sdk/shims/node'
import Anthropic, { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk'
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import chalk from 'chalk'
import { createHash, randomUUID } from 'crypto'
import 'dotenv/config'
import { getBetas } from '../utils/betas.js'

import { addToTotalCost } from '../cost-tracker.js'
import type { AssistantMessage, UserMessage } from '../query.js'
import { Tool } from '../Tool.js'
import { getAnthropicApiKey, getOrCreateUserID } from '../utils/config.js'
import { logError, SESSION_ID, debugLog } from '../utils/log.js'
import { USER_AGENT } from '../utils/http.js'
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
} from '../utils/messages.js'
import { countTokens } from '../utils/tokens.js'
import { logEvent } from './statsig.js'
import { withVCR } from './vcr.js'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { BetaMessageStream } from '@anthropic-ai/sdk/lib/BetaMessageStream.mjs'
import type {
  Message as APIMessage,
  MessageParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { SMALL_FAST_MODEL, USE_BEDROCK, USE_VERTEX } from '../utils/model.js'
import { getCLISyspromptPrefix } from '../constants/prompts.js'
import { getVertexRegionForModel } from '../utils/model.js'

interface StreamResponse extends APIMessage {
  ttftMs?: number
}

export const API_ERROR_MESSAGE_PREFIX = 'API Error'
export const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'
export const CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE = 'Credit balance is too low'
export const INVALID_API_KEY_ERROR_MESSAGE =
  'Invalid API key · Please run /login'
export const NO_CONTENT_MESSAGE = '(no content)'
const PROMPT_CACHING_ENABLED = !process.env.DISABLE_PROMPT_CACHING

// @see https://docs.anthropic.com/en/docs/about-claude/models#model-comparison-table
const HAIKU_COST_PER_MILLION_INPUT_TOKENS = 0.8
const HAIKU_COST_PER_MILLION_OUTPUT_TOKENS = 4
const HAIKU_COST_PER_MILLION_PROMPT_CACHE_WRITE_TOKENS = 1
const HAIKU_COST_PER_MILLION_PROMPT_CACHE_READ_TOKENS = 0.08

const SONNET_COST_PER_MILLION_INPUT_TOKENS = 3
const SONNET_COST_PER_MILLION_OUTPUT_TOKENS = 15
const SONNET_COST_PER_MILLION_PROMPT_CACHE_WRITE_TOKENS = 3.75
const SONNET_COST_PER_MILLION_PROMPT_CACHE_READ_TOKENS = 0.3

export const MAIN_QUERY_TEMPERATURE = 1 // to get more variation for binary feedback

function getMetadata() {
  return {
    user_id: `${getOrCreateUserID()}_${SESSION_ID}`,
  }
}

const MAX_RETRIES = process.env.USER_TYPE === 'SWE_BENCH' ? 100 : 10
const BASE_DELAY_MS = 500

interface RetryOptions {
  maxRetries?: number
}

function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 32000) // Max 32s delay
}

function shouldRetry(error: APIError): boolean {
  // Check for overloaded errors first and only retry for SWE_BENCH
  if (error.message?.includes('"type":"overloaded_error"')) {
    return process.env.USER_TYPE === 'SWE_BENCH'
  }

  // Note this is not a standard header.
  const shouldRetryHeader = error.headers?.['x-should-retry']

  // If the server explicitly says whether or not to retry, obey.
  if (shouldRetryHeader === 'true') return true
  if (shouldRetryHeader === 'false') return false

  if (error instanceof APIConnectionError) {
    return true
  }

  if (!error.status) return false

  // Retry on request timeouts.
  if (error.status === 408) return true

  // Retry on lock timeouts.
  if (error.status === 409) return true

  // Retry on rate limits.
  if (error.status === 429) return true

  // Retry internal errors.
  if (error.status && error.status >= 500) return true

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

      // Only retry if the error indicates we should
      if (
        attempt > maxRetries ||
        !(error instanceof APIError) ||
        !shouldRetry(error)
      ) {
        throw error
      }
      // Get retry-after header if available
      const retryAfter = error.headers?.['retry-after'] ?? null
      const delayMs = getRetryDelay(attempt, retryAfter)

      console.log(
        `  ⎿  ${chalk.red(`API ${error.name} (${error.message}) · Retrying in ${Math.round(delayMs / 1000)} seconds… (attempt ${attempt}/${maxRetries})`)}`,
      )

      logEvent('tengu_api_retry', {
        attempt: String(attempt),
        delayMs: String(delayMs),
        error: error.message,
        status: String(error.status),
        provider: USE_BEDROCK ? 'bedrock' : USE_VERTEX ? 'vertex' : '1p',
      })

      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  throw lastError
}

export async function verifyApiKey(apiKey: string): Promise<boolean> {
  const anthropic = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: 3,
    defaultHeaders: {
      'User-Agent': USER_AGENT,
    },
  })

  try {
    await withRetry(
      async () => {
        const model = SMALL_FAST_MODEL
        const messages: MessageParam[] = [{ role: 'user', content: 'test' }]
        await anthropic.messages.create({
          model,
          max_tokens: 1,
          messages,
          temperature: 0,
          metadata: getMetadata(),
        })
        return true
      },
      { maxRetries: 2 }, // Use fewer retries for API key verification
    )
    return true
  } catch (error) {
    logError(error)
    // Check for authentication error
    if (
      error instanceof Error &&
      error.message.includes(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      )
    ) {
      return false
    }
    throw error
  }
}

async function handleMessageStream(
  stream: BetaMessageStream,
): Promise<StreamResponse> {
  const streamStartTime = Date.now()
  let ttftMs: number | undefined

  // TODO(ben): Consider showing an incremental progress indicator.
  for await (const part of stream) {
    if (part.type === 'message_start') {
      ttftMs = Date.now() - streamStartTime
    }
  }

  const finalResponse = await stream.finalMessage()
  
  // 添加错误处理，确保 finalResponse 不为 undefined
  if (!finalResponse) {
    throw new Error('Stream finalMessage() returned undefined')
  }
  
  return {
    ...finalResponse,
    ttftMs,
  }
}

let anthropicClient: Anthropic | null = null

/**
 * Get the Anthropic client, creating it if it doesn't exist
 */
export function getAnthropicClient(model?: string): Anthropic {
  if (anthropicClient) {
    return anthropicClient
  }

  const region = getVertexRegionForModel(model)

  const defaultHeaders: { [key: string]: string } = {
    'x-app': 'cli',
    'User-Agent': USER_AGENT,
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    defaultHeaders['Authorization'] =
      `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`
  }

  const ARGS = {
    defaultHeaders,
    maxRetries: 0, // Disabled auto-retry in favor of manual implementation
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(60 * 1000), 10),
  }
  if (USE_BEDROCK) {
    const client = new AnthropicBedrock(ARGS)
    anthropicClient = client
    return client
  }
  if (USE_VERTEX) {
    const vertexArgs = {
      ...ARGS,
      region: region || process.env.CLOUD_ML_REGION || 'us-east5',
    }
    const client = new AnthropicVertex(vertexArgs)
    anthropicClient = client
    return client
  }

  const apiKey = getAnthropicApiKey()
  if (process.env.USER_TYPE === 'ant' && !apiKey) {
    console.error(
      chalk.red(
        '[ANT-ONLY] Please set the ANTHROPIC_API_KEY environment variable to use the CLI. To create a new key, go to https://console.anthropic.com/settings/keys.',
      ),
    )
  }
  anthropicClient = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
    ...ARGS,
  })
  return anthropicClient
}

/**
 * Reset the Anthropic client to null, forcing a new client to be created on next use
 */
export function resetAnthropicClient(): void {
  anthropicClient = null
}

/**
 * Environment variables for different client types:
 *
 * Direct API:
 * - ANTHROPIC_API_KEY: Required for direct API access
 *
 * AWS Bedrock:
 * - AWS credentials configured via aws-sdk defaults
 *
 * Vertex AI:
 * - Model-specific region variables (highest priority):
 *   - VERTEX_REGION_CLAUDE_3_5_HAIKU: Region for Claude 3.5 Haiku model
 *   - VERTEX_REGION_CLAUDE_3_5_SONNET: Region for Claude 3.5 Sonnet model
 *   - VERTEX_REGION_CLAUDE_3_7_SONNET: Region for Claude 3.7 Sonnet model
 * - CLOUD_ML_REGION: Optional. The default GCP region to use for all models
 *   If specific model region not specified above
 * - ANTHROPIC_VERTEX_PROJECT_ID: Required. Your GCP project ID
 * - Standard GCP credentials configured via google-auth-library
 *
 * Priority for determining region:
 * 1. Hardcoded model-specific environment variables
 * 2. Global CLOUD_ML_REGION variable
 * 3. Default region from config
 * 4. Fallback region (us-east5)
 */

export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(PROMPT_CACHING_ENABLED
              ? { cache_control: { type: 'ephemeral' } }
              : {}),
          },
        ],
      }
    } else {
      return {
        role: 'user',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1
            ? PROMPT_CACHING_ENABLED
              ? { cache_control: { type: 'ephemeral' } }
              : {}
            : {}),
        })),
      }
    }
  }
  return {
    role: 'user',
    content: message.message.content,
  }
}

export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(PROMPT_CACHING_ENABLED
              ? { cache_control: { type: 'ephemeral' } }
              : {}),
          },
        ],
      }
    } else {
      return {
        role: 'assistant',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1 &&
          _.type !== 'thinking' &&
          _.type !== 'redacted_thinking'
            ? PROMPT_CACHING_ENABLED
              ? { cache_control: { type: 'ephemeral' } }
              : {}
            : {}),
        })),
      }
    }
  }
  return {
    role: 'assistant',
    content: message.message.content,
  }
}

function splitSysPromptPrefix(systemPrompt: string[]): string[] {
  // split out the first block of the system prompt as the "prefix" for API
  // to match on in https://console.statsig.com/4aF3Ewatb6xPVpCwxb5nA3/dynamic_configs/claude_cli_system_prompt_prefixes
  const systemPromptFirstBlock = systemPrompt[0] || ''
  const systemPromptRest = systemPrompt.slice(1)
  return [systemPromptFirstBlock, systemPromptRest.join('\n')].filter(Boolean)
}

export async function querySonnet(
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
  debugLog(`🌐 [DEBUG] querySonnet() function started`)
  debugLog(`📨 [DEBUG] Messages count: ${messages.length}`)
  debugLog(`📝 [DEBUG] System prompt items: ${systemPrompt.length}`)
  debugLog(`🤔 [DEBUG] Max thinking tokens: ${maxThinkingTokens}`)
  debugLog(`🔧 [DEBUG] Tools count: ${tools.length}`)
  debugLog(`🔐 [DEBUG] dangerouslySkipPermissions: ${options.dangerouslySkipPermissions}`)
  debugLog(`🤖 [DEBUG] Model: ${options.model}`)
  debugLog(`📋 [DEBUG] prependCLISysprompt: ${options.prependCLISysprompt}`)

  return querySonnetWithPromptCaching(
    messages,
    systemPrompt,
    maxThinkingTokens,
    tools,
    signal,
    options,
  )
}

export function formatSystemPromptWithContext(
  systemPrompt: string[],
  context: { [k: string]: string },
): string[] {
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
    ]
  }

  return [
    ...systemPrompt,
    osHint,
    `\nAs you answer the user's questions, you can use the following context:\n`,
    ...Object.entries(context).map(
      ([key, value]) => `<context name="${key}">${value}</context>`,
    ),
  ]
}

async function querySonnetWithPromptCaching(
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
  debugLog(`🔄 [DEBUG] querySonnetWithPromptCaching() started`)
  
  const anthropic = getAnthropicClient(options.model)
  const useBetas = process.env.USER_TYPE === 'ant'
  const betas = useBetas ? ['messages-2024-01-08'] : []

  const system = options.prependCLISysprompt
    ? splitSysPromptPrefix(systemPrompt)
    : systemPrompt

  const toolSchemas = tools.map(t => t.schema)
  debugLog(`🛠️ [DEBUG] Tool schemas count: ${toolSchemas.length}`)

  const messageParams = messages.map(m =>
    m.type === 'user'
      ? userMessageToMessageParam(m, true)
      : assistantMessageToMessageParam(m, true),
  )

  debugLog(`📨 [DEBUG] Message params count: ${messageParams.length}`)
  debugLog(`📊 [DEBUG] Total tokens estimate: ${JSON.stringify([...system, ...messageParams, ...toolSchemas]).length}`)

  const startIncludingRetries = Date.now()
  let start = Date.now()
  let attemptNumber = 0
  let response
  let stream: BetaMessageStream | undefined = undefined
  
  debugLog(`🚀 [DEBUG] About to call anthropic.beta.messages.stream...`)
  debugLog(`⏱️ [DEBUG] API call started at: ${new Date().toISOString()}`)
  
  try {
    response = await withRetry(async attempt => {
      attemptNumber = attempt
      start = Date.now()
      debugLog(`🔄 [DEBUG] API call attempt ${attempt} started`)
      
      debugLog(`🌐 [DEBUG] Calling anthropic.beta.messages.stream with:`)
      debugLog(`   - Model: ${options.model}`)
      debugLog(`   - Max tokens: ${Math.max(maxThinkingTokens + 1, getMaxTokensForModel(options.model))}`)
      debugLog(`   - Messages count: ${messageParams.length}`)
      debugLog(`   - Tools count: ${toolSchemas.length}`)
      debugLog(`   - System prompt items: ${system.length}`)
      
      const s = anthropic.beta.messages.stream(
        {
          model: options.model,
          max_tokens: Math.max(
            maxThinkingTokens + 1,
            getMaxTokensForModel(options.model),
          ),
          messages: addCacheBreakpoints(messageParams),
          temperature: MAIN_QUERY_TEMPERATURE,
          system,
          tools: toolSchemas,
          ...(useBetas ? { betas } : {}),
          metadata: getMetadata(),
          ...(process.env.USER_TYPE === 'ant' && maxThinkingTokens > 0
            ? {
                thinking: {
                  budget_tokens: maxThinkingTokens,
                  type: 'enabled',
                },
              }
            : {}),
        },
        { signal },
      )
      stream = s
      debugLog(`✅ [DEBUG] anthropic.beta.messages.stream call initiated successfully`)
      return handleMessageStream(s)
    })
    debugLog(`✅ [DEBUG] API call completed successfully`)
    debugLog(`⏱️ [DEBUG] API call finished at: ${new Date().toISOString()}`)
  } catch (error) {
    debugLog(`❌ [DEBUG] API call failed: ${error}`)
    logError(error)
    logEvent('tengu_api_error', {
      model: options.model,
      error: error instanceof Error ? error.message : String(error),
      status: error instanceof APIError ? String(error.status) : undefined,
      messageCount: String(messages.length),
      messageTokens: String(countTokens(messages)),
      durationMs: String(Date.now() - start),
      durationMsIncludingRetries: String(Date.now() - startIncludingRetries),
      attempt: String(attemptNumber),
      provider: USE_BEDROCK ? 'bedrock' : USE_VERTEX ? 'vertex' : '1p',
      requestId:
        (stream as BetaMessageStream | undefined)?.request_id ?? undefined,
    })
    return getAssistantMessageFromError(error)
  }
  
  const durationMs = Date.now() - start
  const durationMsIncludingRetries = Date.now() - startIncludingRetries
  
  debugLog(`📊 [DEBUG] API call statistics:`)
  debugLog(`   - Duration: ${durationMs}ms`)
  debugLog(`   - Duration including retries: ${durationMsIncludingRetries}ms`)
  debugLog(`   - Input tokens: ${response.usage.input_tokens}`)
  debugLog(`   - Output tokens: ${response.usage.output_tokens}`)
  debugLog(`   - Stop reason: ${response.stop_reason}`)
  
  logEvent('tengu_api_success', {
    model: options.model,
    messageCount: String(messages.length),
    messageTokens: String(countTokens(messages)),
    inputTokens: String(response.usage.input_tokens),
    outputTokens: String(response.usage.output_tokens),
    cachedInputTokens: String(
      (response.usage as BetaUsage).cache_read_input_tokens ?? 0,
    ),
    uncachedInputTokens: String(
      (response.usage as BetaUsage).cache_creation_input_tokens ?? 0,
    ),
    durationMs: String(durationMs),
    durationMsIncludingRetries: String(durationMsIncludingRetries),
    attempt: String(attemptNumber),
    ttftMs: String(response.ttftMs),
    provider: USE_BEDROCK ? 'bedrock' : USE_VERTEX ? 'vertex' : '1p',
    requestId:
      (stream as BetaMessageStream | undefined)?.request_id ?? undefined,
    stop_reason: response.stop_reason ?? undefined,
  })

  const inputTokens = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens
  const cacheReadInputTokens =
    (response.usage as BetaUsage).cache_read_input_tokens ?? 0
  const cacheCreationInputTokens =
    (response.usage as BetaUsage).cache_creation_input_tokens ?? 0
  const costUSD =
    (inputTokens / 1_000_000) * SONNET_COST_PER_MILLION_INPUT_TOKENS +
    (outputTokens / 1_000_000) * SONNET_COST_PER_MILLION_OUTPUT_TOKENS +
    (cacheReadInputTokens / 1_000_000) *
      SONNET_COST_PER_MILLION_PROMPT_CACHE_READ_TOKENS +
    (cacheCreationInputTokens / 1_000_000) *
      SONNET_COST_PER_MILLION_PROMPT_CACHE_WRITE_TOKENS

  debugLog(`💰 [DEBUG] Cost calculation: $${costUSD.toFixed(6)}`)
  addToTotalCost(costUSD, durationMsIncludingRetries)

  return response
}

function getAssistantMessageFromError(error: unknown): AssistantMessage {
  if (error instanceof Error && error.message.includes('prompt is too long')) {
    return createAssistantAPIErrorMessage(PROMPT_TOO_LONG_ERROR_MESSAGE)
  }
  if (
    error instanceof Error &&
    error.message.includes('Your credit balance is too low')
  ) {
    return createAssistantAPIErrorMessage(CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE)
  }
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('x-api-key')
  ) {
    return createAssistantAPIErrorMessage(INVALID_API_KEY_ERROR_MESSAGE)
  }
  if (error instanceof Error) {
    return createAssistantAPIErrorMessage(
      `${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
    )
  }
  return createAssistantAPIErrorMessage(API_ERROR_MESSAGE_PREFIX)
}

function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
): MessageParam[] {
  return messages.map((msg, index) => {
    return msg.type === 'user'
      ? userMessageToMessageParam(msg, index > messages.length - 3)
      : assistantMessageToMessageParam(msg, index > messages.length - 3)
  })
}

async function queryHaikuWithPromptCaching({
  systemPrompt,
  userPrompt,
  assistantPrompt,
  signal,
}: {
  systemPrompt: string[]
  userPrompt: string
  assistantPrompt?: string
  signal?: AbortSignal
}): Promise<AssistantMessage> {
  const anthropic = await getAnthropicClient(SMALL_FAST_MODEL)
  const model = SMALL_FAST_MODEL
  const messages = [
    {
      role: 'user' as const,
      content: userPrompt,
    },
    ...(assistantPrompt
      ? [{ role: 'assistant' as const, content: assistantPrompt }]
      : []),
  ]

  const system: TextBlockParam[] = splitSysPromptPrefix(systemPrompt).map(
    _ => ({
      ...(PROMPT_CACHING_ENABLED
        ? { cache_control: { type: 'ephemeral' } }
        : {}),
      text: _,
      type: 'text',
    }),
  )

  logEvent('tengu_api_query', {
    model,
    messagesLength: String(JSON.stringify([...system, ...messages]).length),
    provider: USE_BEDROCK ? 'bedrock' : USE_VERTEX ? 'vertex' : '1p',
  })
  let attemptNumber = 0
  let start = Date.now()
  const startIncludingRetries = Date.now()
  let response: StreamResponse
  let stream: BetaMessageStream | undefined = undefined
  try {
    response = await withRetry(async attempt => {
      attemptNumber = attempt
      start = Date.now()
      const s = anthropic.beta.messages.stream(
        {
          model,
          max_tokens: 512,
          messages,
          system,
          temperature: 0,
          metadata: getMetadata(),
          stream: true,
        },
        { signal },
      )
      stream = s
      return await handleMessageStream(s)
    })
  } catch (error) {
    logError(error)
    logEvent('tengu_api_error', {
      error: error instanceof Error ? error.message : String(error),
      status: error instanceof APIError ? String(error.status) : undefined,
      model: SMALL_FAST_MODEL,
      messageCount: String(assistantPrompt ? 2 : 1),
      durationMs: String(Date.now() - start),
      durationMsIncludingRetries: String(Date.now() - startIncludingRetries),
      attempt: String(attemptNumber),
      provider: USE_BEDROCK ? 'bedrock' : USE_VERTEX ? 'vertex' : '1p',
      requestId:
        (stream as BetaMessageStream | undefined)?.request_id ?? undefined,
    })
    return getAssistantMessageFromError(error)
  }

  const inputTokens = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens
  const cacheReadInputTokens = response.usage.cache_read_input_tokens ?? 0
  const cacheCreationInputTokens =
    response.usage.cache_creation_input_tokens ?? 0
  const costUSD =
    (inputTokens / 1_000_000) * HAIKU_COST_PER_MILLION_INPUT_TOKENS +
    (outputTokens / 1_000_000) * HAIKU_COST_PER_MILLION_OUTPUT_TOKENS +
    (cacheReadInputTokens / 1_000_000) *
      HAIKU_COST_PER_MILLION_PROMPT_CACHE_READ_TOKENS +
    (cacheCreationInputTokens / 1_000_000) *
      HAIKU_COST_PER_MILLION_PROMPT_CACHE_WRITE_TOKENS

  const durationMs = Date.now() - start
  const durationMsIncludingRetries = Date.now() - startIncludingRetries
  addToTotalCost(costUSD, durationMsIncludingRetries)

  const assistantMessage: AssistantMessage = {
    durationMs,
    message: {
      ...response,
      content: normalizeContentFromAPI(response.content),
    },
    costUSD,
    uuid: randomUUID(),
    type: 'assistant',
  }

  logEvent('tengu_api_success', {
    model: SMALL_FAST_MODEL,
    messageCount: String(assistantPrompt ? 2 : 1),
    inputTokens: String(inputTokens),
    outputTokens: String(response.usage.output_tokens),
    cachedInputTokens: String(response.usage.cache_read_input_tokens ?? 0),
    uncachedInputTokens: String(
      response.usage.cache_creation_input_tokens ?? 0,
    ),
    durationMs: String(durationMs),
    durationMsIncludingRetries: String(durationMsIncludingRetries),
    ttftMs: String(response.ttftMs),
    provider: USE_BEDROCK ? 'bedrock' : USE_VERTEX ? 'vertex' : '1p',
    requestId:
      (stream as BetaMessageStream | undefined)?.request_id ?? undefined,
    stop_reason: response.stop_reason ?? undefined,
  })

  return assistantMessage
}

async function queryHaikuWithoutPromptCaching({
  systemPrompt,
  userPrompt,
  assistantPrompt,
  signal,
}: {
  systemPrompt: string[]
  userPrompt: string
  assistantPrompt?: string
  signal?: AbortSignal
}): Promise<AssistantMessage> {
  const anthropic = await getAnthropicClient(SMALL_FAST_MODEL)
  const model = SMALL_FAST_MODEL
  const messages = [
    { role: 'user' as const, content: userPrompt },
    ...(assistantPrompt
      ? [{ role: 'assistant' as const, content: assistantPrompt }]
      : []),
  ]
  logEvent('tengu_api_query', {
    model,
    messagesLength: String(
      JSON.stringify([{ systemPrompt }, ...messages]).length,
    ),
    provider: USE_BEDROCK ? 'bedrock' : USE_VERTEX ? 'vertex' : '1p',
  })

  let attemptNumber = 0
  let start = Date.now()
  const startIncludingRetries = Date.now()
  let response: StreamResponse
  let stream: BetaMessageStream | undefined = undefined
  try {
    response = await withRetry(async attempt => {
      attemptNumber = attempt
      start = Date.now()
      const s = anthropic.beta.messages.stream(
        {
          model,
          max_tokens: 512,
          messages,
          system: splitSysPromptPrefix(systemPrompt).map(text => ({
            type: 'text',
            text,
          })),
          temperature: 0,
          metadata: getMetadata(),
          stream: true,
        },
        { signal },
      )
      stream = s
      return await handleMessageStream(s)
    })
  } catch (error) {
    logError(error)
    logEvent('tengu_api_error', {
      error: error instanceof Error ? error.message : String(error),
      status: error instanceof APIError ? String(error.status) : undefined,
      model: SMALL_FAST_MODEL,
      messageCount: String(assistantPrompt ? 2 : 1),
      durationMs: String(Date.now() - start),
      durationMsIncludingRetries: String(Date.now() - startIncludingRetries),
      attempt: String(attemptNumber),
      provider: USE_BEDROCK ? 'bedrock' : USE_VERTEX ? 'vertex' : '1p',
      requestId:
        (stream as BetaMessageStream | undefined)?.request_id ?? undefined,
    })
    return getAssistantMessageFromError(error)
  }
  const durationMs = Date.now() - start
  const durationMsIncludingRetries = Date.now() - startIncludingRetries
  logEvent('tengu_api_success', {
    model: SMALL_FAST_MODEL,
    messageCount: String(assistantPrompt ? 2 : 1),
    inputTokens: String(response.usage.input_tokens),
    outputTokens: String(response.usage.output_tokens),
    durationMs: String(durationMs),
    durationMsIncludingRetries: String(durationMsIncludingRetries),
    attempt: String(attemptNumber),
    provider: USE_BEDROCK ? 'bedrock' : USE_VERTEX ? 'vertex' : '1p',
    requestId:
      (stream as BetaMessageStream | undefined)?.request_id ?? undefined,
    stop_reason: response.stop_reason ?? undefined,
  })

  const inputTokens = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens
  const costUSD =
    (inputTokens / 1_000_000) * HAIKU_COST_PER_MILLION_INPUT_TOKENS +
    (outputTokens / 1_000_000) * HAIKU_COST_PER_MILLION_OUTPUT_TOKENS

  addToTotalCost(costUSD, durationMs)

  const assistantMessage: AssistantMessage = {
    durationMs,
    message: {
      ...response,
      content: normalizeContentFromAPI(response.content),
      usage: {
        ...response.usage,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    costUSD,
    type: 'assistant',
    uuid: randomUUID(),
  }

  return assistantMessage
}

export async function queryHaiku({
  systemPrompt = [],
  userPrompt,
  assistantPrompt,
  enablePromptCaching = false,
  signal,
}: {
  systemPrompt: string[]
  userPrompt: string
  assistantPrompt?: string
  enablePromptCaching?: boolean
  signal?: AbortSignal
}): Promise<AssistantMessage> {
  return await withVCR(
    [
      {
        message: {
          role: 'user',
          content: systemPrompt.map(text => ({ type: 'text', text })),
        },
        type: 'user',
        uuid: randomUUID(),
      },
      {
        message: { role: 'user', content: userPrompt },
        type: 'user',
        uuid: randomUUID(),
      },
    ],
    () => {
      return enablePromptCaching
        ? queryHaikuWithPromptCaching({
            systemPrompt,
            userPrompt,
            assistantPrompt,
            signal,
          })
        : queryHaikuWithoutPromptCaching({
            systemPrompt,
            userPrompt,
            assistantPrompt,
            signal,
          })
    },
  )
}

function getMaxTokensForModel(model: string): number {
  if (model.includes('3-5')) {
    return 8192
  }
  if (model.includes('haiku')) {
    return 8192
  }
  return 20_000
}
