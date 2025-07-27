/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CountTokensResponse,
  GenerateContentResponse,
  GenerateContentParameters,
  EmbedContentResponse,
  FinishReason,
  Part,
  Content,
} from '@google/genai';
import { ContentGenerator } from './contentGenerator.js';

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
      function_call?: {
        name: string;
        arguments: string;
      };
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface LocalStreamDelta {
  role?: string;
  content?: string;
  finish_reason?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

interface LocalStreamChoice {
  index: number;
  delta: LocalStreamDelta;
  finish_reason: string | null;
}

interface LocalStreamResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: LocalStreamChoice[];
}

export class LocalAdapter implements ContentGenerator {
  private apiKey: string;
  private baseUrl: string;
  private detectedModel: string = 'unknown';

  constructor(baseUrl: string, apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  /**
   * 根据模型名称检测模型类型
   */
  private detectModelType(modelName: string): string {
    const lowerModel = modelName.toLowerCase();
    
    // DeepSeek 模型检测
    if (lowerModel.includes('deepseek') || lowerModel.includes('coder')) {
      return 'deepseek-coder';
    }
    
    // OpenAI 兼容模型检测
    if (lowerModel.includes('gpt') || lowerModel.includes('openai')) {
      return 'gpt';
    }
    
    // Claude 模型检测
    if (lowerModel.includes('claude')) {
      return 'claude';
    }
    
    // Llama 模型检测
    if (lowerModel.includes('llama') || lowerModel.includes('llm')) {
      return 'llama';
    }
    
    // Qwen 模型检测
    if (lowerModel.includes('qwen')) {
      return 'qwen';
    }
    
    // ChatGLM 模型检测
    if (lowerModel.includes('chatglm') || lowerModel.includes('glm')) {
      return 'chatglm';
    }
    
    // 通用模型检测
    if (lowerModel.includes('chat') || lowerModel.includes('assistant')) {
      return 'chat';
    }
    
    // 默认返回模型名称
    return modelName;
  }

  /**
   * 根据模型类型调整请求参数
   */
  private adjustRequestForModel(requestObj: any, modelType: string): void {
    switch (modelType) {
      case 'deepseek-coder':
        // DeepSeek 特定配置
        requestObj.temperature = requestObj.temperature ?? 0.7;
        requestObj.top_p = requestObj.top_p ?? 0.95;
        break;
        
      case 'gpt':
        // OpenAI 兼容配置
        requestObj.temperature = requestObj.temperature ?? 0.7;
        requestObj.top_p = requestObj.top_p ?? 1;
        break;
        
      case 'claude':
        // Claude 配置
        requestObj.temperature = requestObj.temperature ?? 0.7;
        requestObj.top_p = requestObj.top_p ?? 0.9;
        break;
        
      case 'llama':
        // Llama 配置
        requestObj.temperature = requestObj.temperature ?? 0.8;
        requestObj.top_p = requestObj.top_p ?? 0.9;
        break;
        
      case 'qwen':
        // Qwen 配置
        requestObj.temperature = requestObj.temperature ?? 0.7;
        requestObj.top_p = requestObj.top_p ?? 0.9;
        break;
        
      case 'chatglm':
        // ChatGLM 配置
        requestObj.temperature = requestObj.temperature ?? 0.7;
        requestObj.top_p = requestObj.top_p ?? 0.9;
        break;
        
      default:
        // 通用配置
        requestObj.temperature = requestObj.temperature ?? 0.7;
        requestObj.top_p = requestObj.top_p ?? 0.9;
        break;
    }
  }

  /**
   * 根据模型类型调整响应处理
   */
  private adjustResponseForModel(response: any, modelType: string): void {
    // 根据模型类型调整响应处理逻辑
    switch (modelType) {
      case 'deepseek-coder':
        // DeepSeek 特定处理
        break;
        
      case 'gpt':
        // OpenAI 兼容处理
        break;
        
      case 'claude':
        // Claude 特定处理
        break;
        
      default:
        // 通用处理
        break;
    }
  }

  private async makeRequest(endpoint: string, data: unknown): Promise<unknown> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // 只有在提供了 API Key 时才添加认证头
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

    // 检查是否是 HTTPS 请求，如果是则设置环境变量忽略 SSL 证书验证
    const isHttps = this.baseUrl.startsWith('https://');
    if (isHttps && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    // 保证 baseUrl 末尾没有重复 /，endpoint 以 /chat/completions 开头
    const url = this.baseUrl.replace(/\/+$/, '') + endpoint;
    
          // 设置超时
      const timeout = parseInt(process.env.DEEPSEEK_TIMEOUT || '30000'); // 默认30秒
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);

      // 获取响应文本
      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(`Local ${this.detectedModel} API error: ${response.status} ${response.statusText} - ${responseText || 'No response body'}`);
      }

