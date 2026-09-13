import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { Stream } from 'openai/streaming';
import { createAbortError, throwIfAborted } from '../utils/abort.js';
import type { LLMClientConfig, Message, ToolCall } from './types.js';

// ============================================================================
// LLM Client - Wrapper around OpenAI SDK for LiteLLM compatibility
// ============================================================================

export class LLMClient {
  private client: OpenAI;

  constructor(config?: Partial<LLMClientConfig>) {
    this.client = new OpenAI({
      baseURL: config?.baseURL || process.env.LITELLM_BASE_URL || 'http://localhost:4000/v1',
      apiKey: config?.apiKey || process.env.LITELLM_API_KEY || process.env.OPENAI_API_KEY || '',
    });
  }

  /**
   * Create a streaming chat completion with extended thinking support
   */
  async createStream(options: {
    model: string;
    messages: Message[];
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    thinkingBudget?: number;
    maxTokens?: number;
    /** Cancel the underlying HTTP request when aborted */
    signal?: AbortSignal;
  }): Promise<Stream<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    const { model, messages, tools, thinkingBudget, maxTokens, signal } = options;
    throwIfAborted(signal);

    // Convert messages to OpenAI format
    const openaiMessages: ChatCompletionMessageParam[] = messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: msg.content || '',
          tool_call_id: msg.tool_call_id || '',
        };
      }

      if (msg.role === 'assistant' && msg.tool_calls) {
        return {
          role: 'assistant' as const,
          content: msg.content,
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        };
      }

      return {
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content || '',
      };
    });

    // Build request with LiteLLM extended thinking support
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestBody: any = {
      model,
      messages: openaiMessages,
      stream: true,
      max_tokens: maxTokens || 16000,
      stream_options: { include_usage: true }, // Enable usage tracking in stream
    };

    // Add tools if provided
    if (tools && tools.length > 0) {
      requestBody.tools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    // Add thinking parameter for Claude models via LiteLLM
    if (thinkingBudget && thinkingBudget > 0) {
      requestBody.thinking = {
        type: 'enabled',
        budget_tokens: thinkingBudget,
      };
    }

    return this.client.chat.completions.create(
      requestBody,
      signal ? { signal } : undefined
    ) as unknown as Promise<Stream<OpenAI.Chat.Completions.ChatCompletionChunk>>;
  }

  /**
   * Create a non-streaming chat completion
   */
  async create(options: {
    model: string;
    messages: Message[];
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    thinkingBudget?: number;
    maxTokens?: number;
    /** Cancel the underlying HTTP request when aborted */
    signal?: AbortSignal;
  }): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const { model, messages, tools, thinkingBudget, maxTokens, signal } = options;
    throwIfAborted(signal);

    const openaiMessages: ChatCompletionMessageParam[] = messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: msg.content || '',
          tool_call_id: msg.tool_call_id || '',
        };
      }

      if (msg.role === 'assistant' && msg.tool_calls) {
        return {
          role: 'assistant' as const,
          content: msg.content,
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        };
      }

      return {
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content || '',
      };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestBody: any = {
      model,
      messages: openaiMessages,
      stream: false,
      max_tokens: maxTokens || 16000,
    };

    if (tools && tools.length > 0) {
      requestBody.tools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    if (thinkingBudget && thinkingBudget > 0) {
      requestBody.thinking = {
        type: 'enabled',
        budget_tokens: thinkingBudget,
      };
    }

    return this.client.chat.completions.create(
      requestBody,
      signal ? { signal } : undefined
    );
  }
}

// ============================================================================
// Stream Parser - Parse streaming response into structured data
// ============================================================================

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ParsedStreamResult {
  content: string;
  toolCalls: ToolCall[];
  thinking: string;
  finishReason: string | null;
  usage?: TokenUsage;
}

export async function parseStream(
  stream: Stream<OpenAI.Chat.Completions.ChatCompletionChunk>,
  callbacks?: {
    onToken?: (token: string) => void;
    onThinking?: (thinking: string) => void;
    onToolCallStart?: (name: string) => void;
    onUsage?: (usage: TokenUsage) => void;
    /** Stop consuming the stream and abort the request when fired */
    signal?: AbortSignal;
  }
): Promise<ParsedStreamResult> {
  let content = '';
  let thinking = '';
  let finishReason: string | null = null;
  let usage: TokenUsage | undefined;
  const toolCallsMap: Map<number, { id: string; name: string; arguments: string }> = new Map();
  const signal = callbacks?.signal;

  const abortStream = () => {
    const controller = (stream as { controller?: AbortController }).controller;
    controller?.abort();
  };

  if (signal?.aborted) {
    abortStream();
    throw signal.reason instanceof Error ? signal.reason : createAbortError();
  }

  const onAbort = () => abortStream();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);

      // Handle usage info (comes in final chunk with stream_options.include_usage=true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chunkAny = chunk as any;
      if (chunkAny.usage) {
        usage = {
          promptTokens: chunkAny.usage.prompt_tokens || 0,
          completionTokens: chunkAny.usage.completion_tokens || 0,
          totalTokens: chunkAny.usage.total_tokens || 0,
        };
        callbacks?.onUsage?.(usage);
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;

      // Handle finish reason
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      // Handle thinking (LiteLLM may pass through as custom field)
      const deltaAny = delta as Record<string, unknown>;
      if (deltaAny.thinking && typeof deltaAny.thinking === 'string') {
        thinking += deltaAny.thinking;
        callbacks?.onThinking?.(deltaAny.thinking);
      }

      // Handle content
      if (delta.content) {
        content += delta.content;
        callbacks?.onToken?.(delta.content);
      }

      // Handle tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index;

          if (!toolCallsMap.has(index)) {
            toolCallsMap.set(index, { id: '', name: '', arguments: '' });
          }

          const existing = toolCallsMap.get(index)!;

          if (tc.id) {
            existing.id = tc.id;
          }
          if (tc.function?.name) {
            existing.name += tc.function.name;
            callbacks?.onToolCallStart?.(existing.name);
          }
          if (tc.function?.arguments) {
            existing.arguments += tc.function.arguments;
          }
        }
      }
    }

    // Abort during final-chunk callbacks (e.g. onToken → Agent.abort()) can
    // finish the iterator normally with no further yielded chunk. Recheck
    // before treating the parse as successful.
    throwIfAborted(signal);

    // Convert tool calls map to array
    const toolCalls: ToolCall[] = Array.from(toolCallsMap.values())
      .filter((tc) => tc.id && tc.name)
      .map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));

    return {
      content,
      toolCalls,
      thinking,
      finishReason,
      usage,
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
