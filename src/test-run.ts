import { createAgent, builtinTools } from './index.js';

async function main() {
  console.log('🚀 Testing Agent with OpenRouter API...\n');

  const agent = createAgent({
    systemPrompt: 'You are a helpful assistant. Be concise.',
    config: {
      model: process.env.AGENT_MODEL || 'anthropic/claude-sonnet-4-5-20250514',
      thinkingBudget: 0, // 禁用 thinking 进行简单测试
      maxTokens: 1000,
      maxIterations: 5,
    },
    llmConfig: {
      baseURL: process.env.LITELLM_BASE_URL || 'https://openrouter.ai/api/v1',
      apiKey: process.env.LITELLM_API_KEY || '',
    },
    events: {
      onToken: (token) => process.stdout.write(token),
      onToolCall: (name, args) => {
        console.log(`\n🔧 Calling tool: ${name}`);
      },
      onToolResult: (name, result, error) => {
        if (error) {
          console.log(`❌ ${name} error: ${error.message}`);
        } else {
          console.log(`✅ ${name} completed`);
        }
      },
      onError: (err) => {
        console.error(`\n❌ Error: ${err.message}`);
      },
    },
  });

  // 注册工具
  agent.registerTools(builtinTools);

  console.log('Registered tools:', agent.getToolNames().join(', '));
  console.log('\n' + '='.repeat(50));
  console.log('Query: 计算 15 * 8 + 32，然后告诉我现在的时间');
  console.log('='.repeat(50) + '\n');

  try {
    const result = await agent.run('计算 15 * 8 + 32，然后告诉我现在的时间');

    console.log('\n\n' + '='.repeat(50));
    console.log('📊 Result Summary:');
    console.log(`   Iterations: ${result.iterations}`);
    console.log(`   Tool calls: ${result.toolCalls.length}`);
    if (result.toolCalls.length > 0) {
      console.log('   Tools used:');
      result.toolCalls.forEach((tc) => {
        console.log(`     - ${tc.name}${tc.error ? ' (error)' : ''}`);
      });
    }
    console.log('='.repeat(50));
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
}

main();
