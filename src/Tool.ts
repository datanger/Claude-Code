export type { Tool } from '../vendor/sdk/resources/messages/messages.js'

// 添加缺失的类型定义
export interface ToolUseContext {
  // 根据使用情况添加必要的属性
}

export type SetToolJSXFn = (tool: any) => any

// 为了兼容现有代码，创建一个泛型Tool类型
export type Tool<T = any, U = any> = {
  name: string
  description: string
  schema?: any
  isEnabled?: () => boolean
  isReadOnly?: () => boolean
  call?: (input: T, context?: any) => AsyncGenerator<U> | Promise<U>
  validateInput?: (input: T) => Promise<any>
  renderToolUseMessage?: (input: T, options?: any) => any
  renderToolResultMessage?: (output: U, options?: any) => any
  renderResultForAssistant?: (output: U) => any
  needsPermissions?: (input: T) => boolean
  userFacingName?: (input: T) => string
} 