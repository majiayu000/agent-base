import { createAgent, builtinTools, filesystemTools } from './index.js';
import { TokenTracker, MODEL_PRICING } from './utils/token-tracker.js';
import type { TokenUsage } from './core/llm-client.js';

// ============================================================================
// Project Analysis Agent - Analyze and suggest optimizations
// ============================================================================

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function color(text: string, c: keyof typeof COLORS): string {
  return `${COLORS[c]}${text}${COLORS.reset}`;
}

async function main() {
  console.log(color('\n╔══════════════════════════════════════════════════════════════╗', 'cyan'));
  console.log(color('║       Agent Base - Project Analysis with Token Tracking      ║', 'cyan'));
  console.log(color('╚══════════════════════════════════════════════════════════════╝\n', 'cyan'));

  // Get model from env
  const model = process.env.AGENT_MODEL || 'deepseek/deepseek-v3.2-20251201';
  const thinkingBudget = Number(process.env.AGENT_THINKING_BUDGET) || 0;

  console.log(color('Configuration:', 'bold'));
  console.log(`  Model: ${model}`);
  console.log(`  Thinking Budget: ${thinkingBudget > 0 ? thinkingBudget + ' tokens' : 'disabled'}`);
  console.log(`  Pricing: $${MODEL_PRICING[model]?.inputPricePerMillion || '?'}/M input, $${MODEL_PRICING[model]?.outputPricePerMillion || '?'}/M output`);
  console.log();

  // Initialize token tracker
  const tracker = new TokenTracker();
  let currentRequestStart = Date.now();

  // Create analysis agent
  const agent = createAgent({
    systemPrompt: `You are an expert software architect analyzing a TypeScript AI Agent framework.

Your task is to:
1. Read and understand the codebase structure
2. Analyze the architecture and design patterns
3. Identify potential optimizations and improvements
4. Provide actionable recommendations

Focus on:
- Code quality and best practices
- Performance optimizations
- Error handling improvements
- API design improvements
- Missing features that would be valuable
- Security considerations

Be thorough and specific in your analysis. Use the tools available to read files and understand the code.`,

    config: {
      model,
      thinkingBudget,
      maxTokens: 8000,
      maxIterations: 15,
    },

    llmConfig: {
      baseURL: process.env.LITELLM_BASE_URL || 'https://openrouter.ai/api/v1',
      apiKey: process.env.LITELLM_API_KEY || '',
    },

    events: {
      onToken: (token) => {
        process.stdout.write(token);
      },

      onThinking: (thinking) => {
        // Show thinking indicator
        process.stdout.write(color('.', 'dim'));
      },

      onToolCall: (name, args) => {
        const argsStr = JSON.stringify(args);
        console.log(color(`\n🔧 [${name}]`, 'yellow'), color(argsStr.slice(0, 80) + (argsStr.length > 80 ? '...' : ''), 'dim'));
      },

      onToolResult: (name, _result, error) => {
        if (error) {
          console.log(color(`❌ [${name}] Error: ${error.message}`, 'red'));
        } else {
          console.log(color(`✅ [${name}] Done`, 'green'));
        }
      },

      onIteration: (iteration, message) => {
        // Track token usage from the parsed stream result
        // Note: This is called per iteration, actual usage tracking happens in the stream
      },

      onError: (error) => {
        console.error(color(`\n❌ Error: ${error.message}`, 'red'));
      },
    },
  });

  // Register tools
  agent.registerTools(builtinTools);
  agent.registerTools(filesystemTools);

  console.log(color('Registered tools:', 'dim'), agent.getToolNames().join(', '));
  console.log('\n' + '='.repeat(70) + '\n');

  // Analysis prompt
  const analysisPrompt = `Please analyze this TypeScript AI Agent framework project.

The project is located at: ${process.cwd()}

Steps to follow:
1. First, list the directory structure using list_directory tool on "src" folder
2. Read the main entry point (src/index.ts) to understand exports
3. Read core files: src/core/agent.ts, src/core/llm-client.ts, src/core/types.ts
4. Read utility files: src/utils/middleware.ts, src/utils/validation.ts
5. Based on your analysis, provide a comprehensive report with:

   ## Architecture Overview
   Brief description of the project structure and design patterns

   ## Strengths
   What's well-designed in the current implementation

   ## Areas for Optimization
   Specific improvements that could be made, categorized by:
   - Performance optimizations
   - Code quality improvements
   - Missing features
   - Error handling improvements
   - API design suggestions

   ## Priority Recommendations
   Top 5 most impactful changes to implement

Be specific and provide code examples where helpful.`;

  console.log(color('📝 Starting Analysis...\n', 'bold'));
  currentRequestStart = Date.now();

  try {
    const result = await agent.run(analysisPrompt);

    // Calculate duration
    const durationMs = Date.now() - currentRequestStart;

    console.log('\n\n' + '='.repeat(70));
    console.log(color('\n📊 Analysis Complete!\n', 'bold'));

    // Display result summary
    console.log(color('Result Summary:', 'bold'));
    console.log(`  Iterations: ${result.iterations}`);
    console.log(`  Tool calls: ${result.toolCalls.length}`);
    console.log(`  Duration: ${(durationMs / 1000).toFixed(2)}s`);

    if (result.toolCalls.length > 0) {
      console.log(color('  Tools used:', 'dim'));
      const toolCounts: Record<string, number> = {};
      result.toolCalls.forEach((tc) => {
        toolCounts[tc.name] = (toolCounts[tc.name] || 0) + 1;
      });
      Object.entries(toolCounts).forEach(([name, count]) => {
        console.log(`    - ${name}: ${count}x`);
      });
    }

    // Estimate tokens if not available from API
    // Rough estimation: 4 chars per token
    const estimatedInputTokens = Math.ceil(analysisPrompt.length / 4);
    const estimatedOutputTokens = Math.ceil(result.response.length / 4);

    // Record usage
    tracker.record({
      model,
      promptTokens: estimatedInputTokens,
      completionTokens: estimatedOutputTokens,
      durationMs,
      metadata: {
        iterations: result.iterations,
        toolCalls: result.toolCalls.length,
      },
    });

    // Print token & cost summary
    console.log('\n' + tracker.formatSummary());

    // Save report
    const reportPath = `${process.cwd()}/analysis-report.md`;
    const reportContent = `# Agent Base - Project Analysis Report

Generated: ${new Date().toISOString()}
Model: ${model}
Thinking Budget: ${thinkingBudget} tokens

## Analysis Results

${result.response}

---

## Statistics

- Iterations: ${result.iterations}
- Tool calls: ${result.toolCalls.length}
- Duration: ${(durationMs / 1000).toFixed(2)}s
- Estimated tokens: ~${estimatedInputTokens + estimatedOutputTokens}
- Estimated cost: ~$${tracker.getSummary().totalCost.toFixed(6)}
`;

    await Bun.write(reportPath, reportContent);
    console.log(color(`\n📄 Report saved to: ${reportPath}`, 'green'));

  } catch (error) {
    console.error(color(`\n❌ Analysis failed: ${error}`, 'red'));
    process.exit(1);
  }
}

main();
