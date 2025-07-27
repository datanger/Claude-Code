import { ProviderConfigManager } from '../services/providers/config.js'
import { ProviderType } from '../services/providers/manager.js'

export interface ProviderCommandOptions {
  list?: boolean
  set?: string
  config?: string
  verify?: string
  reset?: string
  help?: boolean
}

export async function handleProviderCommand(options: ProviderCommandOptions): Promise<void> {
  const configManager = ProviderConfigManager.getInstance()
  
  try {
    // 显示帮助信息
    if (options.help || (!options.list && !options.set && !options.config && !options.verify && !options.reset)) {
      showHelp()
      return
    }

    // 列出所有提供商
    if (options.list) {
      await listProviders(configManager)
      return
    }

    // 设置提供商
    if (options.set) {
      await setProvider(options.set, configManager)
      return
    }

    // 配置提供商
    if (options.config) {
      const providerType = options.config as ProviderType
      await configureProvider(providerType, configManager)
      return
    }

    // 验证提供商
    if (options.verify) {
      const providerType = options.verify as ProviderType
      await verifyProvider(providerType, configManager)
      return
    }

    // 重置提供商
    if (options.reset) {
      const providerType = options.reset as ProviderType
      await resetProvider(providerType, configManager)
      return
    }

  } catch (error) {
    console.error('Error handling provider command:', error)
    process.exit(1)
  }
}

async function listProviders(configManager: ProviderConfigManager): Promise<void> {
  console.log('🤖 AI Providers Status\n')
  
  const providers: ProviderType[] = ['claude', 'openai', 'deepseek', 'local']
  
  for (const providerType of providers) {
    const displayName = getProviderDisplayName(providerType)
    const icon = getProviderIcon(providerType)
    const isConfigured = await configManager.isProviderConfigured(providerType)
    const config = await configManager.getProviderConfig(providerType)
    
    const status = isConfigured ? '✅ Configured' : '❌ Not Configured'
    const model = config?.model || 'Default'
    
    console.log(`${icon} ${displayName}`)
    console.log(`   Status: ${status}`)
    console.log(`   Model: ${model}`)
    if (config?.baseUrl) {
      console.log(`   URL: ${config.baseUrl}`)
    }
    console.log('')
  }
  
  console.log('💡 Use "claude provider --config <provider>" to configure a provider')
  console.log('💡 Use "claude provider --set <provider>" to switch to a provider')
}

async function setProvider(providerType: string, configManager: ProviderConfigManager): Promise<void> {
  const type = providerType as ProviderType
  const displayName = getProviderDisplayName(type)
  
  if (!['claude', 'openai', 'deepseek', 'local'].includes(providerType)) {
    console.error(`❌ Invalid provider: ${providerType}`)
    console.log('Available providers: claude, openai, deepseek, local')
    return
  }
  
  const isConfigured = await configManager.isProviderConfigured(type)
  if (!isConfigured) {
    console.error(`❌ Provider ${displayName} is not configured`)
    console.log(`Use "claude provider --config ${providerType}" to configure it first`)
    return
  }
  
  // 设置环境变量
  process.env.USE_MULTI_PROVIDER = 'true'
  process.env.CLAUDE_PROVIDER = providerType
  
  console.log(`✅ Switched to ${displayName} provider`)
  console.log('💡 This setting will be active for the current session')
}

async function configureProvider(providerType: ProviderType, configManager: ProviderConfigManager): Promise<void> {
  const displayName = getProviderDisplayName(providerType)
  const icon = getProviderIcon(providerType)
  
  console.log(`${icon} Configure ${displayName}\n`)
  
  const suggestions = configManager.getEnvironmentVariableSuggestions()[providerType]
  if (suggestions && suggestions.length > 0) {
    console.log('📝 Environment Variables:')
    for (const suggestion of suggestions) {
      console.log(`   ${suggestion}`)
    }
    console.log('')
  }
  
  const currentConfig = await configManager.getProviderConfig(providerType)
  if (currentConfig) {
    console.log('📋 Current Configuration:')
    console.log(`   Model: ${currentConfig.model || 'Default'}`)
    if (currentConfig.baseUrl) {
      console.log(`   Base URL: ${currentConfig.baseUrl}`)
    }
    if (currentConfig.apiKey) {
      console.log(`   API Key: ${currentConfig.apiKey.substring(0, 8)}...`)
    }
    console.log('')
  }
  
  console.log('💡 Set the environment variables above and restart Claude Code')
  console.log('💡 Or use the interactive UI to configure providers')
}

async function verifyProvider(providerType: ProviderType, configManager: ProviderConfigManager): Promise<void> {
  const displayName = getProviderDisplayName(providerType)
  const icon = getProviderIcon(providerType)
  
  console.log(`${icon} Verifying ${displayName} configuration...`)
  
  const config = await configManager.getProviderConfig(providerType)
  if (!config) {
    console.log('❌ No configuration found')
    return
  }
  
  const validation = await configManager.validateProviderConfig(providerType, config)
  if (validation.valid) {
    console.log('✅ Configuration is valid')
  } else {
    console.log(`❌ Configuration error: ${validation.error}`)
  }
}

async function resetProvider(providerType: ProviderType, configManager: ProviderConfigManager): Promise<void> {
  const displayName = getProviderDisplayName(providerType)
  
  console.log(`🔄 Resetting ${displayName} configuration to defaults...`)
  
  await configManager.resetProviderConfig(providerType)
  console.log('✅ Configuration reset successfully')
}

function showHelp(): void {
  console.log('🤖 Claude Provider Management\n')
  console.log('Usage: claude provider [options]\n')
  console.log('Options:')
  console.log('  --list                    List all available providers and their status')
  console.log('  --set <provider>          Switch to a specific provider')
  console.log('  --config <provider>       Show configuration instructions for a provider')
  console.log('  --verify <provider>       Verify provider configuration')
  console.log('  --reset <provider>        Reset provider configuration to defaults')
  console.log('  --help                    Show this help message\n')
  console.log('Available providers:')
  console.log('  claude     Claude (Anthropic) - Default provider')
  console.log('  openai     OpenAI GPT models')
  console.log('  deepseek   DeepSeek models')
  console.log('  local      Local models (Ollama, etc.)\n')
  console.log('Examples:')
  console.log('  claude provider --list')
  console.log('  claude provider --set openai')
  console.log('  claude provider --config openai')
  console.log('  claude provider --verify claude')
}

function getProviderDisplayName(providerType: ProviderType): string {
  const names: Record<ProviderType, string> = {
    claude: 'Claude (Anthropic)',
    openai: 'OpenAI',
    deepseek: 'DeepSeek',
    local: 'Local Model'
  }
  return names[providerType] || providerType
}

function getProviderIcon(providerType: ProviderType): string {
  const icons: Record<ProviderType, string> = {
    claude: '🤖',
    openai: '🧠',
    deepseek: '🔍',
    local: '🏠'
  }
  return icons[providerType] || '❓'
} 