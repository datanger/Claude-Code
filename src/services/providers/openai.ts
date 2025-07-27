import { AIProvider, ProviderConfig, GenerateContentRequest, GenerateContentResponse, StreamResponse } from './base.js'
import { logError } from '../../utils/log.js'
import { addToTotalCost } from '../../cost-tracker.js'
import { userMessageToMessageParam, assistantMessageToMessageParam } from '../claude.js'

export class OpenAIProvider implements AIProvider {
  name = 'openai'
  models = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo']
  
  private config: ProviderConfig = {
    apiKey: undefined,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    temperature: 1,
    maxTokens: 4096
  }

  private openai: any = null

  constructor(config?: Partial<ProviderConfig>) {
    if (config) {
      this.setConfig(config)
    }
  }

  private async getOpenAI() {
    if (!this.openai) {
      const { OpenAI } = await import('openai')
      this.openai = new OpenAI({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseUrl,
      })
    }
    return this.openai
  }

  async verifyApiKey(apiKey: string): Promise<boolean> {
    try {
      const openai = new (await import('openai')).OpenAI({
        apiKey,
        baseURL: this.config.baseUrl,
      })
      
      // 尝试调用一个简单的API来验证密钥
      await openai.models.list()
      return true
    } catch (error) {
      return false
    }
  }

  private convertMessages(request: GenerateContentRequest): any[] {
    const messages: any[] = []
    
    // 添加系统消息
    if (request.systemPrompt.length > 0) {
      messages.push({
        role: 'system',
        content: request.systemPrompt.join('\n')
      })
    }
    
    // 转换用户和助手消息
    for (const message of request.messages) {
      if (message.type === 'user') {
        messages.push({
          role: 'user',
          content: userMessageToMessageParam(message).content[0]?.text || ''
        })
      } else if (message.type === 'assistant') {
        messages.push({
          role: 'assistant',
          content: assistantMessageToMessageParam(message).content[0]?.text || ''
        })
      }
    }
    
    return messages
  }

  private convertTools(tools: any[]): any[] {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }))
  }

  async generateContent(request: GenerateContentRequest): Promise<GenerateContentResponse> {
    const startTime = Date.now()
    
    try {
      const openai = await this.getOpenAI()
      const messages = this.convertMessages(request)
      
      const requestConfig: any = {
        model: request.options.model || this.config.model,
        messages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
      }
      
      // 添加工具配置
      if (request.tools.length > 0) {
        requestConfig.tools = this.convertTools(request.tools)
        requestConfig.tool_choice = 'auto'
      }
      
      const response = await openai.chat.completions.create(requestConfig)
      
      const durationMs = Date.now() - startTime
      const content = response.choices[0]?.message?.content || ''
      
      // 计算成本（基于OpenAI定价）
      const costUSD = this.calculateCost(response.usage, request.options.model || this.config.model)
      addToTotalCost(costUSD)
      
      return {
        content,
        costUSD,
        durationMs,
        usage: response.usage ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens
        } : undefined
      }
    } catch (error) {
      logError('OpenAI provider error', error)
      throw error
    }
  }

  async *generateContentStream(request: GenerateContentRequest): AsyncGenerator<StreamResponse> {
    const startTime = Date.now()
    let accumulatedContent = ''
    let totalTokens = 0

    try {
      const openai = await this.getOpenAI()
      const messages = this.convertMessages(request)
      
      const requestConfig: any = {
        model: request.options.model || this.config.model,
        messages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        stream: true
      }
      
      // 添加工具配置
      if (request.tools.length > 0) {
        requestConfig.tools = this.convertTools(request.tools)
        requestConfig.tool_choice = 'auto'
      }
      
      const stream = await openai.chat.completions.create(requestConfig)
      
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || ''
        accumulatedContent += content
        
        if (chunk.usage) {
          totalTokens = chunk.usage.total_tokens
        }
        
        yield {
          content,
          isComplete: chunk.choices[0]?.finish_reason !== null,
          costUSD: chunk.choices[0]?.finish_reason !== null ? 
            this.calculateCost({ total_tokens: totalTokens }, request.options.model || this.config.model) : undefined
        }
      }
    } catch (error) {
      logError('OpenAI provider stream error', error)
      throw error
    }
  }

  async countTokens(text: string): Promise<number> {
    // OpenAI 不提供直接的token计数API，可以使用tiktoken库
    // 这里使用简单估算
    return Math.ceil(text.length / 4)
  }

  private calculateCost(usage: any, model: string): number {
    if (!usage) return 0
    
    // OpenAI 定价（每1000 tokens）
    const pricing: Record<string, { input: number; output: number }> = {
      'gpt-4o': { input: 0.0025, output: 0.01 },
      'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
      'gpt-4-turbo': { input: 0.01, output: 0.03 },
      'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 }
    }
    
    const modelPricing = pricing[model] || pricing['gpt-4o']
    const inputCost = (usage.prompt_tokens / 1000) * modelPricing.input
    const outputCost = (usage.completion_tokens / 1000) * modelPricing.output
    
    return inputCost + outputCost
  }

  getConfig(): ProviderConfig {
    return { ...this.config }
  }

  setConfig(config: Partial<ProviderConfig>): void {
    this.config = { ...this.config, ...config }
    // 重置客户端以使用新配置
    this.openai = null
  }
} 