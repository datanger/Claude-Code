import type { Tool } from '../../Tool.js'
import type { AssistantMessage, UserMessage } from '../../query.js'

export interface ProviderConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  temperature?: number
  maxTokens?: number
}

export interface GenerateContentRequest {
  messages: (UserMessage | AssistantMessage)[]
  systemPrompt: string[]
  tools: Tool[]
  signal: AbortSignal
  options: {
    dangerouslySkipPermissions: boolean
    model: string
    prependCLISysprompt: boolean
  }
}

export interface GenerateContentResponse {
  content: string
  costUSD: number
  durationMs: number
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export interface StreamResponse {
  content: string
  isComplete: boolean
  costUSD?: number
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export interface AIProvider {
  name: string
  models: string[]
  
  // 验证API密钥
  verifyApiKey(apiKey: string): Promise<boolean>
  
  // 生成内容（非流式）
  generateContent(request: GenerateContentRequest): Promise<GenerateContentResponse>
  
  // 生成内容（流式）
  generateContentStream(request: GenerateContentRequest): AsyncGenerator<StreamResponse>
  
  // 计算token数量
  countTokens(text: string): Promise<number>
  
  // 获取提供商配置
  getConfig(): ProviderConfig
  
  // 设置提供商配置
  setConfig(config: Partial<ProviderConfig>): void
} 