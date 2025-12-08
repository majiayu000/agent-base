import type { Tool, ToolCall, ToolExecutionResult, ToolSchema } from './types.js';

// ============================================================================
// Tool Executor - Manages tool registration and execution
// ============================================================================

export class ToolExecutor {
  private tools: Map<string, Tool> = new Map();

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
   * Execute a single tool call
   */
  async execute(toolCall: ToolCall): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const toolName = toolCall.function.name;

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

    try {
      // Parse arguments
      let args: unknown;
      try {
        args = JSON.parse(toolCall.function.arguments || '{}');
      } catch (parseError) {
        return {
          toolCallId: toolCall.id,
          toolName,
          result: '',
          error: `Failed to parse tool arguments: ${parseError}`,
          durationMs: Date.now() - startTime,
        };
      }

      // Execute tool
      const result = await tool.execute(args);

      // Convert result to string
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      return {
        toolCallId: toolCall.id,
        toolName,
        result: resultStr,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        toolCallId: toolCall.id,
        toolName,
        result: '',
        error: `Tool execution failed: ${errorMessage}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute multiple tool calls in parallel
   */
  async executeMany(toolCalls: ToolCall[]): Promise<ToolExecutionResult[]> {
    return Promise.all(toolCalls.map((tc) => this.execute(tc)));
  }

  /**
   * Execute multiple tool calls sequentially
   */
  async executeManySequential(toolCalls: ToolCall[]): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];
    for (const tc of toolCalls) {
      results.push(await this.execute(tc));
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
  execute<TOutput>(fn: (args: TInput) => Promise<TOutput>): Tool<TInput, TOutput> {
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
  execute: (args: TInput) => Promise<TOutput>;
}): Tool<TInput, TOutput> {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    execute: config.execute,
  };
}
