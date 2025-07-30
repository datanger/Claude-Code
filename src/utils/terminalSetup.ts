import { platform } from 'os'
import { execFileNoThrow } from './execFileNoThrow.js'

export interface TerminalInfo {
  name: string
  backspaceKey: string
  deleteKey: string
  supportsBackspace: boolean
}

export async function detectTerminal(): Promise<TerminalInfo> {
  const term = process.env.TERM || 'unknown'
  const platformName = platform()
  
  // Common terminal configurations
  const terminals: Record<string, TerminalInfo> = {
    'xterm': {
      name: 'xterm',
      backspaceKey: '\x08',
      deleteKey: '\x1b[3~',
      supportsBackspace: true
    },
    'xterm-256color': {
      name: 'xterm-256color',
      backspaceKey: '\x08',
      deleteKey: '\x1b[3~',
      supportsBackspace: true
    },
    'linux': {
      name: 'linux',
      backspaceKey: '\x7f',
      deleteKey: '\x1b[3~',
      supportsBackspace: true
    },
    'screen': {
      name: 'screen',
      backspaceKey: '\x08',
      deleteKey: '\x1b[3~',
      supportsBackspace: true
    },
    'tmux': {
      name: 'tmux',
      backspaceKey: '\x08',
      deleteKey: '\x1b[3~',
      supportsBackspace: true
    }
  }
  
  // Try to detect terminal from environment
  const terminalName = process.env.TERM_PROGRAM || 
                      process.env.TERMINAL_PROGRAM || 
                      term.split('-')[0]
  
  const detected = terminals[terminalName] || terminals[term] || {
    name: terminalName || 'unknown',
    backspaceKey: '\x08',
    deleteKey: '\x1b[3~',
    supportsBackspace: true
  }
  
  // Test backspace key support
  try {
    const { code } = await execFileNoThrow('stty', ['-a'])
    if (code === 0) {
      detected.supportsBackspace = true
    }
  } catch {
    // If stty fails, assume basic support
    detected.supportsBackspace = true
  }
  
  return detected
}

export function getBackspaceSequences(): string[] {
  return [
    '\x08',    // ASCII backspace
    '\x7f',    // ASCII delete (often mapped to backspace)
    '\x1b\x7f', // Escape sequence for backspace
    '\x1b\x08', // Another escape sequence
  ]
}

export function isBackspaceSequence(input: string): boolean {
  const sequences = getBackspaceSequences()
  return sequences.some(seq => input === seq || 
    (input.length === 1 && (input.charCodeAt(0) === 8 || input.charCodeAt(0) === 127)) ||
    (input.startsWith('\x1b') && (input.includes('\x7f') || input.includes('\x08')))
  )
} 