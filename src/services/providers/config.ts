import { ProviderManager, ProviderManagerConfig, ProviderType } from './manager.js'
import { ProviderConfig } from './base.js'
import { getAnthropicApiKey } from '../../utils/config.js'
import { logError } from '../../utils/log.js'

// 默认提供商配置
const DEFAULT_PROVIDER_CONFIGS: Record<ProviderType, ProviderConfig> = {
  claude: {
    apiKey: undefined,
    baseUrl: undefined,
    model: 'claude-3-5-sonnet-20241022',
    temperature: 1,
    maxTokens: 4096
  },
  openai: {
    apiKey: undefined,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    temperature: 1,
    maxTokens: 4096
  },
  deepseek: {
    apiKey: undefined,
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    temperature: 1,
    maxTokens: 4096
  },
  local: {
    apiKey: undefined,
    baseUrl: 'http://localhost:11434',
    model: 'llama-3.1-8b',
    temperature: 1,
    maxTokens: 4096
  }
}

// 环境变量映射
const ENV_VAR_MAPPING: Record<ProviderType, { apiKey: string; baseUrl?: string }> = {
  claude: { apiKey: 'ANTHROPIC_API_KEY' },
  openai: { apiKey: 'OPENAI_API_KEY' },
  deepseek: { apiKey: 'DEEPSEEK_API_KEY' },
  local: { apiKey: 'LOCAL_API_KEY', baseUrl: 'LOCAL_BASE_URL' }
}

export class ProviderConfigManager {
  private static instance: ProviderConfigManager
  private providerManager: ProviderManager | null = null

  private constructor() {}

  static getInstance(): ProviderConfigManager {
    if (!ProviderConfigManager.instance) {
      ProviderConfigManager.instance = new ProviderConfigManager()
    }
    return ProviderConfigManager.instance
  }

  // 加载配置并创建提供商管理器
  async loadProviderManager(): Promise<ProviderManager> {
    if (this.providerManager) {
      return this.providerManager
    }

    const config = await this.loadConfiguration()
    this.providerManager = new ProviderManager(config)
    return this.providerManager
  }

  // 获取提供商管理器实例
  getProviderManager(): ProviderManager | null {
    return this.providerManager
  }

  // 加载配置
  private async loadConfiguration(): Promise<ProviderManagerConfig> {
    const providers: Record<ProviderType, ProviderConfig> = { ...DEFAULT_PROVIDER_CONFIGS }
    
    // 从环境变量加载配置
    for (const [providerType, envMapping] of Object.entries(ENV_VAR_MAPPING)) {
      const type = providerType as ProviderType
      
      // 加载API密钥
      if (envMapping.apiKey && process.env[envMapping.apiKey]) {
        providers[type].apiKey = process.env[envMapping.apiKey]
      }
      
      // 加载基础URL
      if (envMapping.baseUrl && process.env[envMapping.baseUrl]) {
        providers[type].baseUrl = process.env[envMapping.baseUrl]
      }
    }

    // 特殊处理Claude API密钥（从现有配置系统获取）
    const claudeApiKey = getAnthropicApiKey()
    if (claudeApiKey) {
      providers.claude.apiKey = claudeApiKey
    }

    // 如果指定了模型，覆盖默认模型
    if (process.env.CLAUDE_MODEL) {
      const currentProvider = process.env.CLAUDE_PROVIDER || 'claude'
      if (currentProvider in providers) {
        providers[currentProvider as ProviderType].model = process.env.CLAUDE_MODEL
      }
    }

    // 确定默认提供商
    const defaultProvider = this.determineDefaultProvider(providers)

    return {
      defaultProvider,
      providers
    }
  }

  // 确定默认提供商
  private determineDefaultProvider(providers: Record<ProviderType, ProviderConfig>): ProviderType {
    // 优先级：Claude > OpenAI > DeepSeek > Local
    const priority: ProviderType[] = ['claude', 'openai', 'deepseek', 'local']
    
    for (const providerType of priority) {
      const config = providers[providerType]
      if (config.apiKey || providerType === 'local') {
        return providerType
      }
    }
    
    return 'claude' // 默认回退到Claude
  }

  // 验证提供商配置
  async validateProviderConfig(providerType: ProviderType, config: ProviderConfig): Promise<{ valid: boolean; error?: string }> {
    try {
      const manager = await this.loadProviderManager()
      
      // 检查提供商是否可用
      if (!manager.isProviderAvailable(providerType)) {
        return { valid: false, error: `Provider ${providerType} is not available` }
      }

      // 验证API密钥（如果提供）
      if (config.apiKey) {
        const isValid = await manager.verifyProviderApiKey(providerType, config.apiKey)
        if (!isValid) {
          return { valid: false, error: `Invalid API key for provider ${providerType}` }
        }
      }

      return { valid: true }
    } catch (error) {
      logError(`Error validating provider config for ${providerType}`, error)
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  }

  // 更新提供商配置
  async updateProviderConfig(providerType: ProviderType, config: Partial<ProviderConfig>): Promise<void> {
    const manager = await this.loadProviderManager()
    manager.setProviderConfig(providerType, config)
  }

  // 获取提供商配置
  async getProviderConfig(providerType: ProviderType): Promise<ProviderConfig | null> {
    const manager = await this.loadProviderManager()
    return manager.getProviderConfig(providerType)
  }

  // 获取所有提供商配置
  async getAllProviderConfigs(): Promise<Record<ProviderType, ProviderConfig>> {
    const manager = await this.loadProviderManager()
    const configs: Record<ProviderType, ProviderConfig> = {} as any
    
    for (const providerType of manager.getAvailableProviders()) {
      const config = manager.getProviderConfig(providerType)
      if (config) {
        configs[providerType] = config
      }
    }
    
    return configs
  }

  // 重置提供商配置
  async resetProviderConfig(providerType: ProviderType): Promise<void> {
    const defaultConfig = DEFAULT_PROVIDER_CONFIGS[providerType]
    if (defaultConfig) {
      await this.updateProviderConfig(providerType, defaultConfig)
    }
  }

  // 获取环境变量配置建议
  getEnvironmentVariableSuggestions(): Record<ProviderType, string[]> {
    const suggestions: Record<ProviderType, string[]> = {}
    
    for (const [providerType, envMapping] of Object.entries(ENV_VAR_MAPPING)) {
      const type = providerType as ProviderType
      suggestions[type] = []
      
      if (envMapping.apiKey) {
        suggestions[type].push(`${envMapping.apiKey}=your_api_key_here`)
      }
      
      if (envMapping.baseUrl) {
        suggestions[type].push(`${envMapping.baseUrl}=your_base_url_here`)
      }
    }
    
    return suggestions
  }

  // 检查提供商是否已配置
  async isProviderConfigured(providerType: ProviderType): Promise<boolean> {
    const config = await this.getProviderConfig(providerType)
    if (!config) return false
    
    // 对于本地提供商，不需要API密钥
    if (providerType === 'local') {
      return true
    }
    
    // 对于其他提供商，需要API密钥
    return !!config.apiKey
  }

  // 获取已配置的提供商列表
  async getConfiguredProviders(): Promise<ProviderType[]> {
    const configuredProviders: ProviderType[] = []
    
    for (const providerType of ['claude', 'openai', 'deepseek', 'local'] as ProviderType[]) {
      if (await this.isProviderConfigured(providerType)) {
        configuredProviders.push(providerType)
      }
    }
    
    return configuredProviders
  }
} 