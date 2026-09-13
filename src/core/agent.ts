import { LLMClient, parseStream } from './llm-client.js';
import { ContextManager } from './context-manager.js';
import { ToolExecutor } from './tool-executor.js';
import type { AgentConfig, AgentEvents, AgentResult, LLMClientConfig, Message, Tool, TokenUsageStats } from './types.js';
import { defaultConfig } from './types.js';
import type { AgentMiddleware, MiddlewareContext } from '../utils/middleware.js';
import { MiddlewareRunner } from '../utils/middleware.js';
import { abortableDelay, isAbortError } from '../utils/abort.js';

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
   * Retry wrapper with exponential backoff.
   * Fail-fast on abort and use an abortable delay so we never sleep after cancel.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;
    const signal = this.abortController?.signal;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error('Agent run was aborted.');
      }

      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on abort
        if (signal?.aborted || isAbortError(lastError)) {
          throw lastError;
        }

        // Exponential backoff (cancelled immediately if aborted mid-wait)
        if (attempt < this.config.maxRetries - 1) {
          const delay = this.config.retryDelayMs * Math.pow(2, attempt);
          await abortableDelay(delay, signal);
        }
      }
    }

    throw lastError;
  }

  /**
   * Pair assistant tool_calls with synthetic cancellation results so a later
   * continue() does not send orphan tool_calls to the LLM API.
   */
  private addCancelledToolResults(
    toolCalls: NonNullable<Message['tool_calls']>,
    result: AgentResult,
  ): void {
    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      let toolArgs: unknown;
      try {
        toolArgs = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        toolArgs = {};
      }

      const abortError = 'Tool execution aborted: This operation was aborted';
      const resultContent = `Error: ${abortError}`;

      result.toolCalls.push({
        name: toolName,
        args: toolArgs,
        result: resultContent,
        error: abortError,
      });

      this.context.add({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: resultContent,
      });
    }
  }

  /**
   * Main ReAct loop implementation
   */
  private async executeReActLoop(userInput: string): Promise<AgentResult> {
    // Create middleware context
    const runId = crypto.randomUUID();
    const mwCtx: MiddlewareContext = {
      runId,
      iteration: 0,
      startTime: Date.now(),
      metadata: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    };
    const signal = this.abortController!.signal;

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
      // Check abort signal
      if (signal.aborted) {
        result.response = 'Agent run was aborted.';
        return result;
      }

      result.iterations = iteration + 1;
      mwCtx.iteration = iteration + 1;

      try {
        // Run beforeRequest middleware
        const messages = await this.middleware.runBeforeRequest(mwCtx, this.context.getMessages());

        // Create streaming request with retry (signal cancels in-flight LLM HTTP)
        const stream = await this.withRetry(async () => {
          return this.llmClient.createStream({
            model: this.config.model,
            messages,
            tools: this.toolExecutor.count > 0 ? this.toolExecutor.getSchemas() : undefined,
            thinkingBudget: this.config.thinkingBudget,
            maxTokens: this.config.maxTokens,
            signal,
          });
        });

        // Parse stream with callbacks (abort stops iteration and cancels stream)
        const parsed = await parseStream(stream, {
          onToken: this.events.onToken,
          onThinking: (thinking) => {
            result.thinking += thinking;
            this.events.onThinking?.(thinking);
          },
          onToolCallStart: (_name) => {
            // Early notification that a tool is being called
          },
          onUsage: (usage) => {
            // Accumulate token usage across iterations
            result.usage!.promptTokens += usage.promptTokens;
            result.usage!.completionTokens += usage.completionTokens;
            result.usage!.totalTokens += usage.totalTokens;
          },
          signal,
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

        // Run afterResponse middleware
        await this.middleware.runAfterResponse(mwCtx, {
          content: parsed.content,
          toolCalls: parsed.toolCalls,
        });

        // Check if we're done (no tool calls)
        if (!parsed.toolCalls || parsed.toolCalls.length === 0) {
          // Abort may fire during onIteration / afterResponse with no tools —
          // recheck before treating this as a successful completion.
          if (signal.aborted) {
            result.response = 'Agent run was aborted.';
            return result;
          }
          result.response = parsed.content;
          // Run onComplete middleware
          await this.middleware.runOnComplete(mwCtx, { response: result.response, iterations: result.iterations });
          // Abort may fire while awaiting onComplete (or from onComplete itself).
          if (signal.aborted) {
            result.response = 'Agent run was aborted.';
            return result;
          }
          return result;
        }

        // Abort during onIteration / afterResponse must skip beforeToolCall /
        // onToolCall side effects, while still pairing synthetic cancel results
        // so continue() does not send orphan assistant tool_calls.
        if (signal.aborted) {
          this.addCancelledToolResults(parsed.toolCalls, result);
          result.response = 'Agent run was aborted.';
          return result;
        }

        // Execute tool calls in parallel (signal cancels shell/HTTP in-flight work)
        const toolPromises = parsed.toolCalls.map(async (toolCall) => {
          // Run beforeToolCall middleware
          const modifiedToolCall = await this.middleware.runBeforeToolCall(mwCtx, toolCall);

          const toolName = modifiedToolCall.function.name;
          let toolArgs: unknown;

          try {
            toolArgs = JSON.parse(modifiedToolCall.function.arguments || '{}');
          } catch {
            toolArgs = {};
          }

          // Abort during/after beforeToolCall: skip onToolCall / execute /
          // afterToolCall / onToolResult while still pairing a synthetic cancel.
          if (signal.aborted) {
            const abortError = 'Tool execution aborted: This operation was aborted';
            return {
              toolCall: modifiedToolCall,
              toolName,
              toolArgs,
              execResult: {
                toolCallId: modifiedToolCall.id,
                toolName,
                result: '',
                error: abortError,
                durationMs: 0,
              },
            };
          }

          // Notify tool call start
          this.events.onToolCall?.(toolName, toolArgs);

          // Execute tool
          const execResult = await this.toolExecutor.execute(modifiedToolCall, { signal });

          // Abort during/after execute: ToolExecutor returns a normal result for
          // AbortError, so recheck before afterToolCall / onToolResult side effects
          // while still pairing the (synthetic or completed) tool result.
          if (signal.aborted) {
            return {
              toolCall: modifiedToolCall,
              toolName,
              toolArgs,
              execResult,
            };
          }

          // Run afterToolCall middleware
          const afterResult = await this.middleware.runAfterToolCall(mwCtx, execResult);

          // Abort during/after afterToolCall: skip onToolResult side effects while
          // still pairing the (possibly middleware-modified) tool result.
          if (signal.aborted) {
            return {
              toolCall: modifiedToolCall,
              toolName,
              toolArgs,
              execResult: afterResult,
            };
          }

          // Notify tool result
          this.events.onToolResult?.(
            toolName,
            afterResult.result,
            afterResult.error ? new Error(afterResult.error) : undefined
          );

          return { toolCall: modifiedToolCall, toolName, toolArgs, execResult: afterResult };
        });

        const toolResults = await Promise.all(toolPromises);

        // Always pair tool_calls with tool results before returning on abort so
        // a later continue() does not send orphan assistant tool_calls.
        for (const { toolCall, toolName, toolArgs, execResult } of toolResults) {
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

        // ToolExecutor turns abort rejections into error results, so recheck
        // after tools settle — otherwise maxIterations can misreport abort.
        if (signal.aborted) {
          result.response = 'Agent run was aborted.';
          return result;
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));

        // Abort is terminal — do not treat as recoverable LLM error
        if (signal.aborted || isAbortError(err)) {
          result.response = 'Agent run was aborted.';
          return result;
        }

        this.events.onError?.(err);

        // Run onError middleware
        await this.middleware.runOnError(mwCtx, err);

        // onError / middleware may call Agent.abort(); recheck before falling
        // through to the next iteration or the max-iterations path.
        if (signal.aborted) {
          result.response = 'Agent run was aborted.';
          return result;
        }

        // Add error message to context so LLM can recover
        this.context.add({
          role: 'user',
          content: `[System: An error occurred: ${err.message}. Please try a different approach.]`,
        });
      }
    }

    // Max iterations reached
    result.maxIterationsReached = true;
    await this.middleware.runOnComplete(mwCtx, { response: result.response, iterations: result.iterations });
    // Abort may fire while awaiting onComplete (or from onComplete itself).
    if (signal.aborted) {
      result.response = 'Agent run was aborted.';
      return result;
    }
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
