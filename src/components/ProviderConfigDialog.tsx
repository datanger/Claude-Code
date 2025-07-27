import React, { useState, useEffect } from 'react'
import { ProviderConfigManager } from '../services/providers/config.js'
import { ProviderType } from '../services/providers/manager.js'
import { ProviderConfig } from '../services/providers/base.js'

interface ProviderConfigDialogProps {
  isOpen: boolean
  onClose: () => void
  providerType?: ProviderType
}

export const ProviderConfigDialog: React.FC<ProviderConfigDialogProps> = ({
  isOpen,
  onClose,
  providerType
}) => {
  const [configManager] = useState(() => ProviderConfigManager.getInstance())
  const [selectedProvider, setSelectedProvider] = useState<ProviderType>('claude')
  const [config, setConfig] = useState<ProviderConfig>({
    apiKey: '',
    baseUrl: '',
    model: '',
    temperature: 1,
    maxTokens: 4096
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    if (providerType) {
      setSelectedProvider(providerType)
    }
  }, [providerType])

  useEffect(() => {
    if (isOpen) {
      loadProviderConfig()
    }
  }, [isOpen, selectedProvider])

  const loadProviderConfig = async () => {
    try {
      setLoading(true)
      setError(null)
      
      const currentConfig = await configManager.getProviderConfig(selectedProvider)
      if (currentConfig) {
        setConfig({
          apiKey: currentConfig.apiKey || '',
          baseUrl: currentConfig.baseUrl || '',
          model: currentConfig.model || '',
          temperature: currentConfig.temperature || 1,
          maxTokens: currentConfig.maxTokens || 4096
        })
      } else {
        // 设置默认值
        const defaults: Record<ProviderType, Partial<ProviderConfig>> = {
          claude: {
            model: 'claude-3-5-sonnet-20241022',
            baseUrl: ''
          },
          openai: {
            model: 'gpt-4o',
            baseUrl: 'https://api.openai.com/v1'
          },
          deepseek: {
            model: 'deepseek-chat',
            baseUrl: 'https://api.deepseek.com/v1'
          },
          local: {
            model: 'llama-3.1-8b',
            baseUrl: 'http://localhost:11434'
          }
        }
        
        setConfig({
          apiKey: '',
          baseUrl: defaults[selectedProvider]?.baseUrl || '',
          model: defaults[selectedProvider]?.model || '',
          temperature: 1,
          maxTokens: 4096
        })
      }
    } catch (error) {
      setError('Failed to load provider configuration')
      console.error('Error loading provider config:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    try {
      setLoading(true)
      setError(null)
      setSuccess(null)

      // 验证配置
      const validation = await configManager.validateProviderConfig(selectedProvider, config)
      if (!validation.valid) {
        setError(validation.error || 'Invalid configuration')
        return
      }

      // 保存配置
      await configManager.updateProviderConfig(selectedProvider, config)
      setSuccess('Configuration saved successfully!')
      
      // 延迟关闭对话框
      setTimeout(() => {
        onClose()
      }, 1500)
    } catch (error) {
      setError('Failed to save configuration')
      console.error('Error saving provider config:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleReset = async () => {
    try {
      setLoading(true)
      setError(null)
      
      await configManager.resetProviderConfig(selectedProvider)
      await loadProviderConfig()
      setSuccess('Configuration reset to defaults')
    } catch (error) {
      setError('Failed to reset configuration')
      console.error('Error resetting provider config:', error)
    } finally {
      setLoading(false)
    }
  }

  const getProviderDisplayName = (providerType: ProviderType): string => {
    const names: Record<ProviderType, string> = {
      claude: 'Claude (Anthropic)',
      openai: 'OpenAI',
      deepseek: 'DeepSeek',
      local: 'Local Model'
    }
    return names[providerType] || providerType
  }

  const getProviderModels = (providerType: ProviderType): string[] => {
    const models: Record<ProviderType, string[]> = {
      claude: ['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307', 'claude-3-opus-20240229'],
      openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
      deepseek: ['deepseek-chat', 'deepseek-coder', 'deepseek-vision'],
      local: ['llama-3.1-8b', 'llama-3.1-70b', 'mistral-7b', 'codellama-34b']
    }
    return models[providerType] || []
  }

  if (!isOpen) return null

  return (
    <div className="provider-config-dialog-overlay">
      <div className="provider-config-dialog">
        <div className="dialog-header">
          <h2>Configure {getProviderDisplayName(selectedProvider)}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        <div className="dialog-content">
          {loading && (
            <div className="loading-message">Loading configuration...</div>
          )}

          {error && (
            <div className="error-message">{error}</div>
          )}

          {success && (
            <div className="success-message">{success}</div>
          )}

          <div className="config-form">
            <div className="form-group">
              <label htmlFor="provider-select">Provider:</label>
              <select
                id="provider-select"
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value as ProviderType)}
                disabled={loading}
              >
                <option value="claude">Claude (Anthropic)</option>
                <option value="openai">OpenAI</option>
                <option value="deepseek">DeepSeek</option>
                <option value="local">Local Model</option>
              </select>
            </div>

            {selectedProvider !== 'local' && (
              <div className="form-group">
                <label htmlFor="api-key">API Key:</label>
                <input
                  id="api-key"
                  type="password"
                  value={config.apiKey}
                  onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
                  placeholder="Enter your API key"
                  disabled={loading}
                />
              </div>
            )}

            <div className="form-group">
              <label htmlFor="base-url">Base URL:</label>
              <input
                id="base-url"
                type="url"
                value={config.baseUrl}
                onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })}
                placeholder="API base URL"
                disabled={loading}
              />
            </div>

            <div className="form-group">
              <label htmlFor="model">Model:</label>
              <select
                id="model"
                value={config.model}
                onChange={(e) => setConfig({ ...config, model: e.target.value })}
                disabled={loading}
              >
                <option value="">Select a model</option>
                {getProviderModels(selectedProvider).map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="temperature">Temperature:</label>
              <input
                id="temperature"
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={config.temperature}
                onChange={(e) => setConfig({ ...config, temperature: parseFloat(e.target.value) })}
                disabled={loading}
              />
              <span className="range-value">{config.temperature}</span>
            </div>

            <div className="form-group">
              <label htmlFor="max-tokens">Max Tokens:</label>
              <input
                id="max-tokens"
                type="number"
                min="1"
                max="32768"
                value={config.maxTokens}
                onChange={(e) => setConfig({ ...config, maxTokens: parseInt(e.target.value) })}
                disabled={loading}
              />
            </div>
          </div>

          <div className="environment-vars">
            <h4>Environment Variables</h4>
            <p>You can also configure this provider using environment variables:</p>
            <div className="env-suggestions">
              {configManager.getEnvironmentVariableSuggestions()[selectedProvider]?.map((suggestion, index) => (
                <code key={index} className="env-suggestion">{suggestion}</code>
              ))}
            </div>
          </div>
        </div>

        <div className="dialog-footer">
          <button
            className="reset-button"
            onClick={handleReset}
            disabled={loading}
          >
            Reset to Defaults
          </button>
          <div className="action-buttons">
            <button
              className="cancel-button"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </button>
            <button
              className="save-button"
              onClick={handleSave}
              disabled={loading}
            >
              {loading ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ProviderConfigDialog 