      // 检查响应是否为空
      if (!responseText || responseText.trim().length === 0) {
        throw new Error(`Local ${this.detectedModel} API returned empty response`);
      }

      // 尝试解析JSON
      try {
        const json = JSON.parse(responseText);
        
        // 检查响应是否包含错误信息
        if (json.error) {
          const errorMessage = json.error.message || json.error.code || 'Unknown error';
          throw new Error(`${this.detectedModel} server error: ${errorMessage}`);
        }
        
        // 检查是否有 choices 数组
        if (!json.choices || !Array.isArray(json.choices) || json.choices.length === 0) {
          throw new Error(`${this.detectedModel} server returned invalid response: missing choices array`);
        }
        
        return json;
      } catch (parseError) {
        throw new Error(`Failed to parse JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      }

          } catch (err) {
        clearTimeout(timeoutId);
        
        if (err instanceof Error) {
          if (err.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeout}ms. Please check your ${this.detectedModel} server response time or increase DEEPSEEK_TIMEOUT.`);
          }
          
          if (err.name === 'TypeError' && err.message.includes('fetch')) {
            throw new Error(`Cannot connect to ${this.detectedModel} server at ${this.baseUrl}. Please check if the server is running and the URL is correct.`);
          }
        }
        
        throw err;
      }
  }

  private convertToDeepseekMessages(request: unknown): LocalMessage[] {
    const messages: LocalMessage[] = [];
    
    if (request && typeof request === 'object' && 'contents' in request && Array.isArray((request as Record<string, unknown>).contents)) {
      for (const content of (request as Record<string, unknown>).contents as Array<Record<string, unknown>>) {
        if ((content.role === 'user' || content.role === 'model') && content.parts) {
          const segments: string[] = [];
          for (const part of content.parts as Array<Record<string, unknown>>) {
            if ('text' in part) {
              segments.push(part.text as string);
            } else if ('functionCall' in part) {
              segments.push('[FunctionCall] ' + JSON.stringify(part.functionCall));
            } else if ('functionResponse' in part) {
              segments.push('[FunctionResponse] ' + JSON.stringify(part.functionResponse));
            }
          }
          const text = segments.join('\n');
          if (text) {
            const role = content.role === 'model' ? 'assistant' : content.role;
            messages.push({ role, content: text });
          }
        }
      }
    }

    if (messages.length === 0) {
      messages.push({ role: 'system', content: 'You are a helpful assistant.' });
    }

    // console.log('[localAdapter] messages:', messages);

    return messages;
  }

  private convertToTools(googleTools: unknown[]): LocalTool[] {
    if (!googleTools || !Array.isArray(googleTools)) {
      return [];
    }

    const result = googleTools.map(tool => {
      if (tool && typeof tool === 'object' && 'functionDeclarations' in tool && Array.isArray((tool as Record<string, unknown>).functionDeclarations)) {
        return ((tool as Record<string, unknown>).functionDeclarations as Array<Record<string, unknown>>).map((func: Record<string, unknown>) => ({
          type: "function" as const,
          function: {
            name: func.name as string,
            description: func.description as string,
            parameters: this.normalizeParameters(func.parameters)
          }
        }));
      }
      return [];
    }).flat();
    
    return result;
  }

  private normalizeParameters(parameters: unknown): Record<string, unknown> {
    if (!parameters) {
      return {};
    }

    const normalizeType = (type: string): string => {
      const typeMap: Record<string, string> = {
        'STRING': 'string',
        'NUMBER': 'number',
        'BOOLEAN': 'boolean',
        'OBJECT': 'object',
        'ARRAY': 'array',
        'INTEGER': 'integer'
      };
      return typeMap[type] || type;
    };

    const normalizeSchema = (schema: unknown): Record<string, unknown> => {
      if (typeof schema !== 'object' || schema === null) {
        return {};
      }

      const normalized = { ...schema as Record<string, unknown> };

      if ('type' in normalized && typeof normalized.type === 'string') {
        normalized.type = normalizeType(normalized.type as string);
      }

      if ('items' in normalized) {
        normalized.items = normalizeSchema(normalized.items);
      }

      if ('properties' in normalized && normalized.properties && typeof normalized.properties === 'object') {
        const normalizedProperties: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(normalized.properties as Record<string, unknown>)) {
          normalizedProperties[key] = normalizeSchema(value);
        }
        normalized.properties = normalizedProperties;
      }

      return normalized;
    };

    return normalizeSchema(parameters);
  }

  private buildResponse(choice: LocalResponse['choices'][0], request: GenerateContentParameters): GenerateContentResponse {
    // 检查是否有错误响应
    if (!choice) {
      throw new Error('Invalid response from Local server: no choices available');
    }

    // 构建 parts 数组
    const parts: any[] = [];
    let text = '';
    let functionCalls: any[] | undefined = undefined;

    // 文本内容
    if (choice.message?.content) {
      text = choice.message.content;
      parts.push({ text });
    }

    // 工具调用
    if (choice.message?.tool_calls && Array.isArray(choice.message.tool_calls)) {
      functionCalls = choice.message.tool_calls.map((toolCall: any) => {
        let args = {};
        if (toolCall.function?.arguments) {
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            args = {};
          }
        }
        // parts 追加
        parts.push({
          functionCall: {
            name: toolCall.function?.name || 'unknown_function',
            args
          }
        });
        return {
          name: toolCall.function?.name || 'unknown_function',
          args,
          id: toolCall.id
        };
      });
    } else if (choice.message?.function_call) {
      // 兼容 function_call
      let args = {};
      if (choice.message.function_call.arguments) {
        try {
          args = JSON.parse(choice.message.function_call.arguments);
        } catch {
          args = {};
        }
      }
      parts.push({
        functionCall: {
          name: choice.message.function_call.name || 'unknown_function',
          args
        }
      });
      functionCalls = [{
        name: choice.message.function_call.name || 'unknown_function',
        args,
        id: undefined
      }];
    }

    // 如果没有内容，parts 至少有空文本
    if (parts.length === 0) {
      parts.push({ text: '' });
    }

    const response = {
      candidates: [{
        content: {
          parts,
          role: 'model'
        },
        index: 0,
        finishReason: this.convertFinishReason(choice.finish_reason),
        safetyRatings: []
      }],
      text,
      functionCalls: functionCalls,
      data: undefined,
      executableCode: undefined,
      codeExecutionResult: undefined,
      automaticFunctionCallingHistory: this.buildAutomaticFunctionCallingHistory(request, { choices: [choice] }),
      createTime: new Date().toISOString(),
      responseId: `${this.detectedModel}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      modelVersion: this.detectedModel
    };

    return response as GenerateContentResponse;
  }

  private convertToLocalRequest(request: GenerateContentParameters): LocalRequest {
    const messages = this.convertToDeepseekMessages(request);
    const requestAny = request as unknown as Record<string, unknown>;
    const config = requestAny?.config as Record<string, unknown> | undefined;
    const googleTools = config?.tools || requestAny?.tools;
    const localTools = this.convertToTools(googleTools as unknown[]);
    
    // 获取模型名称并检测模型类型
    const modelName = (requestAny?.model as string) || 'local-chat';
    const modelType = this.detectModelType(modelName);
    this.detectedModel = modelType; // 保存检测到的模型类型
    
    // 检查是否是JSON生成请求
    const isJsonRequest = config?.responseMimeType === 'application/json' || config?.responseSchema;
    
    // 构造请求体
    const requestObj: any = {
      model: modelName,
      messages,
      stream: config?.stream ?? false,
      temperature: config?.temperature ?? 1,
      top_p: config?.top_p ?? 1,
      max_tokens: config?.maxOutputTokens ?? 2048,
      presence_penalty: config?.presence_penalty ?? 0,
      frequency_penalty: config?.frequency_penalty ?? 0,
      stop: config?.stop ?? null,
      logprobs: config?.logprobs ?? false,
      top_logprobs: config?.top_logprobs ?? null,
      response_format: config?.response_format ?? { type: 'text' },
      stream_options: config?.stream_options ?? null,
      tool_choice: config?.tool_choice ?? 'auto',
    };

    // console.log('[localAdapter] requestObj:', requestObj);
    
    // 根据模型类型调整请求参数
    this.adjustRequestForModel(requestObj, modelType);
    
    if (localTools.length > 0) {
      requestObj.tools = localTools;
    }
    
    // 如果是JSON请求，添加格式要求到系统消息
    if (isJsonRequest && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.role === 'user') {
        lastMessage.content += '\n\n请严格按照JSON格式回复，不要包含任何其他文本，不要使用markdown代码块。';
      }
    }
    
    return requestObj;
  }

  async generateContent(request: unknown): Promise<GenerateContentResponse> {
    const requestObj = this.convertToLocalRequest(request as GenerateContentParameters);
    const response = await this.makeRequest('/chat/completions', requestObj) as LocalResponse;
    const result = this.buildResponse(response.choices[0], request as GenerateContentParameters);
    return result;
  }

  async generateContentStream(request: GenerateContentParameters): Promise<AsyncGenerator<GenerateContentResponse>> {
    // 始终降级为非流式，直接 yield 一次
    const result = await this.generateContent(request);
    async function* gen() { yield result; }
    return gen();
  }

  private async *streamDeepseekResponse(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    request: GenerateContentParameters
  ): AsyncGenerator<GenerateContentResponse> {
    let buffer = '';
    const seenToolCalls = new Set<string>();
    const textDecoder = new TextDecoder();
    const self = this;
    while (true) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (err) {
        throw err;
      }
      const { done, value } = readResult;

      if (done) {
        break;
      }

      const chunkStr = textDecoder.decode(value);
      buffer += chunkStr;
      let lines = buffer.split('\n');
      buffer = lines.pop()!; // 最后一行可能是不完整的，留到下次
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('data:')) {
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;
          let chunk;
          try {
            chunk = JSON.parse(jsonStr);
          } catch (err) {
            continue;
          }
          const choice = chunk.choices?.[0];
          if (choice && choice.finish_reason) {
            if (choice.message?.tool_calls) {
              choice.message.tool_calls = choice.message.tool_calls.filter((tc: any) => {
                const key = tc.function?.name + JSON.stringify(tc.function?.arguments);
                if (seenToolCalls.has(key)) return false;
                seenToolCalls.add(key);
                return true;
              });
            }
            const result = self.buildResponse(choice, request as GenerateContentParameters);
            yield result;
          }
        }
      }

    }
  }

  async countTokens(request: unknown): Promise<CountTokensResponse> {
    const requestAny = request as unknown as Record<string, unknown>;
    const contents = requestAny?.contents as Array<Record<string, unknown>> | undefined;
    const firstContent = contents?.[0] as Record<string, unknown> | undefined;
    const parts = firstContent?.parts as Array<Record<string, unknown>> | undefined;
    const text = parts?.[0]?.text as string || '';
    return {
      totalTokens: Math.ceil(text.length / 4)
    } as CountTokensResponse;
  }

  async embedContent(_request: unknown): Promise<EmbedContentResponse> {
    throw new Error(`Embedding not supported by Local ${this.detectedModel} adapter`);
  }

  private convertFinishReason(finishReason: string | null | undefined): FinishReason {
    if (!finishReason) return FinishReason.STOP;
    switch (finishReason) {
      case 'stop':
        return FinishReason.STOP;
      case 'max_tokens':
        return FinishReason.MAX_TOKENS;
      case 'safety':
        return FinishReason.SAFETY;
      case 'recitation':
        return FinishReason.RECITATION;
      default:
        return FinishReason.OTHER;
    }
  }

  private buildAutomaticFunctionCallingHistory(request: unknown, response: unknown): Content[] {
    const responseObj = response as LocalResponse;
    const choice = responseObj?.choices?.[0];
    if (!choice) {
      return [];
    }

    const toolCalls = choice.message?.tool_calls;
    if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
      const afcHistory: Content[] = [];
      const seen = new Set<string>();
      
      if (request && typeof request === 'object' && 'contents' in request && Array.isArray((request as Record<string, unknown>).contents)) {
        const contents = (request as Record<string, unknown>).contents as Array<Record<string, unknown>>;
        const userContent = contents[0];
        if (userContent && userContent.role === 'user' && userContent.parts) {
          const userText = (userContent.parts as Array<Record<string, unknown>>)
            .filter((part: unknown) => part && typeof part === 'object' && 'text' in part)
            .map((part: Record<string, unknown>) => part.text as string)
            .join('');
          if (userText) {
            afcHistory.push({
              role: 'user',
              parts: [{ text: userText }]
            });
          }
        }
      }
      
      for (const toolCall of toolCalls) {
        const key = toolCall.function?.name + JSON.stringify(toolCall.function?.arguments);
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
          afcHistory.push({
            role: 'model',
            parts: [{
              functionCall: {
                name: toolCall.function?.name || 'unknown_function',
                args
              }
            }]
          });
        } catch {
          afcHistory.push({
            role: 'model',
            parts: [{
              functionCall: {
                name: toolCall.function?.name || 'unknown_function',
                args: { raw_arguments: toolCall.function?.arguments }
              }
            }]
          });
        }
      }
      
      return afcHistory;
    }
    
    return [];
  }
} 