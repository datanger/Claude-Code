import { AIProvider, ProviderConfig, GenerateContentRequest, GenerateContentResponse, StreamResponse } from './base.js'
import { logError } from '../../utils/log.js'
import { addToTotalCost } from '../../cost-tracker.js'
import { userMessageToMessageParam, assistantMessageToMessageParam } from '../claude.js'

interface LocalMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LocalRequest {
  model: string;
  messages: LocalMessage[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  top_p?: number;
  tools?: LocalTool[];
}

interface LocalTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface LocalResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      content?: string;
      tool_calls?: Array<{
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class LocalProvider implements AIProvider {
  name = 'local'
  models = ['llama-3.1-8b', 'llama-3.1-70b', 'mistral-7b', 'codellama-34b']
  
  private config: ProviderConfig = {
    apiKey: undefined,
    baseUrl: 'http://localhost:11434', // 默认Ollama地址
    model: 'llama-3.1-8b',
    temperature: 1,
    maxTokens: 4096
  }

  constructor(config?: Partial<ProviderConfig>) {
    if (config) {
      this.setConfig(config)
    }
  }

  async verifyApiKey(apiKey: string): Promise<boolean> {
    // 本地模型通常不需要API密钥验证
    return true
  }

  private convertMessages(request: GenerateContentRequest): LocalMessage[] {
    const messages: LocalMessage[] = []
    
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

  private convertTools(tools: any[]): LocalTool[] {
    return tools.map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }))
  }

  private async makeRequest(endpoint: string, data: unknown): Promise<unknown> {
    const url = `${this.config.baseUrl}${endpoint}`
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` })
      },
      body: JSON.stringify(data)
    })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    return await response.json()
  }

  async generateContent(request: GenerateContentRequest): Promise<GenerateContentResponse> {
    const startTime = Date.now()
    
    try {
      const messages = this.convertMessages(request)
      
      const localRequest: LocalRequest = {
        model: request.options.model || this.config.model,
        messages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        stream: false
      }
      
      // 添加工具配置
      if (request.tools.length > 0) {
        localRequest.tools = this.convertTools(request.tools)
      }
      
      const response = await this.makeRequest('/v1/chat/completions', localRequest) as LocalResponse
      
      const durationMs = Date.now() - startTime
      const content = response.choices[0]?.message?.content || ''
      
      // 本地模型通常没有成本
      const costUSD = 0
      
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
      logError('Local provider error', error)
      throw error
    }
  }

  async *generateContentStream(request: GenerateContentRequest): AsyncGenerator<StreamResponse> {
    const startTime = Date.now()
    let accumulatedContent = ''

    try {
      const messages = this.convertMessages(request)
      
      const localRequest: LocalRequest = {
        model: request.options.model || this.config.model,
        messages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        stream: true
      }
      
      // 添加工具配置
      if (request.tools.length > 0) {
        localRequest.tools = this.convertTools(request.tools)
      }
      
      const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` })
        },
        body: JSON.stringify(localRequest)
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('No response body')
      }

      const decoder = new TextDecoder()
      
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value)
        const lines = chunk.split('\n')
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') {
              yield {
                content: '',
                isComplete: true,
                costUSD: 0
              }
              return
            }
            
            try {
              const parsed = JSON.parse(data)
              const content = parsed.choices[0]?.delta?.content || ''
              accumulatedContent += content
              
              yield {
                content,
                isComplete: parsed.choices[0]?.finish_reason !== null,
                costUSD: parsed.choices[0]?.finish_reason !== null ? 0 : undefined
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        }
      }
    } catch (error) {
      logError('Local provider stream error', error)
      throw error
    }
  }

  async countTokens(text: string): Promise<number> {
    // 本地模型通常不提供token计数，使用估算
    return Math.ceil(text.length / 4)
  }

  getConfig(): ProviderConfig {
    return { ...this.config }
  }

  setConfig(config: Partial<ProviderConfig>): void {
    this.config = { ...this.config, ...config }
  }
} 