/**
 * Multi-Provider Usage Examples
 * 
 * This file demonstrates how to use the new multi-provider functionality
 * to work with different AI providers seamlessly.
 */

import { 
  getProviderManager, 
  switchProvider, 
  generateContent,
  getCurrentProviderType,
  ProviderType 
} from '../src/services/providers/index.js'

// Example 1: Basic provider switching
async function basicProviderSwitching() {
  console.log('=== Basic Provider Switching ===')
  
  // Get the provider manager
  const manager = await getProviderManager()
  
  // Check current provider
  const currentProvider = await getCurrentProviderType()
  console.log(`Current provider: ${currentProvider}`)
  
  // List available providers
  const availableProviders = manager.getAvailableProviders()
  console.log('Available providers:', availableProviders)
  
  // Switch to OpenAI
  await switchProvider('openai')
  console.log('Switched to OpenAI')
  
  // Switch back to Claude
  await switchProvider('claude')
  console.log('Switched back to Claude')
}

// Example 2: Generate content with different providers
async function generateContentWithProviders() {
  console.log('\n=== Generate Content with Different Providers ===')
  
  const testRequest = {
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
  }
  
  const providers: ProviderType[] = ['claude', 'openai', 'deepseek']
  
  for (const provider of providers) {
    try {
      console.log(`\n--- Testing ${provider} ---`)
      
      // Switch to provider
      await switchProvider(provider)
      
      // Generate content
      const response = await generateContent(testRequest)
      
      console.log(`Provider: ${provider}`)
      console.log(`Response: ${response.content.substring(0, 100)}...`)
      console.log(`Cost: $${response.costUSD.toFixed(4)}`)
      console.log(`Duration: ${response.durationMs}ms`)
      
    } catch (error) {
      console.error(`Error with ${provider}:`, error)
    }
  }
}

// Example 3: Streaming with different providers
async function streamingWithProviders() {
  console.log('\n=== Streaming with Different Providers ===')
  
  const testRequest = {
    messages: [
      {
        type: 'user',
        message: { content: [{ text: 'Write a short story about a robot learning to paint.' }] },
        uuid: 'test-uuid'
      }
    ],
    systemPrompt: ['You are a creative storyteller.'],
    tools: [],
    signal: new AbortController().signal,
    options: {
      dangerouslySkipPermissions: false,
      model: 'default',
      prependCLISysprompt: false
    }
  }
  
  const providers: ProviderType[] = ['claude', 'openai']
  
  for (const provider of providers) {
    try {
      console.log(`\n--- Streaming with ${provider} ---`)
      
      // Switch to provider
      await switchProvider(provider)
      
      // Generate streaming content
      let fullContent = ''
      let chunkCount = 0
      
      for await (const chunk of generateContentStream(testRequest)) {
        fullContent += chunk.content
        chunkCount++
        
        // Print first few chunks
        if (chunkCount <= 3) {
          console.log(`Chunk ${chunkCount}: ${chunk.content}`)
        }
        
        if (chunk.isComplete) {
          console.log(`Final cost: $${chunk.costUSD?.toFixed(4) || 'N/A'}`)
          break
        }
      }
      
      console.log(`Total chunks: ${chunkCount}`)
      console.log(`Full content length: ${fullContent.length} characters`)
      
    } catch (error) {
      console.error(`Error streaming with ${provider}:`, error)
    }
  }
}

