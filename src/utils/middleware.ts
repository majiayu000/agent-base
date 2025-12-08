import type { Message, Tool, ToolCall, ToolExecutionResult } from '../core/types.js';
import { Logger, createLogger } from './logger.js';

// ============================================================================
// Middleware System - Interceptors for Agent lifecycle
// ============================================================================

/**
 * Context passed to middleware functions
 */
export interface MiddlewareContext {
  /** Unique run ID */
  runId: string;
  /** Current iteration number */
  iteration: number;
  /** Start timestamp */
  startTime: number;
  /** Custom metadata */
  metadata: Record<string, unknown>;
  /** Logger instance */
  logger: Logger;
}

/**
 * Middleware function types
 */
export interface AgentMiddleware {
  name: string;

  /** Called before sending request to LLM */
  beforeRequest?: (ctx: MiddlewareContext, messages: Message[]) => Promise<Message[] | void>;

  /** Called after receiving response from LLM */
  afterResponse?: (ctx: MiddlewareContext, response: { content: string; toolCalls: ToolCall[] }) => Promise<void>;

  /** Called before executing a tool */
  beforeToolCall?: (ctx: MiddlewareContext, toolCall: ToolCall) => Promise<ToolCall | void>;

  /** Called after tool execution */
  afterToolCall?: (ctx: MiddlewareContext, result: ToolExecutionResult) => Promise<ToolExecutionResult | void>;

  /** Called on error */
  onError?: (ctx: MiddlewareContext, error: Error) => Promise<void>;

  /** Called when run completes */
  onComplete?: (ctx: MiddlewareContext, result: { response: string; iterations: number }) => Promise<void>;
}

// ============================================================================
// Built-in Middlewares
// ============================================================================

/**
 * Logging middleware - logs all agent activities
 */
export function loggingMiddleware(options?: { level?: 'debug' | 'info'; logger?: Logger }): AgentMiddleware {
  const log = options?.logger ?? createLogger('agent');
  const level = options?.level ?? 'info';

  return {
    name: 'logging',

    beforeRequest: async (ctx, messages) => {
      if (level === 'debug') {
        log.debug(`[${ctx.runId}] Iteration ${ctx.iteration}: Sending ${messages.length} messages to LLM`);
      }
    },

    afterResponse: async (ctx, response) => {
      const hasTools = response.toolCalls.length > 0;
      log.info(`[${ctx.runId}] LLM response: ${hasTools ? `${response.toolCalls.length} tool calls` : 'text response'}`, {
        contentLength: response.content.length,
        toolCalls: response.toolCalls.map((tc) => tc.function.name),
      });
    },

    beforeToolCall: async (ctx, toolCall) => {
      log.info(`[${ctx.runId}] Executing tool: ${toolCall.function.name}`, {
        toolCallId: toolCall.id,
      });
    },

    afterToolCall: async (ctx, result) => {
      if (result.error) {
        log.warn(`[${ctx.runId}] Tool ${result.toolName} failed`, {
          error: result.error,
          durationMs: result.durationMs,
        });
      } else {
        log.info(`[${ctx.runId}] Tool ${result.toolName} completed`, {
          durationMs: result.durationMs,
          resultLength: result.result.length,
        });
      }
    },

    onError: async (ctx, error) => {
      log.error(`[${ctx.runId}] Error: ${error.message}`, {
        stack: error.stack,
      });
    },

    onComplete: async (ctx, result) => {
      const durationMs = Date.now() - ctx.startTime;
      log.info(`[${ctx.runId}] Run completed`, {
        iterations: result.iterations,
        durationMs,
        responseLength: result.response.length,
      });
    },
  };
}

/**
 * Timing middleware - tracks execution timing
 */
export function timingMiddleware(): AgentMiddleware {
  const timings: Map<string, { start: number; llmTime: number; toolTime: number }> = new Map();

  return {
    name: 'timing',

    beforeRequest: async (ctx) => {
      if (!timings.has(ctx.runId)) {
        timings.set(ctx.runId, { start: Date.now(), llmTime: 0, toolTime: 0 });
      }
      ctx.metadata.llmStartTime = Date.now();
    },

    afterResponse: async (ctx) => {
      const timing = timings.get(ctx.runId);
      if (timing && ctx.metadata.llmStartTime) {
        timing.llmTime += Date.now() - (ctx.metadata.llmStartTime as number);
      }
    },

    beforeToolCall: async (ctx) => {
      ctx.metadata.toolStartTime = Date.now();
    },

    afterToolCall: async (ctx, result) => {
      const timing = timings.get(ctx.runId);
      if (timing) {
        timing.toolTime += result.durationMs;
      }
    },

    onComplete: async (ctx, result) => {
      const timing = timings.get(ctx.runId);
      if (timing) {
        const totalTime = Date.now() - timing.start;
        ctx.metadata.timing = {
          totalMs: totalTime,
          llmMs: timing.llmTime,
          toolMs: timing.toolTime,
          overheadMs: totalTime - timing.llmTime - timing.toolTime,
        };
        timings.delete(ctx.runId);
      }
    },
  };
}

/**
 * Rate limiting middleware
 */
