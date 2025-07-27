import { useCallback, useState } from 'react'
import { verifyApiKey } from '../services/claude.js'
import { getAnthropicApiKey, isDefaultApiKey } from '../utils/config.js'

export type VerificationStatus =
  | 'loading'
  | 'valid'
  | 'invalid'
  | 'missing'
  | 'error'

export type ApiKeyVerificationResult = {
  status: VerificationStatus
  reverify: () => Promise<void>
  error: Error | null
}

export function useApiKeyVerification(): ApiKeyVerificationResult {
  const [status, setStatus] = useState<VerificationStatus>(() => {
    // 检查是否启用了多提供商模式
    const useMultiProvider = process.env.USE_MULTI_PROVIDER === 'true' || 
                           process.env.CLAUDE_PROVIDER !== undefined
    
    if (useMultiProvider) {
      const currentProvider = process.env.CLAUDE_PROVIDER || 'claude'
      const apiKey = getProviderApiKey(currentProvider)
      return apiKey ? 'loading' : 'missing'
    } else {
      const apiKey = getAnthropicApiKey()
      return apiKey ? 'loading' : 'missing'
    }
  })
  const [error, setError] = useState<Error | null>(null)

  const verify = useCallback(async (): Promise<void> => {
    // 检查是否启用了多提供商模式
    const useMultiProvider = process.env.USE_MULTI_PROVIDER === 'true' || 
                           process.env.CLAUDE_PROVIDER !== undefined
    
    if (useMultiProvider) {
      const currentProvider = process.env.CLAUDE_PROVIDER || 'claude'
      const apiKey = getProviderApiKey(currentProvider)
      
      if (!apiKey) {
        setStatus('missing')
        return
      }
      
      // 对于多提供商模式，我们假设API密钥是有效的
      // 因为验证会在实际使用时进行
      setStatus('valid')
      return
    } else {
      // 原有的Claude验证逻辑
      if (isDefaultApiKey()) {
        setStatus('valid')
        return
      }

      const apiKey = getAnthropicApiKey()
      if (!apiKey) {
        const newStatus = 'missing' as const
        setStatus(newStatus)
        return
      }

      try {
        const isValid = await verifyApiKey(apiKey)
        const newStatus = isValid ? 'valid' : 'invalid'
        setStatus(newStatus)
        return
      } catch (error) {
        // This happens when there an error response from the API but it's not an invalid API key error
        // In this case, we still mark the API key as invalid - but we also log the error so we can
        // display it to the user to be more helpful
        setError(error as Error)
        const newStatus = 'error' as const
        setStatus(newStatus)
        return
      }
    }
  }, [])

  return {
    status,
    reverify: verify,
    error,
  }
}

// 获取指定提供商的API密钥
function getProviderApiKey(providerType: string): string | null {
  switch (providerType) {
    case 'claude':
      return getAnthropicApiKey()
    case 'openai':
      return process.env.OPENAI_API_KEY || null
    case 'deepseek':
      return process.env.DEEPSEEK_API_KEY || null
    case 'local':
      // 本地模型通常不需要API密钥，但需要base URL
      return process.env.LOCAL_BASE_URL ? 'local-configured' : null
    default:
      return null
  }
}
