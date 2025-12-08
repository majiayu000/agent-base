import { LLMClient, parseStream } from './llm-client.js';
import { ContextManager } from './context-manager.js';
import { ToolExecutor } from './tool-executor.js';
import type { AgentConfig, AgentEvents, AgentResult, LLMClientConfig, Message, Tool } from './types.js';
import { defaultConfig } from './types.js';

// ============================================================================
// Agent Options
// ============================================================================

export interface AgentOptions {
  /** System prompt for the agent */
  systemPrompt: string;
  /** Agent configuration */
  config?: Partial<AgentConfig>;
  /** LLM client configuration */
  llmConfig?: Partial<LLMClientConfig>;
  /** Event callbacks for observability */
  events?: AgentEvents;
}

// ============================================================================
// Agent - Core ReAct loop implementation
// ============================================================================

export class Agent {
  private readonly config: AgentConfig;
  private readonly llmClient: LLMClient;
  private readonly context: ContextManager;
  private readonly toolExecutor: ToolExecutor;
  private readonly events: AgentEvents;
  private isRunning = false;

  constructor(options: AgentOptions) {
    // Merge config with defaults
    this.config = { ...defaultConfig, ...options.config };

    // Initialize components
    this.llmClient = new LLMClient(options.llmConfig);
    this.context = new ContextManager({
      maxTokens: this.config.maxContextTokens,
    });
    this.toolExecutor = new ToolExecutor();
    this.events = options.events || {};

    // Add system prompt
    this.context.add({
      role: 'system',
      content: options.systemPrompt,
    });
  }

  /**
   * Register a tool for the agent to use
   */
  registerTool<TInput, TOutput>(tool: Tool<TInput, TOutput>): this {
    this.toolExecutor.register(tool);
    return this;
  }

  /**
   * Register multiple tools
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTools(tools: Tool<any, any>[]): this {
    this.toolExecutor.registerMany(tools);
    return this;
  }

  /**
   * Run the agent with a user input (streaming)
   */
  async run(userInput: string): Promise<AgentResult> {
    if (this.isRunning) {
      throw new Error('Agent is already running. Wait for the current run to complete.');
    }

    this.isRunning = true;

    try {
      return await this.executeReActLoop(userInput);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Main ReAct loop implementation
   */
  private async executeReActLoop(userInput: string): Promise<AgentResult> {
    // Add user message to context
    this.context.add({
      role: 'user',
      content: userInput,
    });

    const result: AgentResult = {
      response: '',
      iterations: 0,
      toolCalls: [],
      thinking: '',
      maxIterationsReached: false,
    };

    // ReAct Loop: Think → Act → Observe → Repeat
    for (let iteration = 0; iteration < this.config.maxIterations; iteration++) {
      result.iterations = iteration + 1;

      try {
        // Create streaming request
        const stream = await this.llmClient.createStream({
          model: this.config.model,
          messages: this.context.getMessages(),
          tools: this.toolExecutor.count > 0 ? this.toolExecutor.getSchemas() : undefined,
          thinkingBudget: this.config.thinkingBudget,
          maxTokens: this.config.maxTokens,
        });

        // Parse stream with callbacks
        const parsed = await parseStream(stream, {
          onToken: this.events.onToken,
          onThinking: (thinking) => {
            result.thinking += thinking;
            this.events.onThinking?.(thinking);
          },
          onToolCallStart: (name) => {
            // Early notification that a tool is being called
          },
        });

        // Build assistant message
        const assistantMessage: Message = {
          role: 'assistant',
          content: parsed.content || null,
          tool_calls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
        };

        // Add to context
        this.context.add(assistantMessage);

        // Notify iteration complete
        this.events.onIteration?.(iteration + 1, assistantMessage);

        // Check if we're done (no tool calls)
        if (!parsed.toolCalls || parsed.toolCalls.length === 0) {
          result.response = parsed.content;
          return result;
        }

        // Execute tool calls
        for (const toolCall of parsed.toolCalls) {
          const toolName = toolCall.function.name;
          let toolArgs: unknown;

          try {
            toolArgs = JSON.parse(toolCall.function.arguments || '{}');
          } catch {
            toolArgs = {};
          }

          // Notify tool call start
          this.events.onToolCall?.(toolName, toolArgs);

          // Execute tool
          const execResult = await this.toolExecutor.execute(toolCall);

          // Notify tool result
          this.events.onToolResult?.(toolName, execResult.result, execResult.error ? new Error(execResult.error) : undefined);

          // Record tool call in result
          result.toolCalls.push({
            name: toolName,
            args: toolArgs,
            result: execResult.result,
            error: execResult.error,
          });

          // Add tool result to context
          this.context.add({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: execResult.error ? `Error: ${execResult.error}` : execResult.result,
          });
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.events.onError?.(err);

        // Add error message to context so LLM can recover
        this.context.add({
          role: 'user',
          content: `[System: An error occurred: ${err.message}. Please try a different approach.]`,
        });
      }
    }

    // Max iterations reached
    result.maxIterationsReached = true;
    result.response = 'Maximum iterations reached. The task may not be complete.';

    return result;
  }

  /**
   * Continue the conversation with a new user input
   */
  async continue(userInput: string): Promise<AgentResult> {
    return this.run(userInput);
  }

  /**
   * Reset the conversation (keeps system prompt)
   */
  reset(): void {
    this.context.clear();
  }

  /**
   * Get conversation statistics
   */
  getStats(): {
    contextStats: ReturnType<ContextManager['getStats']>;
    toolCount: number;
    isRunning: boolean;
  } {
    return {
      contextStats: this.context.getStats(),
      toolCount: this.toolExecutor.count,
      isRunning: this.isRunning,
    };
  }

  /**
   * Get all messages in the conversation
   */
  getMessages(): Message[] {
    return this.context.getMessages();
  }

  /**
   * Get registered tool names
   */
  getToolNames(): string[] {
    return this.toolExecutor.getNames();
  }
}

// ============================================================================
// Factory function for quick agent creation
// ============================================================================

export function createAgent(options: AgentOptions): Agent {
  return new Agent(options);
}
