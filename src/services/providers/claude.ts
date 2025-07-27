import { AIProvider, ProviderConfig, GenerateContentRequest, GenerateContentResponse, StreamResponse } from './base.js'
import { querySonnet, queryHaiku, getAnthropicClient, verifyApiKey as verifyClaudeApiKey } from '../claude.js'
import { addToTotalCost } from '../../cost-tracker.js'
import { formatSystemPromptWithContext } from '../claude.js'
import { logError } from '../../utils/log.js'

export class ClaudeProvider implements AIProvider {
  name = 'claude'
  models = ['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307', 'claude-3-opus-20240229']
  
  private config: ProviderConfig = {
    apiKey: undefined,
    baseUrl: undefined,
    model: 'claude-3-5-sonnet-20241022',
    temperature: 1,
    maxTokens: 4096
  }

  constructor(config?: Partial<ProviderConfig>) {
    if (config) {
      this.setConfig(config)
    }
  }

  async verifyApiKey(apiKey: string): Promise<boolean> {
    return await verifyClaudeApiKey(apiKey)
  }

  async generateContent(request: GenerateContentRequest): Promise<GenerateContentResponse> {
    const startTime = Date.now()
    
    try {
      const systemPrompt = request.options.prependCLISysprompt 
        ? formatSystemPromptWithContext(request.systemPrompt, {})
        : request.systemPrompt

      const assistantMessage = await querySonnet(
        request.messages,
        systemPrompt,
        0, // maxThinkingTokens
        request.tools,
        request.signal,
        {
          dangerouslySkipPermissions: request.options.dangerouslySkipPermissions,
          model: request.options.model || this.config.model || 'claude-3-5-sonnet-20241022',
          prependCLISysprompt: false // 已经在上面处理了
        }
      )

      const durationMs = Date.now() - startTime
      
      return {
        content: assistantMessage.message.content[0]?.text || '',
        costUSD: assistantMessage.costUSD,
        durationMs,
        usage: {
          promptTokens: 0, // Claude API 不直接提供token计数
          completionTokens: 0,
          totalTokens: 0
        }
      }
    } catch (error) {
      logError('Claude provider error', error)
      throw error
    }
  }

  async *generateContentStream(request: GenerateContentRequest): AsyncGenerator<StreamResponse> {
    const startTime = Date.now()
    let accumulatedContent = ''
    let totalCost = 0

    try {
      const systemPrompt = request.options.prependCLISysprompt 
        ? formatSystemPromptWithContext(request.systemPrompt, {})
        : request.systemPrompt

      // 注意：这里需要修改querySonnet来支持流式输出
      // 目前claude.ts中的querySonnet不是流式的，需要重构
      const assistantMessage = await querySonnet(
        request.messages,
        systemPrompt,
        0,
        request.tools,
        request.signal,
        {
          dangerouslySkipPermissions: request.options.dangerouslySkipPermissions,
          model: request.options.model || this.config.model || 'claude-3-5-sonnet-20241022',
          prependCLISysprompt: false
        }
      )

      const content = assistantMessage.message.content[0]?.text || ''
      accumulatedContent = content
      totalCost = assistantMessage.costUSD

      // 模拟流式输出（实际应该重构querySonnet来支持真正的流式）
      const chunks = content.split(' ')
      for (let i = 0; i < chunks.length; i++) {
        yield {
          content: chunks[i] + (i < chunks.length - 1 ? ' ' : ''),
          isComplete: i === chunks.length - 1,
          costUSD: i === chunks.length - 1 ? totalCost : undefined
        }
        
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 50)) // 模拟延迟
        }
      }
    } catch (error) {
      logError('Claude provider stream error', error)
      throw error
    }
  }

  async countTokens(text: string): Promise<number> {
    // Claude API 不直接提供token计数，可以使用估算
    // 这里可以集成一个tokenizer库
    return Math.ceil(text.length / 4) // 粗略估算
  }

  getConfig(): ProviderConfig {
    return { ...this.config }
  }

  setConfig(config: Partial<ProviderConfig>): void {
    this.config = { ...this.config, ...config }
  }
} 