import { MessageType } from '../utils/messages.js'
import { Tool } from '../Tool.js'

export async function loadMessagesFromLog(
  logPath: string,
  tools: Tool[]
): Promise<MessageType[]> {
  // 简单的实现，返回空数组
  console.warn(`Loading messages from log: ${logPath} (not implemented)`)
  return []
}

export function deserializeMessages(
  serialized: string,
  tools: Tool[]
): MessageType[] {
  // 简单的实现，返回空数组
  console.warn('Deserializing messages (not implemented)')
  return []
} 