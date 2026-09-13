import * as readline from 'readline';
import { createAgent } from './core/agent.js';
import { builtinTools } from './tools/builtin.js';
import { httpTools } from './tools/http.js';
import { filesystemTools } from './tools/filesystem.js';
import { createShellTools } from './tools/shell.js';
import type { AgentResult } from './core/types.js';

/**
 * Local CLI opt-in policy — deny shell_run; small argv allowlist under cwd.
 * Omit general-purpose interpreters (node/npm/bun) and VCS tools (git) so
 * shell_exec cannot run arbitrary code via aliases or script runners.
 */
const cliShellTools = createShellTools({
  allowShellRun: false,
  allowedCommands: [
    'ls',
    'pwd',
    'echo',
    'cat',
    'head',
    'wc',
    'which',
  ],
  allowedCwdRoots: [process.cwd()],
  scrubEnv: true,
});

// ============================================================================
// CLI Interactive Mode
// ============================================================================

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function color(text: string, c: keyof typeof COLORS): string {
  return `${COLORS[c]}${text}${COLORS.reset}`;
}

function printBanner(): void {
  console.log(color('\n╔════════════════════════════════════════╗', 'cyan'));
  console.log(color('║        Agent Base - Interactive        ║', 'cyan'));
  console.log(color('╚════════════════════════════════════════╝', 'cyan'));
  console.log();
  console.log(color('Commands:', 'bold'));
  console.log('  /help     - Show this help message');
  console.log('  /tools    - List available tools');
  console.log('  /stats    - Show agent statistics');
  console.log('  /reset    - Reset conversation');
  console.log('  /exit     - Exit the CLI');
  console.log();
  console.log(color('Model:', 'dim'), process.env.AGENT_MODEL || 'anthropic/claude-sonnet-4-5-20250514');
  console.log(color('Thinking Budget:', 'dim'), process.env.AGENT_THINKING_BUDGET || '32000', 'tokens');
  console.log();
}

function printToolList(tools: string[]): void {
  console.log(color('\nAvailable Tools:', 'bold'));
  const categories: Record<string, string[]> = {
    'Built-in': ['calculator', 'current_time', 'json_parser', 'string_utils'],
    'HTTP': ['http_get', 'http_post', 'fetch_json'],
    'Filesystem': ['read_file', 'write_file', 'list_directory', 'file_info', 'delete_path'],
    'Shell': ['shell_exec', 'shell_run', 'command_exists'],
  };

  for (const [category, categoryTools] of Object.entries(categories)) {
    const available = categoryTools.filter((t) => tools.includes(t));
    if (available.length > 0) {
      console.log(color(`  ${category}:`, 'yellow'));
      available.forEach((t) => console.log(`    - ${t}`));
    }
  }
  console.log();
}

function printStats(stats: ReturnType<typeof agent.getStats>): void {
  console.log(color('\nAgent Statistics:', 'bold'));
  console.log(`  Messages: ${stats.contextStats.messageCount}`);
  console.log(`  Tokens: ${stats.contextStats.tokenCount} / ${stats.contextStats.maxTokens}`);
  console.log(`  Utilization: ${stats.contextStats.utilizationPercent.toFixed(1)}%`);
  console.log(`  Tools: ${stats.toolCount}`);
  console.log(`  Running: ${stats.isRunning}`);
  console.log();
}

function printResult(result: AgentResult): void {
  console.log();
  console.log(color('─'.repeat(50), 'dim'));
  console.log(color('Result:', 'bold'));
  console.log(`  Iterations: ${result.iterations}`);
  console.log(`  Tool Calls: ${result.toolCalls.length}`);

  if (result.toolCalls.length > 0) {
    console.log(color('  Tools Used:', 'dim'));
    result.toolCalls.forEach((tc) => {
      const status = tc.error ? color('✗', 'red') : color('✓', 'green');
      console.log(`    ${status} ${tc.name}`);
    });
  }

  if (result.maxIterationsReached) {
    console.log(color('  ⚠ Max iterations reached', 'yellow'));
  }
  console.log();
}

// Create agent
const agent = createAgent({
  systemPrompt: `You are a helpful AI assistant with access to various tools.
You can:
- Perform calculations and get current time
- Make HTTP requests to fetch data
- Read and write files
- Execute shell commands
- Parse and manipulate JSON and strings

Always use the appropriate tool when needed. Think step by step.
Be concise but thorough in your responses.`,

  config: {
    model: process.env.AGENT_MODEL || 'anthropic/claude-sonnet-4-5-20250514',
    thinkingBudget: Number(process.env.AGENT_THINKING_BUDGET) || 32000,
    maxTokens: Number(process.env.AGENT_MAX_TOKENS) || 16000,
    maxIterations: Number(process.env.AGENT_MAX_ITERATIONS) || 15,
  },

  llmConfig: {
    baseURL: process.env.LITELLM_BASE_URL || 'http://localhost:4000/v1',
    apiKey: process.env.LITELLM_API_KEY || process.env.OPENAI_API_KEY || '',
  },

  events: {
    onToken: (token) => {
      process.stdout.write(token);
    },

    onThinking: (_thinking) => {
      // Optionally show thinking indicator
      // process.stdout.write(color('.', 'dim'));
    },

    onToolCall: (name, args) => {
      console.log(color(`\n🔧 [${name}]`, 'yellow'), color(JSON.stringify(args).slice(0, 100), 'dim'));
    },

    onToolResult: (name, _result, error) => {
      if (error) {
        console.log(color(`❌ [${name}] Error: ${error.message}`, 'red'));
      } else {
        console.log(color(`✓ [${name}] Done`, 'green'));
      }
    },

    onError: (error) => {
      console.error(color(`\n❌ Error: ${error.message}`, 'red'));
    },
  },
});

// Register all tools
agent
  .registerTools(builtinTools)
  .registerTools(httpTools)
  .registerTools(filesystemTools)
  .registerTools(cliShellTools);

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function handleCommand(input: string): Promise<boolean> {
  const cmd = input.trim().toLowerCase();

  switch (cmd) {
    case '/help':
      printBanner();
      return true;

    case '/tools':
      printToolList(agent.getToolNames());
      return true;

    case '/stats':
      printStats(agent.getStats());
      return true;

    case '/reset':
      agent.reset();
      console.log(color('\n✓ Conversation reset\n', 'green'));
      return true;

    case '/exit':
    case '/quit':
    case '/q':
      console.log(color('\nGoodbye! 👋\n', 'cyan'));
      rl.close();
      process.exit(0);

    default:
      return false;
  }
}

async function prompt(): Promise<void> {
  rl.question(color('\n> ', 'bold'), async (input) => {
    const trimmed = input.trim();

    if (!trimmed) {
      prompt();
      return;
    }

    // Check for commands
    if (trimmed.startsWith('/')) {
      const handled = await handleCommand(trimmed);
      if (handled) {
        prompt();
        return;
      }
      console.log(color(`Unknown command: ${trimmed}. Type /help for commands.`, 'yellow'));
      prompt();
      return;
    }

    // Run agent
    try {
      console.log();
      const result = await agent.run(trimmed);
      printResult(result);
    } catch (error) {
      console.error(color(`\n❌ ${error}`, 'red'));
    }

    prompt();
  });
}

// Handle Ctrl+C gracefully
rl.on('close', () => {
  console.log(color('\n\nGoodbye! 👋\n', 'cyan'));
  process.exit(0);
});

// Main
printBanner();
prompt();
