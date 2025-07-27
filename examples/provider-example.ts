/**
 * Multi-Provider Usage Example
 */

import { 
  getProviderManager, 
  switchProvider, 
  generateContent,
  getCurrentProviderType 
} from '../src/services/providers/index.js'

async function example() {
  console.log('🚀 Multi-Provider Example\n')
  
  try {
    // Get the provider manager
    const manager = await getProviderManager()
    
    // Check current provider
    const currentProvider = await getCurrentProviderType()
    console.log(`Current provider: ${currentProvider}`)
    
    // List available providers
    const availableProviders = manager.getAvailableProviders()
    console.log('Available providers:', availableProviders)
    
    // Test with different providers
    const providers = ['claude', 'openai', 'deepseek']
    
    for (const provider of providers) {
      try {
        console.log(`\n--- Testing ${provider} ---`)
        
        // Switch to provider
        await switchProvider(provider)
        
        // Generate content
        const response = await generateContent({
          messages: [
            {
              type: 'user',
              message: { content: [{ text: 'Hello! Please introduce yourself briefly.' }] },
              uuid: 'test-uuid'
            }
          ],
          systemPrompt: ['You are a helpful AI assistant.'],
          tools: [],
          signal: new AbortController().signal,
          options: {
            dangerouslySkipPermissions: false,
            model: 'default',
            prependCLISysprompt: false
          }
        })
        
        console.log(`Response: ${response.content.substring(0, 100)}...`)
        console.log(`Cost: $${response.costUSD.toFixed(4)}`)
        
      } catch (error) {
        console.error(`Error with ${provider}:`, error)
      }
    }
    
    console.log('\n✅ Example completed!')
  } catch (error) {
    console.error('\n❌ Error:', error)
  }
}

export { example }

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  example()
} 