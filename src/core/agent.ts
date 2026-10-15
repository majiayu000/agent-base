import { setTimeout as delay } from 'node:timers/promises';
import { LLMClient, parseStream } from './llm-client.js';
import { ContextManager } from './context-manager.js';
import { ToolExecutor } from './tool-executor.js';
import type { AgentConfig, AgentEvents, AgentResult, LLMClientConfig, Message, Tool, TokenUsageStats } from './types.js';
import { defaultConfig } from './types.js';
import type { AgentMiddleware, MiddlewareContext } from '../utils/middleware.js';
import { MiddlewareRunner } from '../utils/middleware.js';

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
  /** Middleware chain */
  middlewares?: AgentMiddleware[];
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
  private readonly middleware: MiddlewareRunner;
  private isRunning = false;
  private abortController: AbortController | null = null;

  constructor(options: AgentOptions) {
    // Merge config with defaults
    this.config = { ...defaultConfig, ...options.config };

    // Initialize components
    this.llmClient = new LLMClient(options.llmConfig);
    this.context = new ContextManager({
      maxTokens: this.config.maxContextTokens,
      onCompact: options.events?.onContextCompact,
    });
    this.toolExecutor = new ToolExecutor();
    this.events = options.events || {};

    // Initialize middleware
    this.middleware = new MiddlewareRunner();
    if (options.middlewares) {
      for (const mw of options.middlewares) {
        this.middleware.use(mw);
      }
    }

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
   * Add middleware to the agent
   */
  use(middleware: AgentMiddleware): this {
    this.middleware.use(middleware);
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
    this.abortController = new AbortController();

    try {
      return await this.executeReActLoop(userInput);
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  /**
   * Abort the current run
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Retry wrapper with exponential backoff
   */
  private async withRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        return await fn();
      } catch (error) {
        signal.throwIfAborted();
        if (attempt >= this.config.maxRetries) throw error;
        await delay(this.config.retryDelayMs * Math.pow(2, attempt), undefined, { signal });
      }
    }
  }

  /**
   * Main ReAct loop implementation
   */
  private async executeReActLoop(userInput: string): Promise<AgentResult> {
    const signal = this.abortController!.signal;

    // Create middleware context
    const runId = crypto.randomUUID();
    const mwCtx: MiddlewareContext = {
      runId,
      iteration: 0,
      startTime: Date.now(),
      metadata: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    };

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
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };

    // ReAct Loop: Think → Act → Observe → Repeat
    for (let iteration = 0; iteration < this.config.maxIterations; iteration++) {
      signal.throwIfAborted();

      result.iterations = iteration + 1;
      mwCtx.iteration = iteration + 1;

      try {
        // Run beforeRequest middleware
        const messages = await this.middleware.runBeforeRequest(mwCtx, this.context.getMessages());

        // Create streaming request with retry
        const stream = await this.withRetry(async () => {
          return this.llmClient.createStream({
            model: this.config.model,
            messages,
            tools: this.toolExecutor.count > 0 ? this.toolExecutor.getSchemas() : undefined,
            thinkingBudget: this.config.thinkingBudget,
            maxTokens: this.config.maxTokens,
            signal,
          });
        }, signal);

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
          onUsage: (usage) => {
            // Accumulate token usage across iterations
            result.usage!.promptTokens += usage.promptTokens;
            result.usage!.completionTokens += usage.completionTokens;
            result.usage!.totalTokens += usage.totalTokens;
          },
        }, signal);

        // Build assistant message
        const assistantMessage: Message = {
          role: 'assistant',
          content: parsed.content || null,
          tool_calls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
        };

        // Notify iteration complete
        this.events.onIteration?.(iteration + 1, assistantMessage);

        // Run afterResponse middleware
        await this.middleware.runAfterResponse(mwCtx, {
          content: parsed.content,
          toolCalls: parsed.toolCalls,
        });
        signal.throwIfAborted();

        // Do not commit tool calls if cancellation prevents the batch from starting.
        this.context.add(assistantMessage);

        // Check if we're done (no tool calls)
        if (!parsed.toolCalls || parsed.toolCalls.length === 0) {
          result.response = parsed.content;
          // Run onComplete middleware
          await this.middleware.runOnComplete(mwCtx, { response: result.response, iterations: result.iterations });
          signal.throwIfAborted();
          return result;
        }

        // Execute tool calls in parallel
        const toolPromises = parsed.toolCalls.map(async (toolCall) => {
          // Run beforeToolCall middleware
          const modifiedToolCall = await this.middleware.runBeforeToolCall(mwCtx, toolCall);
          signal.throwIfAborted();

          const toolName = modifiedToolCall.function.name;
          let toolArgs: unknown;

          try {
            toolArgs = JSON.parse(modifiedToolCall.function.arguments || '{}');
          } catch {
            toolArgs = {};
          }

          // Notify tool call start
          this.events.onToolCall?.(toolName, toolArgs);
          signal.throwIfAborted();

          // Execute tool
          let execResult = await this.toolExecutor.execute(modifiedToolCall);

          // Run afterToolCall middleware
          execResult = await this.middleware.runAfterToolCall(mwCtx, execResult);

          // Notify tool result
          this.events.onToolResult?.(toolName, execResult.result, execResult.error ? new Error(execResult.error) : undefined);

          return { toolCall: modifiedToolCall, toolName, toolArgs, execResult };
        });

        // Cancellation cannot stop an executing tool. Wait for the entire batch
        // and retain its outcomes before allowing another run to use this history.
        const toolResults = await Promise.allSettled(toolPromises);

        // Process results in order (maintain context order)
        for (const [index, outcome] of toolResults.entries()) {
          if (outcome.status === 'rejected') {
            const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
            this.context.add({
              role: 'tool',
              tool_call_id: parsed.toolCalls[index].id,
              content: `Error: ${error}`,
            });
            continue;
          }
          const { toolCall, toolName, toolArgs, execResult } = outcome.value;
          // Truncate result if too long
          let resultContent = execResult.error ? `Error: ${execResult.error}` : execResult.result;
          if (resultContent.length > this.config.maxToolResultLength) {
            resultContent = resultContent.slice(0, this.config.maxToolResultLength) + '\n...[truncated]';
          }

          // Record tool call in result
          result.toolCalls.push({
            name: toolName,
            args: toolArgs,
            result: resultContent,
            error: execResult.error,
          });

          // Add tool result to context
          this.context.add({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultContent,
          });
        }
        signal.throwIfAborted();
        const failure = toolResults.find((outcome) => outcome.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      } catch (error) {
        signal.throwIfAborted();
        const err = error instanceof Error ? error : new Error(String(error));
        this.events.onError?.(err);

        // Run onError middleware
        await this.middleware.runOnError(mwCtx, err);

        // Request retries are exhausted, or streaming/middleware failed.
        // A new ReAct iteration must not replay this failed request.
        throw err;
      }
    }

    // Max iterations reached
    result.maxIterationsReached = true;
    await this.middleware.runOnComplete(mwCtx, { response: result.response, iterations: result.iterations });
    signal.throwIfAborted();
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
