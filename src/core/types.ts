import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

// ============================================================================
// Configuration Types
// ============================================================================

export interface AgentConfig {
  /** LLM model identifier (e.g., 'anthropic/claude-sonnet-4-5-20250514') */
  model: string;
  /** Extended thinking token budget (default: 32000 for ultrathink) */
  thinkingBudget: number;
  /** Maximum output tokens */
  maxTokens: number;
  /** Maximum ReAct loop iterations */
  maxIterations: number;
  /** Maximum context tokens before compression */
  maxContextTokens: number;
  /** Maximum tool result length in characters (default: 10000) */
  maxToolResultLength: number;
}

export const defaultConfig: AgentConfig = {
  model: process.env.AGENT_MODEL || 'anthropic/claude-sonnet-4-5-20250514',
  thinkingBudget: Number(process.env.AGENT_THINKING_BUDGET) || 32000,
  maxTokens: Number(process.env.AGENT_MAX_TOKENS) || 16000,
  maxIterations: Number(process.env.AGENT_MAX_ITERATIONS) || 15,
  maxContextTokens: 150000,
  maxToolResultLength: 10000,
};

// ============================================================================
// Message Types
// ============================================================================

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

export interface Message {
  role: MessageRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

// ============================================================================
// Tool Types
// ============================================================================

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
}

export interface ToolSchema extends Record<string, unknown> {
  type: 'object';
  properties: Record<string, ToolParameter>;
  required?: string[];
}

export interface Tool<TInput = unknown, TOutput = unknown> {
  /** Unique tool name */
  name: string;
  /** Description for LLM to understand when to use this tool */
  description: string;
  /** JSON Schema for input parameters */
  parameters: ToolSchema;
  /** Execute the tool with parsed arguments */
  execute: (args: TInput) => Promise<TOutput>;
}

// ============================================================================
// Agent Event Types (for observability)
// ============================================================================

export interface AgentEvents {
  /** Called when streaming text tokens */
  onToken?: (token: string) => void;
  /** Called when thinking content is available */
  onThinking?: (thinking: string) => void;
  /** Called before executing a tool */
  onToolCall?: (toolName: string, args: unknown) => void;
  /** Called after tool execution */
  onToolResult?: (toolName: string, result: unknown, error?: Error) => void;
  /** Called on each iteration of the ReAct loop */
  onIteration?: (iteration: number, message: Message) => void;
  /** Called when context is compacted */
  onContextCompact?: (beforeTokens: number, afterTokens: number) => void;
  /** Called on error */
  onError?: (error: Error) => void;
}

// ============================================================================
// LLM Client Types
// ============================================================================

export interface LLMClientConfig {
  baseURL: string;
  apiKey: string;
}

export interface ChatOptions {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  thinking?: {
    type: 'enabled' | 'disabled';
    budget_tokens?: number;
  };
  maxTokens?: number;
  stream?: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export type ContentBlock = ThinkingBlock | TextBlock;

// ============================================================================
// Tool Execution Types
// ============================================================================

export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  result: string;
  error?: string;
  durationMs: number;
}

// ============================================================================
// Agent Result Types
// ============================================================================

export interface TokenUsageStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AgentResult {
  /** Final text response */
  response: string;
  /** Number of iterations taken */
  iterations: number;
  /** All tool calls made during execution */
  toolCalls: Array<{
    name: string;
    args: unknown;
    result: string;
    error?: string;
  }>;
  /** Total thinking content (if available) */
  thinking?: string;
  /** Whether max iterations was reached */
  maxIterationsReached: boolean;
  /** Token usage statistics from all LLM calls */
  usage?: TokenUsageStats;
}
