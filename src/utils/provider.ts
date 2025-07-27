export type LLMProvider = 'anthropic' | 'openai' | 'deepseek'

export interface ProviderConfig {
  provider: LLMProvider
  model: string
  skipPermissions?: boolean
}

/**
 * 根据模型名称自动选择 LLM 提供商
 */
export function getProviderFromModel(model: string): LLMProvider {
  if (model.includes('gpt-') || model.includes('openai')) {
    return 'openai'
  }
  if (model.includes('deepseek')) {
    return 'deepseek'
  }
  // 默认使用 anthropic
  return 'anthropic'
}

/**
 * 检查是否需要跳过权限验证
 * 非 Anthropic 提供商默认跳过权限验证
 */
export function shouldSkipPermissions(provider: LLMProvider): boolean {
  return provider === 'openai' || provider === 'deepseek'
}

/**
 * 获取提供商配置
 */
export function getProviderConfig(model: string): ProviderConfig {
  const provider = getProviderFromModel(model)
  return {
    provider,
    model,
    skipPermissions: shouldSkipPermissions(provider),
  }
}

/**
 * 验证模型是否支持
 */
export function isModelSupported(model: string): boolean {
  const provider = getProviderFromModel(model)
  
  if (provider === 'openai') {
    // OpenAI 支持的模型
    const openaiModels = [
      'gpt-4', 'gpt-4-turbo', 'gpt-4o', 'gpt-4o-mini',
      'gpt-3.5-turbo', 'gpt-3.5-turbo-16k'
    ]
    return openaiModels.some(supported => model.includes(supported))
  }
  
  if (provider === 'deepseek') {
    // DeepSeek 支持的模型
    const deepseekModels = [
      'deepseek-chat', 'deepseek-coder', 'deepseek-reasoner',
      'deepseek-v2.5', 'deepseek-v2.5-chat', 'deepseek-v2.5-coder'
    ]
    return deepseekModels.some(supported => model.includes(supported))
  }
  
  if (provider === 'anthropic') {
    // Anthropic 支持的模型
    const anthropicModels = [
      'claude-3-5-sonnet', 'claude-3-5-haiku', 'claude-3-opus',
      'claude-3-sonnet', 'claude-3-haiku', 'claude-2'
    ]
    return anthropicModels.some(supported => model.includes(supported))
  }
  
  return false
} 