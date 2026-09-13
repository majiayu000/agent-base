import type { Tool, ToolCall, ToolExecutionResult, ToolSchema } from './types.js';
import { isAbortError, throwIfAborted } from '../utils/abort.js';

// ============================================================================
// Tool Executor - Manages tool registration and execution
// ============================================================================

export interface ToolExecuteOptions {
  /** Whether to use the result cache (default: true) */
  useCache?: boolean;
  /** Abort in-flight tool work when the agent aborts */
  signal?: AbortSignal;
}

export class ToolExecutor {
  private tools: Map<string, Tool> = new Map();
  private cache: Map<string, { result: string; timestamp: number }> = new Map();
  private cacheTTL: number = 60000; // 1 minute default

  /**
   * Set cache TTL in milliseconds
   */
  setCacheTTL(ttl: number): void {
    this.cacheTTL = ttl;
  }

  /**
   * Generate cache key for tool call
   */
  private getCacheKey(toolName: string, args: string): string {
    return `${toolName}:${args}`;
  }

  /**
   * Get cached result if valid
   */
  private getCachedResult(toolName: string, args: string): string | null {
    const key = this.getCacheKey(toolName, args);
    const cached = this.cache.get(key);

    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.result;
    }

    // Clean up expired entry
    if (cached) {
      this.cache.delete(key);
    }

    return null;
  }

  /**
   * Cache a result
   */
  private setCachedResult(toolName: string, args: string, result: string): void {
    const key = this.getCacheKey(toolName, args);
    this.cache.set(key, { result, timestamp: Date.now() });
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Register a tool
   */
  register<TInput, TOutput>(tool: Tool<TInput, TOutput>): this {
    if (this.tools.has(tool.name)) {
      console.warn(`Tool "${tool.name}" is being overwritten`);
    }
    this.tools.set(tool.name, tool as Tool);
    return this;
  }

  /**
   * Register multiple tools at once
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerMany(tools: Tool<any, any>[]): this {
    for (const tool of tools) {
      this.register(tool);
    }
    return this;
  }

  /**
   * Unregister a tool
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Check if a tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get a tool by name
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all tool names
   */
  getNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get tool schemas in OpenAI format for LLM
   */
  getSchemas(): Array<{ name: string; description: string; parameters: ToolSchema }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /**
   * Execute a single tool call (with caching).
   * Second argument may be a boolean (legacy useCache) or options including signal.
   */
  async execute(
    toolCall: ToolCall,
    useCacheOrOptions: boolean | ToolExecuteOptions = true
  ): Promise<ToolExecutionResult> {
    const options: ToolExecuteOptions =
      typeof useCacheOrOptions === 'boolean'
        ? { useCache: useCacheOrOptions }
        : useCacheOrOptions;
    const useCache = options.useCache ?? true;
    const signal = options.signal;

    const startTime = Date.now();
    const toolName = toolCall.function.name;
    const argsStr = toolCall.function.arguments || '{}';

    try {
      throwIfAborted(signal);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        toolCallId: toolCall.id,
        toolName,
        result: '',
        error: `Tool execution aborted: ${errorMessage}`,
        durationMs: Date.now() - startTime,
      };
    }

    const tool = this.tools.get(toolName);

    if (!tool) {
      return {
        toolCallId: toolCall.id,
        toolName,
        result: '',
        error: `Unknown tool: ${toolName}. Available tools: ${this.getNames().join(', ')}`,
        durationMs: Date.now() - startTime,
      };
    }

    // Check cache first
    if (useCache) {
      const cachedResult = this.getCachedResult(toolName, argsStr);
      if (cachedResult !== null) {
        return {
          toolCallId: toolCall.id,
          toolName,
          result: cachedResult,
          durationMs: Date.now() - startTime,
        };
      }
    }

    try {
      // Parse arguments
      let args: unknown;
      try {
        args = JSON.parse(argsStr);
      } catch (parseError) {
        return {
          toolCallId: toolCall.id,
          toolName,
          result: '',
          error: `Failed to parse tool arguments: ${parseError}`,
          durationMs: Date.now() - startTime,
        };
      }

      // Execute tool (forward abort signal when supported)
      const result = await tool.execute(args, signal);

      // Convert result to string
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      // Cache the result
      if (useCache) {
        this.setCachedResult(toolName, argsStr, resultStr);
      }

      return {
        toolCallId: toolCall.id,
        toolName,
        result: resultStr,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const prefix = isAbortError(error) ? 'Tool execution aborted' : 'Tool execution failed';
      return {
        toolCallId: toolCall.id,
        toolName,
        result: '',
        error: `${prefix}: ${errorMessage}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute multiple tool calls in parallel
   */
  async executeMany(
    toolCalls: ToolCall[],
    options?: ToolExecuteOptions
  ): Promise<ToolExecutionResult[]> {
    return Promise.all(toolCalls.map((tc) => this.execute(tc, options ?? true)));
  }

  /**
   * Execute multiple tool calls sequentially
   */
  async executeManySequential(
    toolCalls: ToolCall[],
    options?: ToolExecuteOptions
  ): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];
    for (const tc of toolCalls) {
      throwIfAborted(options?.signal);
      results.push(await this.execute(tc, options ?? true));
    }
    return results;
  }

  /**
   * Clear all registered tools
   */
  clear(): void {
    this.tools.clear();
  }

  /**
   * Get tool count
   */
  get count(): number {
    return this.tools.size;
  }
}

// ============================================================================
// Tool Builder - Fluent API for creating tools
// ============================================================================

export class ToolBuilder<TInput = unknown> {
  private _name = '';
  private _description = '';
  private _parameters: ToolSchema = { type: 'object', properties: {} };

  /**
   * Set tool name
   */
  name(name: string): this {
    this._name = name;
    return this;
  }

  /**
   * Set tool description
   */
  description(description: string): this {
    this._description = description;
    return this;
  }

  /**
   * Set tool parameters schema
   */
  parameters(schema: ToolSchema): this {
    this._parameters = schema;
    return this;
  }

  /**
   * Build the tool with an execute function
   */
  execute<TOutput>(
    fn: (args: TInput, signal?: AbortSignal) => Promise<TOutput>
  ): Tool<TInput, TOutput> {
    if (!this._name) {
      throw new Error('Tool name is required');
    }
    if (!this._description) {
      throw new Error('Tool description is required');
    }

    return {
      name: this._name,
      description: this._description,
      parameters: this._parameters,
      execute: fn,
    };
  }
}

/**
 * Create a new tool builder
 */
export function createTool<TInput = unknown>(): ToolBuilder<TInput> {
  return new ToolBuilder<TInput>();
}

/**
 * Quick tool creation helper
 */
export function defineTool<TInput, TOutput>(config: {
  name: string;
  description: string;
  parameters: ToolSchema;
  execute: (args: TInput, signal?: AbortSignal) => Promise<TOutput>;
}): Tool<TInput, TOutput> {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    execute: config.execute,
  };
}