// Example 4: Tool usage with different providers
async function toolUsageWithProviders() {
  console.log('\n=== Tool Usage with Different Providers ===')
  
  // Define a simple tool
  const testTool = {
    name: 'get_weather',
    description: 'Get the current weather for a location',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'The city and state, e.g. San Francisco, CA'
        }
      },
      required: ['location']
    }
  }
  
  const testRequest = {
    messages: [
      {
        type: 'user',
        message: { content: [{ text: 'What\'s the weather like in San Francisco?' }] },
        uuid: 'test-uuid'
      }
    ],
    systemPrompt: ['You are a helpful assistant that can use tools.'],
    tools: [testTool],
    signal: new AbortController().signal,
    options: {
      dangerouslySkipPermissions: false,
      model: 'default',
      prependCLISysprompt: false
    }
  }
  
  const providers: ProviderType[] = ['claude', 'openai']
  
  for (const provider of providers) {
    try {
      console.log(`\n--- Tool usage with ${provider} ---`)
      
      // Switch to provider
      await switchProvider(provider)
      
      // Generate content with tool
      const response = await generateContent(testRequest)
      
      console.log(`Provider: ${provider}`)
      console.log(`Response: ${response.content.substring(0, 200)}...`)
      
    } catch (error) {
      console.error(`Error with tool usage for ${provider}:`, error)
    }
  }
}

// Example 5: Provider configuration management
async function providerConfigurationManagement() {
  console.log('\n=== Provider Configuration Management ===')
  
  const manager = await getProviderManager()
  
  // Get provider status
  const status = await manager.getProvidersStatus()
  
  for (const [providerType, providerStatus] of Object.entries(status)) {
    console.log(`\n${providerType}:`)
    console.log(`  Available: ${providerStatus.available}`)
    console.log(`  Model: ${providerStatus.config.model}`)
    console.log(`  Base URL: ${providerStatus.config.baseUrl || 'Default'}`)
    console.log(`  API Key: ${providerStatus.config.apiKey ? 'Set' : 'Not set'}`)
  }
  
  // Get provider info
  const providers = manager.getAvailableProviders()
  
  for (const providerType of providers) {
    const info = manager.getProviderInfo(providerType)
    if (info) {
      console.log(`\n${providerType} info:`)
      console.log(`  Name: ${info.name}`)
      console.log(`  Models: ${info.models.join(', ')}`)
    }
  }
}

// Example 6: Error handling and fallback
async function errorHandlingAndFallback() {
  console.log('\n=== Error Handling and Fallback ===')
  
  const testRequest = {
    messages: [
      {
        type: 'user',
        message: { content: [{ text: 'Hello!' }] },
        uuid: 'test-uuid'
      }
    ],
    systemPrompt: ['You are a helpful assistant.'],
    tools: [],
    signal: new AbortController().signal,
    options: {
      dangerouslySkipPermissions: false,
      model: 'default',
      prependCLISysprompt: false
    }
  }
  
  const providers: ProviderType[] = ['claude', 'openai', 'deepseek', 'local']
  
  for (const provider of providers) {
    try {
      console.log(`\n--- Testing ${provider} ---`)
      
      // Switch to provider
      await switchProvider(provider)
      
      // Try to generate content
      const response = await generateContent(testRequest)
      console.log(`✅ ${provider} worked: ${response.content.substring(0, 50)}...`)
      
    } catch (error) {
      console.log(`❌ ${provider} failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      
      // Try to fallback to Claude
      try {
        await switchProvider('claude')
        const fallbackResponse = await generateContent(testRequest)
        console.log(`🔄 Fallback to Claude worked: ${fallbackResponse.content.substring(0, 50)}...`)
      } catch (fallbackError) {
        console.log(`💥 Fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}`)
      }
    }
  }
}

// Main function to run all examples
async function runAllExamples() {
  console.log('🚀 Multi-Provider Examples\n')
  
  try {
    await basicProviderSwitching()
    await generateContentWithProviders()
    await streamingWithProviders()
    await toolUsageWithProviders()
    await providerConfigurationManagement()
    await errorHandlingAndFallback()
    
    console.log('\n✅ All examples completed!')
  } catch (error) {
    console.error('\n❌ Error running examples:', error)
  }
}

// Export functions for individual testing
export {
  basicProviderSwitching,
  generateContentWithProviders,
  streamingWithProviders,
  toolUsageWithProviders,
  providerConfigurationManagement,
  errorHandlingAndFallback,
  runAllExamples
}

// Run examples if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllExamples()
} 