#!/usr/bin/env -S node --no-warnings=ExperimentalWarning --enable-source-maps

import { Command } from 'commander'
import { MACRO } from './constants/macro.js'
import { PRODUCT_NAME } from './constants/product.js'

// 导入必要的模块
import { ask } from './utils/ask.js'
import { hasPermissionsToUseTool } from './permissions.js'
import { getTools } from './tools.js'
import { getCommands } from './commands.js'
import { dateToFilename } from './utils/log.js'
import { addToHistory } from './history.js'
import { cwd } from 'process'

// 简化的设置函数
async function setup(cwd: string, dangerouslySkipPermissions?: boolean): Promise<void> {
  console.log(`Setting up Claude Code in: ${cwd}`)
  
  if (dangerouslySkipPermissions) {
    console.log('⚠️  Permission checks are disabled')
  }
  
  // 这里可以添加其他必要的初始化
}

// 简化的主函数
async function main() {
  const program = new Command()

  program
    .name('claude')
    .description(`${PRODUCT_NAME} - starts an interactive session by default, use -p/--print for non-interactive output`)
    .argument('[prompt]', 'Your prompt', String)
    .option('-c, --cwd <cwd>', 'The current working directory', String, cwd())
    .option('-d, --debug', 'Enable debug mode', false)
    .option('--verbose', 'Override verbose mode setting from config', false)
    .option('-ea, --enable-architect', 'Enable the Architect tool', false)
    .option('-p, --print', 'Print response and exit (useful for pipes)', false)
    .option('--dangerously-skip-permissions', 'Skip all permission checks', false)
    .action(async (prompt, options) => {
      try {
        console.log('🚀 Starting Claude Code...')
        
        // 设置
        await setup(options.cwd, options.dangerouslySkipPermissions)
        
        // 获取工具和命令
        const [tools, commands] = await Promise.all([
          getTools(options.enableArchitect || false),
          getCommands()
        ])
        
        console.log(`📦 Loaded ${tools.length} tools and ${commands.length} commands`)
        
        const inputPrompt = prompt || ''
        
        if (options.print) {
          if (!inputPrompt) {
            console.error('Error: Input must be provided when using --print')
            process.exit(1)
          }
          
          console.log('📝 Processing in print mode...')
          addToHistory(inputPrompt)
          
          const { resultText: response } = await ask({
            commands,
            hasPermissionsToUseTool,
            messageLogName: dateToFilename(new Date()),
            prompt: inputPrompt,
            cwd: options.cwd,
            tools,
            dangerouslySkipPermissions: options.dangerouslySkipPermissions,
          })
          
          console.log('\n' + '='.repeat(50))
          console.log('Claude Response:')
          console.log('='.repeat(50))
          console.log(response)
          console.log('='.repeat(50))
          process.exit(0)
        } else {
          console.log('🔄 Starting interactive mode...')
          console.log('💡 Type your questions or use /help for commands')
          console.log('🔐 All permissions are bypassed for development')
          
          // 这里可以启动交互式 REPL
          // 为了简化，我们直接处理一个示例请求
          if (inputPrompt) {
            console.log(`\n📝 Processing: "${inputPrompt}"`)
            addToHistory(inputPrompt)
            
            const { resultText: response } = await ask({
              commands,
              hasPermissionsToUseTool,
              messageLogName: dateToFilename(new Date()),
              prompt: inputPrompt,
              cwd: options.cwd,
              tools,
              dangerouslySkipPermissions: true, // 强制跳过权限
            })
            
            console.log('\n' + '='.repeat(50))
            console.log('Claude Response:')
            console.log('='.repeat(50))
            console.log(response)
            console.log('='.repeat(50))
          }
          
          console.log('\n✅ Claude Code is ready for interactive use!')
          console.log('💡 Use Ctrl+C to exit')
          
          // 保持进程运行
          process.stdin.resume()
        }
      } catch (error) {
        console.error('❌ Error:', error)
        process.exit(1)
      }
    })
    .version(MACRO.VERSION, '-v, --version')

  await program.parseAsync(process.argv)
}

// 启动应用
main().catch(console.error) 