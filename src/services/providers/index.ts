// 导出基础接口和类型
export type { 
  AIProvider, 
  ProviderConfig, 
  GenerateContentRequest, 
  GenerateContentResponse, 
  StreamResponse 
} from './base.js'

// 导出提供商管理器
export type { ProviderType, ProviderManagerConfig } from './manager.js'
export { ProviderManager } from './manager.js'

// 导出配置管理器
export { ProviderConfigManager } from './config.js'

// 导出各个提供商实现
export { ClaudeProvider } from './claude.js'
export { OpenAIProvider } from './openai.js'
export { DeepSeekProvider } from './deepseek.js'
export { LocalProvider } from './local.js'

// 导出便捷函数
import { ProviderConfigManager } from './config.js'
import { ProviderManager } from './manager.js'

let globalProviderManager: ProviderManager | null = null

/**
 * 获取全局提供商管理器实例
 */
export async function getProviderManager(): Promise<ProviderManager> {
  if (!globalProviderManager) {
    const configManager = ProviderConfigManager.getInstance()
    globalProviderManager = await configManager.loadProviderManager()
  }
  return globalProviderManager
}

/**
 * 重置全局提供商管理器（用于测试或重新加载配置）
 */
export function resetProviderManager(): void {
  globalProviderManager = null
}

/**
 * 获取当前活跃的提供商类型
 */
export async function getCurrentProviderType(): Promise<string> {
  const manager = await getProviderManager()
  return manager.getCurrentProviderType()
}

/**
 * 切换提供商
 */
export async function switchProvider(providerType: string): Promise<void> {
  const manager = await getProviderManager()
  manager.switchProvider(providerType as any)
}

/**
 * 生成内容（使用当前提供商）
 */
export async function generateContent(request: any): Promise<any> {
  const manager = await getProviderManager()
  return await manager.generateContent(request)
}

/**
 * 生成内容流（使用当前提供商）
 */
export async function* generateContentStream(request: any): AsyncGenerator<any> {
  const manager = await getProviderManager()
  yield* manager.generateContentStream(request)
}

/**
 * 计算token数量（使用当前提供商）
 */
export async function countTokens(text: string): Promise<number> {
  const manager = await getProviderManager()
  return await manager.countTokens(text)
} 