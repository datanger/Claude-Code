import * as fs from 'fs'
import { homedir } from 'os'
import { existsSync } from 'fs'
import shellquote from 'shell-quote'
import { spawn, execSync, type ChildProcess } from 'child_process'
import { isAbsolute, resolve, join } from 'path'
import { logError } from './log.js'
import * as os from 'os'
import { logEvent } from '../services/statsig.js'
import { debugLog } from './log'

type ExecResult = {
  stdout: string
  stderr: string
  code: number
  interrupted: boolean
}
type QueuedCommand = {
  command: string
  abortSignal?: AbortSignal
  timeout?: number
  resolve: (result: ExecResult) => void
  reject: (error: Error) => void
}

const TEMPFILE_PREFIX = os.tmpdir() + '/claude-'
const DEFAULT_TIMEOUT = 30 * 60 * 1000
const SIGTERM_CODE = 143 // Standard exit code for SIGTERM
const FILE_SUFFIXES = {
  STATUS: '-status',
  STDOUT: '-stdout',
  STDERR: '-stderr',
  CWD: '-cwd',
}
const SHELL_CONFIGS: Record<string, string> = {
  '/bin/bash': '.bashrc',
  '/bin/zsh': '.zshrc',
}

export class PersistentShell {
  private commandQueue: QueuedCommand[] = []
  private isExecuting: boolean = false
  private shell: ChildProcess | null = null
  private isAlive: boolean = true
  private commandInterrupted: boolean = false
  private statusFile: string
  private stdoutFile: string
  private stderrFile: string
  private cwdFile: string
  private cwd: string
  private binShell: string

