import React, { useState, useEffect } from 'react'
import { ProviderConfigManager } from '../services/providers/config.js'
import { ProviderType } from '../services/providers/manager.js'
import { ProviderConfig } from '../services/providers/base.js'

interface ProviderSelectorProps {
  onProviderChange?: (providerType: ProviderType) => void
  currentProvider?: ProviderType
}

export const ProviderSelector: React.FC<ProviderSelectorProps> = ({
  onProviderChange,
  currentProvider
}) => {
  const [configManager] = useState(() => ProviderConfigManager.getInstance())
  const [providerManager, setProviderManager] = useState<any>(null)
  const [selectedProvider, setSelectedProvider] = useState<ProviderType>('claude')
  const [availableProviders, setAvailableProviders] = useState<ProviderType[]>([])
  const [configuredProviders, setConfiguredProviders] = useState<ProviderType[]>([])
  const [providerConfigs, setProviderConfigs] = useState<Record<ProviderType, ProviderConfig>>({} as any)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    initializeProviderManager()
  }, [])

  useEffect(() => {
    if (currentProvider && providerManager) {
      setSelectedProvider(currentProvider)
      providerManager.switchProvider(currentProvider)
    }
  }, [currentProvider, providerManager])

  const initializeProviderManager = async () => {
    try {
      setLoading(true)
      const manager = await configManager.loadProviderManager()
      setProviderManager(manager)
      
      const available = manager.getAvailableProviders()
      setAvailableProviders(available)
      
      const configured = await configManager.getConfiguredProviders()
      setConfiguredProviders(configured)
      
      const configs = await configManager.getAllProviderConfigs()
      setProviderConfigs(configs)
      
      const current = manager.getCurrentProviderType()
      setSelectedProvider(current)
      
      if (onProviderChange) {
        onProviderChange(current)
      }
    } catch (error) {
      console.error('Failed to initialize provider manager:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleProviderChange = async (providerType: ProviderType) => {
    if (!providerManager) return
    
    try {
      providerManager.switchProvider(providerType)
      setSelectedProvider(providerType)
      
      if (onProviderChange) {
        onProviderChange(providerType)
      }
    } catch (error) {
      console.error(`Failed to switch to provider ${providerType}:`, error)
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

  const getProviderStatus = (providerType: ProviderType): 'configured' | 'available' | 'unavailable' => {
    if (configuredProviders.includes(providerType)) {
      return 'configured'
    }
    if (availableProviders.includes(providerType)) {
      return 'available'
    }
    return 'unavailable'
  }

  const getProviderIcon = (providerType: ProviderType): string => {
    const icons: Record<ProviderType, string> = {
      claude: '🤖',
      openai: '🧠',
      deepseek: '🔍',
      local: '🏠'
    }
    return icons[providerType] || '❓'
  }

  if (loading) {
    return (
      <div className="provider-selector loading">
        <div className="loading-spinner">Loading providers...</div>
      </div>
    )
  }

  return (
    <div className="provider-selector">
      <div className="provider-selector-header">
        <h3>AI Provider</h3>
        <span className="current-provider">
          {getProviderIcon(selectedProvider)} {getProviderDisplayName(selectedProvider)}
        </span>
      </div>
      
      <div className="provider-list">
        {availableProviders.map((providerType) => {
          const status = getProviderStatus(providerType)
          const isSelected = selectedProvider === providerType
          const isConfigured = status === 'configured'
          
          return (
            <div
              key={providerType}
              className={`provider-option ${isSelected ? 'selected' : ''} ${status}`}
              onClick={() => handleProviderChange(providerType)}
            >
              <div className="provider-info">
                <span className="provider-icon">{getProviderIcon(providerType)}</span>
                <span className="provider-name">{getProviderDisplayName(providerType)}</span>
                <span className="provider-status">
                  {isConfigured ? '✓ Configured' : '⚙️ Needs Setup'}
                </span>
              </div>
              
              {isSelected && (
                <div className="provider-details">
                  <div className="provider-model">
                    Model: {providerConfigs[providerType]?.model || 'Default'}
                  </div>
                  {providerConfigs[providerType]?.baseUrl && (
                    <div className="provider-url">
                      URL: {providerConfigs[providerType].baseUrl}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      
      <div className="provider-help">
        <h4>Setup Instructions</h4>
        <div className="setup-instructions">
          {availableProviders.map((providerType) => {
            const suggestions = configManager.getEnvironmentVariableSuggestions()[providerType]
            if (!suggestions || suggestions.length === 0) return null
            
            return (
              <div key={providerType} className="setup-instruction">
                <strong>{getProviderDisplayName(providerType)}:</strong>
                <ul>
                  {suggestions.map((suggestion, index) => (
                    <li key={index}>
                      <code>{suggestion}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default ProviderSelector 