import { last } from 'lodash-es'
import { Command } from '../commands.js'
import { getSystemPrompt } from '../constants/prompts.js'
import { getContext } from '../context.js'
import { getTotalCost } from '../cost-tracker.js'
import { Message, query } from '../query.js'
import { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { Tool } from '../Tool.js'
import { getSlowAndCapableModel } from '../utils/model.js'
import { setCwd } from './state.js'
import { getMessagesPath, overwriteLog, debugLog } from './log.js'
import { createUserMessage } from './messages.js'

type Props = {
  commands: Command[]
  dangerouslySkipPermissions?: boolean
  hasPermissionsToUseTool: CanUseToolFn
  messageLogName: string
  prompt: string
  cwd: string
  tools: Tool[]
  verbose?: boolean
  provider?: string
  model?: string
}

// Sends a single prompt to the Claude API and returns the response.
// Assumes that claude is being used non-interactively -- will not
// ask the user for permissions or further input.
export async function ask({
  commands,
  dangerouslySkipPermissions,
  hasPermissionsToUseTool,
  messageLogName,
  prompt,
  cwd,
  tools,
  verbose = false,
  provider,
  model,
}: Props): Promise<{
  resultText: string
  totalCost: number
  messageHistoryFile: string
}> {
  
  debugLog(`📝 [DEBUG] Processing prompt: "${prompt}"`)
  debugLog(`📁 [DEBUG] Working directory: ${cwd}`)
  debugLog(`🔧 [DEBUG] Available tools: ${tools.map(t => t.name).join(', ')}`)
  debugLog(`🔐 [DEBUG] dangerouslySkipPermissions: ${dangerouslySkipPermissions}`)
  debugLog(`📊 [DEBUG] Message log name: ${messageLogName}`)
  debugLog(`⚙️ [DEBUG] Commands count: ${commands.length}`)
  debugLog(`🛠️ [DEBUG] Tools count: ${tools.length}`)
  debugLog(`📢 [DEBUG] Verbose mode: ${verbose}`)
  debugLog(`🤖 [DEBUG] Provider: ${provider || 'auto'}`)
  debugLog(`🔧 [DEBUG] Model: ${model || 'auto'}`)

  await setCwd(cwd)
  debugLog(`📂 [DEBUG] Working directory set to: ${cwd}`)
  
  const message = createUserMessage(prompt)
  const messages: Message[] = [message]
  debugLog(`💬 [DEBUG] Created user message, total messages: ${messages.length}`)

  debugLog(`🚀 [DEBUG] Preparing to get system prompt, context, and model...`)
  
  // 如果传入了 model 参数，直接使用它，避免调用 getSlowAndCapableModel()
  let finalModel: string
  let systemPrompt: string[]
  let context: { [k: string]: string }
  
  if (model) {
    debugLog(`🎯 [DEBUG] Using provided model: ${model}`)
    finalModel = model
    const [prompt, ctx] = await Promise.all([
      getSystemPrompt(),
      getContext(),
    ])
    systemPrompt = prompt
    context = ctx
    debugLog(`✅ [DEBUG] Got system prompt (${systemPrompt.length} items) and context`)
  } else {
    debugLog(`🔄 [DEBUG] No model provided, getting default model...`)
    const [defaultSystemPrompt, defaultContext, defaultModel] = await Promise.all([
      getSystemPrompt(),
      getContext(),
      getSlowAndCapableModel(),
    ])
    systemPrompt = defaultSystemPrompt
    context = defaultContext
    finalModel = defaultModel
    debugLog(`✅ [DEBUG] Got system prompt (${systemPrompt.length} items), context, and default model: ${finalModel}`)
  }

  debugLog(`🌐 [DEBUG] About to call query() function (LLM API call)...`)
  debugLog(`⏱️ [DEBUG] LLM API call started at: ${new Date().toISOString()}`)
  
  // 如果指定了 provider，创建一个自定义的 provider 配置
  const customProviderConfig = provider ? {
    provider: provider as any,
    model: finalModel,
    skipPermissions: provider !== 'anthropic'
  } : undefined
  
  for await (const m of query(
    messages,
    systemPrompt,
    context,
    hasPermissionsToUseTool,
    {
      options: {
        commands,
        tools,
        verbose,
        dangerouslySkipPermissions,
        slowAndCapableModel: finalModel,
        forkNumber: 0,
        messageLogName: 'unused',
        maxThinkingTokens: 0,
        customProviderConfig, // 传递自定义 provider 配置
      },
      abortController: new AbortController(),
      messageId: undefined,
      readFileTimestamps: {},
    },
  )) {
    messages.push(m)
    debugLog(`📨 [DEBUG] Received message type: ${m.type}, total messages: ${messages.length}`)
  }

  debugLog(`✅ [DEBUG] LLM API call completed successfully`)
  debugLog(`⏱️ [DEBUG] LLM API call finished at: ${new Date().toISOString()}`)

  const result = last(messages)
  if (!result || result.type !== 'assistant') {
    console.error(`❌ [DEBUG] Expected assistant message but got: ${result?.type}`)
    throw new Error('Expected content to be an assistant message')
  }
  if (result.message.content[0]?.type !== 'text') {
    console.error(`❌ [DEBUG] Expected text content but got: ${result.message.content[0]?.type}`)
    throw new Error('Expected content to be text')
  }

  const resultText = result.message.content[0].text
  const totalCost = getTotalCost()
  const messageHistoryFile = getMessagesPath(messageLogName)

  debugLog(`📝 [DEBUG] Final result text length: ${resultText.length}`)
  debugLog(`💰 [DEBUG] Total cost: $${totalCost.toFixed(6)}`)
  debugLog(`📁 [DEBUG] Message history file: ${messageHistoryFile}`)

  await overwriteLog(messageHistoryFile, messages)
  debugLog(`💾 [DEBUG] Saved message history to: ${messageHistoryFile}`)

  return {
    resultText,
    totalCost,
    messageHistoryFile,
  }
}