  constructor(cwd: string) {
    // Windows 系统检测
    if (process.platform === 'win32') {
      // Windows 系统使用 cmd 或 PowerShell
      this.binShell = process.env.SHELL || 'cmd.exe'
      debugLog(`🖥️ [DEBUG] Windows system detected, using shell: ${this.binShell}`)
      
      // Windows 系统不需要创建 shell 进程，直接使用 execSync
      this.shell = null as any
      this.cwd = cwd
      
      // 创建临时文件
      const id = Math.floor(Math.random() * 0x10000)
        .toString(16)
        .padStart(4, '0')
      
      this.statusFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.STATUS
      this.stdoutFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.STDOUT
      this.stderrFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.STDERR
      this.cwdFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.CWD
      
      // 初始化 CWD 文件
      fs.writeFileSync(this.cwdFile, cwd)
      
    } else {
      // Unix 系统使用 bash
      this.binShell = process.env.SHELL || '/bin/bash'
      debugLog(`🐧 [DEBUG] Unix/Linux system detected, using shell: ${this.binShell}`)
      
      // 根据操作系统调整 spawn 参数
      const spawnArgs = ['-l'] // Unix bash 参数
      
      this.shell = spawn(this.binShell, spawnArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env: {
          ...process.env,
          GIT_EDITOR: 'true',
        },
      })

      this.cwd = cwd

      this.shell.on('exit', (code, signal) => {
        if (code) {
          // TODO: It would be nice to alert the user that shell crashed
          logError(`Shell exited with code ${code} and signal ${signal}`)
          logEvent('persistent_shell_exit', {
            code: code?.toString() || 'null',
            signal: signal || 'null',
          })
        }
        for (const file of [
          this.statusFile,
          this.stdoutFile,
          this.stderrFile,
          this.cwdFile,
        ]) {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file)
          }
        }
        this.isAlive = false
      })

      const id = Math.floor(Math.random() * 0x10000)
        .toString(16)
        .padStart(4, '0')

      this.statusFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.STATUS
      this.stdoutFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.STDOUT
      this.stderrFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.STDERR
      this.cwdFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.CWD
      for (const file of [this.statusFile, this.stdoutFile, this.stderrFile]) {
        fs.writeFileSync(file, '')
      }
      // Initialize CWD file with initial directory
      fs.writeFileSync(this.cwdFile, cwd)
      const configFile = SHELL_CONFIGS[this.binShell]
      if (configFile) {
        const configFilePath = join(homedir(), configFile)
        if (existsSync(configFilePath)) {
          this.sendToShell(`source ${configFilePath}`)
        }
      }
    }
  }

  private static instance: PersistentShell | null = null

  static restart() {
    if (PersistentShell.instance) {
      PersistentShell.instance.close()
      PersistentShell.instance = null
    }
  }

  static getInstance(): PersistentShell {
    if (!PersistentShell.instance || !PersistentShell.instance.isAlive) {
      PersistentShell.instance = new PersistentShell(process.cwd())
    }
    return PersistentShell.instance
  }

  killChildren() {
    const parentPid = this.shell?.pid || 0 // Use optional chaining
    
    if (process.platform === 'win32') {
      // Windows 系统使用 tasklist 和 taskkill
      try {
        const childPids = execSync(`tasklist /FI "IMAGENAME eq cmd.exe" /FO CSV /NH`)
          .toString()
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(line => {
            const parts = line.split(',')
            return parts[1]?.replace(/"/g, '') // 移除引号
          })
          .filter(pid => pid && pid !== parentPid.toString())

        if (childPids.length > 0) {
          logEvent('persistent_shell_command_interrupted', {
            numChildProcesses: childPids.length.toString(),
          })
        }

        childPids.forEach(pid => {
          try {
            execSync(`taskkill /PID ${pid} /F`)
          } catch (error) {
            logError(`Failed to kill process ${pid}: ${error}`)
            logEvent('persistent_shell_kill_process_error', {
              error: (error as Error).message.substring(0, 10),
            })
          }
        })
      } catch (error) {
        logError(`Failed to get child processes on Windows: ${error}`)
      }
    } else {
      // Unix 系统使用 pgrep 和 kill
      try {
        const childPids = execSync(`pgrep -P ${parentPid}`)
          .toString()
          .trim()
          .split('\n')
          .filter(Boolean) // Filter out empty strings

        if (childPids.length > 0) {
          logEvent('persistent_shell_command_interrupted', {
            numChildProcesses: childPids.length.toString(),
          })
        }

        childPids.forEach(pid => {
          try {
            process.kill(Number(pid), 'SIGTERM')
          } catch (error) {
            logError(`Failed to kill process ${pid}: ${error}`)
            logEvent('persistent_shell_kill_process_error', {
              error: (error as Error).message.substring(0, 10),
            })
          }
        })
      } catch (error) {
        logError(`Failed to get child processes on Unix: ${error}`)
      }
    }
  }

  private async processQueue() {
    /**
     * Processes commands from the queue one at a time.
     * Concurrency invariants:
     * - Only one instance runs at a time (controlled by isExecuting)
     * - Is the only caller of updateCwd() in the system
     * - Calls updateCwd() after each command completes
     * - Ensures commands execute serially via the queue
     * - Handles interruption via abortSignal by calling killChildren()
     * - Cleans up abortSignal listeners after command completion or interruption
     */
    if (this.isExecuting || this.commandQueue.length === 0) return

    this.isExecuting = true
    const { command, abortSignal, timeout, resolve, reject } =
      this.commandQueue.shift()!

    const killChildren = () => this.killChildren()
    if (abortSignal) {
      abortSignal.addEventListener('abort', killChildren)
    }

    try {
      const result = await this.exec_(command, timeout)

      // No need to update cwd - it's handled in exec_ via the CWD file

      resolve(result)
    } catch (error) {
      logEvent('persistent_shell_command_error', {
        error: (error as Error).message.substring(0, 10),
      })
      reject(error as Error)
    } finally {
      this.isExecuting = false
      if (abortSignal) {
        abortSignal.removeEventListener('abort', killChildren)
      }
      // Process next command in queue
      this.processQueue()
    }
  }

  async exec(
    command: string,
    abortSignal?: AbortSignal,
    timeout?: number,
  ): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.commandQueue.push({ command, abortSignal, timeout, resolve, reject })
      this.processQueue()
    })
  }

  private async exec_(command: string, timeout?: number): Promise<ExecResult> {
    /**
     * Direct command execution without going through the queue.
     * Concurrency invariants:
     * - Not safe for concurrent calls (uses shared files)
     * - Called only when queue is idle
     * - Relies on file-based IPC to handle shell interaction
     * - Does not modify the command queue state
     * - Tracks interruption state via commandInterrupted flag
     * - Resets interruption state at start of new command
     * - Reports interruption status in result object
     *
     * Exit Code & CWD Handling:
     * - Executes command and immediately captures its exit code into a shell variable
     * - Updates the CWD file with the working directory after capturing exit code
     * - Writes the preserved exit code to the status file as the final step
     * - This sequence eliminates race conditions between exit code capture and CWD updates
     * - The pwd() method reads the CWD file directly for current directory info
     */
    
    if (process.platform === 'win32') {
      // Windows 系统使用简化的执行方式
      return this.execWindows_(command, timeout)
    } else {
      // Unix 系统使用原有的执行方式
      return this.execUnix_(command, timeout)
    }
  }

  private async execWindows_(command: string, timeout?: number): Promise<ExecResult> {
    const commandTimeout = timeout || DEFAULT_TIMEOUT
    this.commandInterrupted = false
    
    return new Promise<ExecResult>(resolve => {
      // 使用 execSync 直接执行命令
      let stdout = ''
      let stderr = ''
      let code = 0
      
      try {
        const result = execSync(command, {
          encoding: 'utf8',
          timeout: commandTimeout,
          cwd: this.cwd,
        })
        stdout = result
        code = 0
      } catch (error: any) {
        if (error.status !== undefined) {
          code = error.status
          stdout = error.stdout || ''
          stderr = error.stderr || ''
        } else {
          code = 1
          stderr = error.message || 'Unknown error'
        }
      }
      
      resolve({
        stdout,
        stderr,
        code,
        interrupted: this.commandInterrupted,
      })
    })
  }

  private async execUnix_(command: string, timeout?: number): Promise<ExecResult> {
    // Windows 和 Unix 系统的命令处理逻辑
    let quotedCommand: string
    let syntaxCheckCommand: string
    let commandParts: string[]
    
    // Unix 系统使用 bash 语法
    quotedCommand = shellquote.quote([command])
    syntaxCheckCommand = `${this.binShell} -n -c ${quotedCommand}`
    
    // Unix 命令执行逻辑
    commandParts = [
      // 1. Execute the main command with redirections
      `eval ${quotedCommand} < /dev/null > ${this.stdoutFile} 2> ${this.stderrFile}`,
      // 2. Capture exit code immediately after command execution to avoid losing it
      `EXEC_EXIT_CODE=$?`,
      // 3. Update CWD file
      `pwd > ${this.cwdFile}`,
      // 4. Write the preserved exit code to status file to avoid race with pwd
      `echo $EXEC_EXIT_CODE > ${this.statusFile}`,
    ]

    // Check the syntax of the command
    try {
      execSync(syntaxCheckCommand, {
        stdio: 'ignore',
        timeout: 1000,
      })
    } catch (stderr) {
      // If there's a syntax error, return an error and log it
      const errorStr =
        typeof stderr === 'string' ? stderr : String(stderr || '')
      logEvent('persistent_shell_syntax_error', {
        error: errorStr.substring(0, 10),
      })
      return Promise.resolve({
        stdout: '',
        stderr: errorStr,
        code: 128,
        interrupted: false,
      })
    }

    const commandTimeout = timeout || DEFAULT_TIMEOUT
    // Reset interrupted state for new command
    this.commandInterrupted = false
    return new Promise<ExecResult>(resolve => {
      // Truncate output files
      fs.writeFileSync(this.stdoutFile, '')
      fs.writeFileSync(this.stderrFile, '')
      fs.writeFileSync(this.statusFile, '')

      // Send the combined commands as a single operation to maintain atomicity
      this.sendToShell(commandParts.join('\n'))

      // Check for command completion or timeout
      const start = Date.now()
      const checkCompletion = setInterval(() => {
        try {
          let statusFileSize = 0
          if (fs.existsSync(this.statusFile)) {
            statusFileSize = fs.statSync(this.statusFile).size
          }

          if (
            statusFileSize > 0 ||
            Date.now() - start > commandTimeout ||
            this.commandInterrupted
          ) {
            clearInterval(checkCompletion)
            const stdout = fs.existsSync(this.stdoutFile)
              ? fs.readFileSync(this.stdoutFile, 'utf8')
              : ''
            let stderr = fs.existsSync(this.stderrFile)
              ? fs.readFileSync(this.stderrFile, 'utf8')
              : ''
            let code: number
            if (statusFileSize) {
              code = Number(fs.readFileSync(this.statusFile, 'utf8'))
            } else {
              // Timeout occurred - kill any running processes
              this.killChildren()
              code = SIGTERM_CODE
              stderr += (stderr ? '\n' : '') + 'Command execution timed out'
              logEvent('persistent_shell_command_timeout', {
                command: command.substring(0, 10),
                timeout: commandTimeout.toString(),
              })
            }
            resolve({
              stdout,
              stderr,
              code,
              interrupted: this.commandInterrupted,
            })
          }
        } catch {
          // Ignore file system errors during polling - they are expected
          // as we check for completion before files exist
        }
      }, 10) // increasing this will introduce latency
    })
  }

  private sendToShell(command: string) {
    // Windows 系统不需要 sendToShell
    if (process.platform === 'win32' || !this.shell) {
      return
    }
    
    try {
      this.shell.stdin!.write(command + '\n')
    } catch (error) {
      const errorString =
        error instanceof Error
          ? error.message
          : String(error || 'Unknown error')
      logError(`Error in sendToShell: ${errorString}`)
      logEvent('persistent_shell_write_error', {
        error: errorString.substring(0, 100),
        command: command.substring(0, 30),
      })
      throw error
    }
  }

  pwd(): string {
    try {
      const newCwd = fs.readFileSync(this.cwdFile, 'utf8').trim()
      if (newCwd) {
        this.cwd = newCwd
      }
    } catch (error) {
      logError(`Shell pwd error ${error}`)
    }
    // Always return the cached value
    return this.cwd
  }

  async setCwd(cwd: string) {
    const resolved = isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd)
    if (!existsSync(resolved)) {
      throw new Error(`Path "${resolved}" does not exist`)
    }
    await this.exec(`cd ${resolved}`)
  }

  close(): void {
    if (this.shell) {
      this.shell.stdin!.end()
      this.shell.kill()
    }
  }
}
