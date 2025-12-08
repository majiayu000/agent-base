import { createAgent, defineTool, builtinTools } from './index.js';

// ============================================================================
// Example: Creating and Running an Agent
// ============================================================================

// Custom tool example: Web search simulation
const webSearchTool = defineTool<
  { query: string; maxResults?: number },
  { query: string; results: Array<{ title: string; snippet: string; url: string }> }
>({
  name: 'web_search',
  description: 'Search the web for information. Returns a list of relevant results with titles, snippets, and URLs.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 5)',
      },
    },
    required: ['query'],
  },
  execute: async ({ query, maxResults = 5 }) => {
    // Simulated search results - replace with actual API call
    console.log(`\n🔍 [web_search] Searching for: "${query}"`);

    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, 500));

    return {
      query,
      results: [
        {
          title: `Result 1 for "${query}"`,
          snippet: `This is a simulated search result about ${query}. In production, this would be real data.`,
          url: `https://example.com/result1?q=${encodeURIComponent(query)}`,
        },
        {
          title: `Result 2 for "${query}"`,
          snippet: `Another relevant result containing information about ${query}.`,
          url: `https://example.com/result2?q=${encodeURIComponent(query)}`,
        },
      ].slice(0, maxResults),
    };
  },
});

// File read simulation tool
const readFileTool = defineTool<
  { path: string },
  { path: string; content: string; size: number }
>({
  name: 'read_file',
  description: 'Read the contents of a file at the specified path.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The file path to read',
      },
    },
    required: ['path'],
  },
  execute: async ({ path }) => {
    console.log(`\n📄 [read_file] Reading: ${path}`);

    // Simulated file content - replace with actual fs.readFile
    const content = `// Simulated content of ${path}\nconsole.log("Hello from ${path}");\n`;

    return {
      path,
      content,
      size: content.length,
    };
  },
});

// ============================================================================
// Main execution
// ============================================================================

async function main() {
  console.log('🤖 Agent Base - Example\n');
  console.log('='.repeat(50));

  // Create agent with system prompt and tools
  const agent = createAgent({
    systemPrompt: `You are a helpful AI assistant with access to various tools.
You can search the web, perform calculations, check the time, and read files.
Always use the appropriate tool when needed to provide accurate information.
Think step by step and explain your reasoning.`,

    // Configuration (optional - uses defaults if not specified)
    config: {
      model: process.env.AGENT_MODEL || 'anthropic/claude-sonnet-4-5-20250514',
      thinkingBudget: 32000, // ultrathink
      maxTokens: 16000,
      maxIterations: 10,
    },

    // LLM client config (uses env vars if not specified)
    llmConfig: {
      baseURL: process.env.LITELLM_BASE_URL || 'http://localhost:4000/v1',
      apiKey: process.env.LITELLM_API_KEY || process.env.OPENAI_API_KEY || '',
    },

    // Event callbacks for observability
    events: {
      onToken: (token) => {
        process.stdout.write(token);
      },

      onThinking: (thinking) => {
        // Optionally show thinking process
        // console.log(`\n💭 [thinking] ${thinking.slice(0, 100)}...`);
      },

      onToolCall: (name, args) => {
        console.log(`\n🔧 [tool_call] ${name}(${JSON.stringify(args)})`);
      },

      onToolResult: (name, result, error) => {
        if (error) {
          console.log(`\n❌ [tool_error] ${name}: ${error.message}`);
        } else {
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          console.log(`\n✅ [tool_result] ${name}: ${resultStr.slice(0, 100)}${resultStr.length > 100 ? '...' : ''}`);
        }
      },

      onIteration: (iteration, message) => {
        console.log(`\n📍 [iteration ${iteration}] ${message.tool_calls ? `${message.tool_calls.length} tool calls` : 'response'}`);
      },

      onError: (error) => {
        console.error(`\n❌ [error] ${error.message}`);
      },
    },
  });

  // Register tools
  agent
    .registerTools(builtinTools) // Built-in tools: calculator, current_time, json_parser, string_utils
    .registerTool(webSearchTool)
    .registerTool(readFileTool);

  console.log(`\nRegistered tools: ${agent.getToolNames().join(', ')}\n`);
  console.log('='.repeat(50));

  // Example queries to test
  const queries = [
    '请计算 (15 + 25) * 3 - 10 的结果，并告诉我现在的时间。',
    // 'Search for "TypeScript AI agent frameworks" and summarize what you find.',
    // 'Read the file at /src/index.ts and tell me what it exports.',
  ];

  for (const query of queries) {
    console.log(`\n📝 User: ${query}\n`);
    console.log('-'.repeat(50));

    try {
      const result = await agent.run(query);

      console.log('\n\n' + '='.repeat(50));
      console.log('📊 Result Summary:');
      console.log(`   Iterations: ${result.iterations}`);
      console.log(`   Tool calls: ${result.toolCalls.length}`);
      console.log(`   Max iterations reached: ${result.maxIterationsReached}`);

      if (result.toolCalls.length > 0) {
        console.log('   Tools used:');
        for (const tc of result.toolCalls) {
          console.log(`     - ${tc.name}${tc.error ? ` (error: ${tc.error})` : ''}`);
        }
      }

      console.log('='.repeat(50));
    } catch (error) {
      console.error(`\n❌ Error: ${error}`);
    }

    // Small delay between queries
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Show final stats
  console.log('\n📈 Agent Stats:', agent.getStats());
}

// Run the example
main().catch(console.error);
