import type { AssistantMessage, UserMessage } from '../query.js'
import { Tool } from '../Tool.js'
import { getProviderConfig, type LLMProvider } from '../utils/provider.js'
import { querySonnet } from './claude.js'
import { queryGPT } from './openai.js'
import { queryDeepSeek } from './deepseek.js'
import { queryLocalModel } from './local_model.js'
import { debugLog } from '../utils/log.js'

export interface LLMQueryOptions {
  dangerouslySkipPermissions: boolean
  model: string
  prependCLISysprompt: boolean
}

/**
 * 统一的 LLM 查询接口
 * 根据模型名称自动选择使用哪个提供商
 */
export async function queryLLM(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[],
  maxThinkingTokens: number,
  tools: Tool[],
  signal: AbortSignal,
  options: LLMQueryOptions,
): Promise<AssistantMessage> {
  debugLog(`🚀 [DEBUG] queryLLM - Starting with model: ${options.model}`)
  debugLog(`🚀 [DEBUG] queryLLM - Messages count: ${messages.length}`)
  debugLog(`🚀 [DEBUG] queryLLM - System prompt items: ${systemPrompt.length}`)
  debugLog(`🚀 [DEBUG] queryLLM - Tools count: ${tools.length}`)
  
  const providerConfig = getProviderConfig(options.model)
  debugLog(`🔍 [DEBUG] queryLLM - Provider config:`, {
    provider: providerConfig.provider,
    model: providerConfig.model,
    skipPermissions: providerConfig.skipPermissions
  })
  
  // 根据提供商选择对应的查询函数
  switch (providerConfig.provider) {
    case 'openai':
      debugLog(`✅ [DEBUG] queryLLM - Routing to queryGPT`)
      return await queryGPT(
        messages,
        systemPrompt,
        maxThinkingTokens,
        tools,
        signal,
        {
          ...options,
          dangerouslySkipPermissions: providerConfig.skipPermissions || options.dangerouslySkipPermissions,
        }
      )
    
    case 'local':
      debugLog(`✅ [DEBUG] queryLLM - Routing to queryLocalModel`)
      return await queryLocalModel(
        messages,
        systemPrompt,
        maxThinkingTokens,
        tools,
        signal,
        {
          ...options,
          dangerouslySkipPermissions: providerConfig.skipPermissions || options.dangerouslySkipPermissions,
        },
      )

    case 'deepseek':
      debugLog(`✅ [DEBUG] queryLLM - Routing to queryDeepSeek`)
      return await queryDeepSeek(
        messages,
        systemPrompt,
        maxThinkingTokens,
        tools,
        signal,
        {
          ...options,
          dangerouslySkipPermissions: providerConfig.skipPermissions || options.dangerouslySkipPermissions,
        }
      )
    
    case 'anthropic':
    default:
      debugLog(`✅ [DEBUG] queryLLM - Routing to querySonnet`)
      return await querySonnet(
        messages,
        systemPrompt,
        maxThinkingTokens,
        tools,
        signal,
        {
          ...options,
          dangerouslySkipPermissions: providerConfig.skipPermissions || options.dangerouslySkipPermissions,
        }
      )
  }
}

/**
 * 验证 API Key 是否有效
 */
export async function verifyApiKey(apiKey: string, provider: LLMProvider): Promise<boolean> {
  switch (provider) {
    case 'openai':
      const { verifyOpenAIApiKey } = await import('./openai.js')
      return await verifyOpenAIApiKey(apiKey)
    
    case 'local':
      return true

    case 'deepseek':
      const { verifyDeepSeekApiKey } = await import('./deepseek.js')
      return await verifyDeepSeekApiKey(apiKey)
    
    case 'anthropic':
    default:
      const { verifyApiKey: verifyAnthropicApiKey } = await import('./claude.js')
      return await verifyAnthropicApiKey(apiKey)
  }
}

/**
 * 获取客户端实例
 */
export function getLLMClient(model: string) {
  const providerConfig = getProviderConfig(model)
  
  switch (providerConfig.provider) {
    case 'openai':
      const { getOpenAIClient } = require('./openai.js')
      return getOpenAIClient(model)
    
    case 'local':
      return null

    case 'deepseek':
      const { getDeepSeekClient } = require('./deepseek.js')
      return getDeepSeekClient(model)
    
    case 'anthropic':
    default:
      const { getAnthropicClient } = require('./claude.js')
      return getAnthropicClient(model)
  }
} 