import { AIProvider, ProviderConfig, GenerateContentRequest, GenerateContentResponse, StreamResponse } from './base.js'
import { ClaudeProvider } from './claude.js'
import { OpenAIProvider } from './openai.js'
import { DeepSeekProvider } from './deepseek.js'
import { LocalProvider } from './local.js'
import { logError } from '../../utils/log.js'

export type ProviderType = 'claude' | 'openai' | 'deepseek' | 'local'

export interface ProviderManagerConfig {
  defaultProvider: ProviderType
  providers: Record<ProviderType, ProviderConfig>
}

export class ProviderManager {
  private providers: Map<ProviderType, AIProvider> = new Map()
  private defaultProvider: ProviderType
  private currentProvider: ProviderType

  constructor(config: ProviderManagerConfig) {
    this.defaultProvider = config.defaultProvider
    this.currentProvider = config.defaultProvider

    // 初始化所有提供商
    this.providers.set('claude', new ClaudeProvider(config.providers.claude))
    this.providers.set('openai', new OpenAIProvider(config.providers.openai))
    this.providers.set('deepseek', new DeepSeekProvider(config.providers.deepseek))
    this.providers.set('local', new LocalProvider(config.providers.local))
  }

  // 获取当前提供商
  getCurrentProvider(): AIProvider {
    const provider = this.providers.get(this.currentProvider)
    if (!provider) {
      throw new Error(`Provider ${this.currentProvider} not found`)
    }
    return provider
  }

  // 切换提供商
  switchProvider(providerType: ProviderType): void {
    if (!this.providers.has(providerType)) {
      throw new Error(`Provider ${providerType} not supported`)
    }
    this.currentProvider = providerType
  }

  // 获取所有可用的提供商
  getAvailableProviders(): ProviderType[] {
    return Array.from(this.providers.keys())
  }

  // 获取提供商信息
  getProviderInfo(providerType: ProviderType): { name: string; models: string[] } | null {
    const provider = this.providers.get(providerType)
    if (!provider) return null
    
    return {
      name: provider.name,
      models: provider.models
    }
  }

  // 验证提供商API密钥
  async verifyProviderApiKey(providerType: ProviderType, apiKey: string): Promise<boolean> {
    const provider = this.providers.get(providerType)
    if (!provider) {
      throw new Error(`Provider ${providerType} not found`)
    }
    
    return await provider.verifyApiKey(apiKey)
  }

  // 设置提供商配置
  setProviderConfig(providerType: ProviderType, config: Partial<ProviderConfig>): void {
    const provider = this.providers.get(providerType)
    if (!provider) {
      throw new Error(`Provider ${providerType} not found`)
    }
    
    provider.setConfig(config)
  }

  // 获取提供商配置
  getProviderConfig(providerType: ProviderType): ProviderConfig | null {
    const provider = this.providers.get(providerType)
    if (!provider) return null
    
    return provider.getConfig()
  }

  // 生成内容（使用当前提供商）
  async generateContent(request: GenerateContentRequest): Promise<GenerateContentResponse> {
    try {
      const provider = this.getCurrentProvider()
      return await provider.generateContent(request)
    } catch (error) {
      logError(`Error generating content with provider ${this.currentProvider}`, error)
      throw error
    }
  }

  // 生成内容流（使用当前提供商）
  async *generateContentStream(request: GenerateContentRequest): AsyncGenerator<StreamResponse> {
    try {
      const provider = this.getCurrentProvider()
      yield* provider.generateContentStream(request)
    } catch (error) {
      logError(`Error generating content stream with provider ${this.currentProvider}`, error)
      throw error
    }
  }

  // 计算token数量（使用当前提供商）
  async countTokens(text: string): Promise<number> {
    try {
      const provider = this.getCurrentProvider()
      return await provider.countTokens(text)
    } catch (error) {
      logError(`Error counting tokens with provider ${this.currentProvider}`, error)
      throw error
    }
  }

  // 获取当前提供商类型
  getCurrentProviderType(): ProviderType {
    return this.currentProvider
  }

  // 重置为默认提供商
  resetToDefaultProvider(): void {
    this.currentProvider = this.defaultProvider
  }

  // 检查提供商是否可用
  isProviderAvailable(providerType: ProviderType): boolean {
    return this.providers.has(providerType)
  }

  // 获取所有提供商的状态信息
  async getProvidersStatus(): Promise<Record<ProviderType, { available: boolean; config: ProviderConfig }>> {
    const status: Record<ProviderType, { available: boolean; config: ProviderConfig }> = {} as any
    
    for (const [type, provider] of this.providers.entries()) {
      status[type] = {
        available: true, // 假设所有已注册的提供商都是可用的
        config: provider.getConfig()
      }
    }
    
    return status
  }
} 