export function rateLimitMiddleware(options: {
  maxRequestsPerMinute?: number;
  maxTokensPerMinute?: number;
}): AgentMiddleware {
  const { maxRequestsPerMinute = 60 } = options;
  const requests: number[] = [];

  return {
    name: 'rate-limit',

    beforeRequest: async (ctx) => {
      const now = Date.now();
      const oneMinuteAgo = now - 60000;

      // Clean old requests
      while (requests.length > 0 && requests[0] < oneMinuteAgo) {
        requests.shift();
      }

      // Check rate limit
      if (requests.length >= maxRequestsPerMinute) {
        const waitTime = requests[0] - oneMinuteAgo;
        ctx.logger.warn(`Rate limit reached, waiting ${waitTime}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      requests.push(now);
    },
  };
}

/**
 * Retry middleware - automatic retry on failures
 */
export function retryMiddleware(options?: { maxRetries?: number; backoffMs?: number }): AgentMiddleware {
  const maxRetries = options?.maxRetries ?? 3;
  const backoffMs = options?.backoffMs ?? 1000;
  const retryCount: Map<string, number> = new Map();

  return {
    name: 'retry',

    onError: async (ctx, error) => {
      const count = (retryCount.get(ctx.runId) ?? 0) + 1;
      retryCount.set(ctx.runId, count);

      if (count < maxRetries) {
        const waitTime = backoffMs * Math.pow(2, count - 1);
        ctx.logger.info(`Retry ${count}/${maxRetries} in ${waitTime}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        ctx.metadata.shouldRetry = true;
      } else {
        ctx.metadata.shouldRetry = false;
        retryCount.delete(ctx.runId);
      }
    },

    onComplete: async (ctx) => {
      retryCount.delete(ctx.runId);
    },
  };
}

/**
 * Cost tracking middleware (estimates)
 */
export function costTrackingMiddleware(options?: {
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
}): AgentMiddleware {
  // Default Claude Sonnet pricing (approximate)
  const inputPrice = options?.inputPricePerMillion ?? 3.0;
  const outputPrice = options?.outputPricePerMillion ?? 15.0;

  return {
    name: 'cost-tracking',

    beforeRequest: async (ctx, messages) => {
      // Estimate input tokens (rough: 4 chars per token)
      const inputChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
      const inputTokens = Math.ceil(inputChars / 4);
      ctx.metadata.estimatedInputTokens = (ctx.metadata.estimatedInputTokens as number ?? 0) + inputTokens;
    },

    afterResponse: async (ctx, response) => {
      // Estimate output tokens
      const outputChars = response.content.length;
      const outputTokens = Math.ceil(outputChars / 4);
      ctx.metadata.estimatedOutputTokens = (ctx.metadata.estimatedOutputTokens as number ?? 0) + outputTokens;
    },

    onComplete: async (ctx) => {
      const inputTokens = ctx.metadata.estimatedInputTokens as number ?? 0;
      const outputTokens = ctx.metadata.estimatedOutputTokens as number ?? 0;

      const inputCost = (inputTokens / 1_000_000) * inputPrice;
      const outputCost = (outputTokens / 1_000_000) * outputPrice;

      ctx.metadata.estimatedCost = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        inputCostUSD: inputCost.toFixed(6),
        outputCostUSD: outputCost.toFixed(6),
        totalCostUSD: (inputCost + outputCost).toFixed(6),
      };
    },
  };
}

// ============================================================================
// Middleware Runner
// ============================================================================

/**
 * Run middleware chain
 */
export class MiddlewareRunner {
  private middlewares: AgentMiddleware[] = [];

  use(middleware: AgentMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  async runBeforeRequest(ctx: MiddlewareContext, messages: Message[]): Promise<Message[]> {
    let result = messages;
    for (const mw of this.middlewares) {
      if (mw.beforeRequest) {
        const modified = await mw.beforeRequest(ctx, result);
        if (modified) result = modified;
      }
    }
    return result;
  }

  async runAfterResponse(ctx: MiddlewareContext, response: { content: string; toolCalls: ToolCall[] }): Promise<void> {
    for (const mw of this.middlewares) {
      if (mw.afterResponse) {
        await mw.afterResponse(ctx, response);
      }
    }
  }

  async runBeforeToolCall(ctx: MiddlewareContext, toolCall: ToolCall): Promise<ToolCall> {
    let result = toolCall;
    for (const mw of this.middlewares) {
      if (mw.beforeToolCall) {
        const modified = await mw.beforeToolCall(ctx, result);
        if (modified) result = modified;
      }
    }
    return result;
  }

  async runAfterToolCall(ctx: MiddlewareContext, result: ToolExecutionResult): Promise<ToolExecutionResult> {
    let current = result;
    for (const mw of this.middlewares) {
      if (mw.afterToolCall) {
        const modified = await mw.afterToolCall(ctx, current);
        if (modified) current = modified;
      }
    }
    return current;
  }

  async runOnError(ctx: MiddlewareContext, error: Error): Promise<void> {
    for (const mw of this.middlewares) {
      if (mw.onError) {
        await mw.onError(ctx, error);
      }
    }
  }

  async runOnComplete(ctx: MiddlewareContext, result: { response: string; iterations: number }): Promise<void> {
    for (const mw of this.middlewares) {
      if (mw.onComplete) {
        await mw.onComplete(ctx, result);
      }
    }
  }
}
