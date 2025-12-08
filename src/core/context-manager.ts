import type { Message } from './types.js';

// ============================================================================
// Context Manager - Manages conversation history with automatic compaction
// ============================================================================

export interface ContextManagerOptions {
  /** Maximum tokens before triggering compaction */
  maxTokens: number;
  /** Threshold ratio to trigger compaction (default: 0.8) */
  compactionThreshold?: number;
  /** Number of recent messages to preserve during compaction */
  preserveRecentCount?: number;
  /** Custom token estimator function */
  tokenEstimator?: (text: string) => number;
  /** Callback when context is compacted */
  onCompact?: (beforeTokens: number, afterTokens: number) => void;
}

export class ContextManager {
  private messages: Message[] = [];
  private tokenCount = 0;
  private readonly maxTokens: number;
  private readonly compactionThreshold: number;
  private readonly preserveRecentCount: number;
  private readonly tokenEstimator: (text: string) => number;
  private readonly onCompact?: (beforeTokens: number, afterTokens: number) => void;

  constructor(options: ContextManagerOptions) {
    this.maxTokens = options.maxTokens;
    this.compactionThreshold = options.compactionThreshold ?? 0.8;
    this.preserveRecentCount = options.preserveRecentCount ?? 20;
    this.tokenEstimator = options.tokenEstimator ?? this.defaultTokenEstimator;
    this.onCompact = options.onCompact;
  }

  /**
   * Add a message to the context
   */
  add(message: Message): void {
    this.messages.push(message);
    this.tokenCount += this.estimateMessageTokens(message);

    // Check if compaction is needed
    if (this.tokenCount > this.maxTokens * this.compactionThreshold) {
      this.compact();
    }
  }

  /**
   * Add multiple messages at once
   */
  addMany(messages: Message[]): void {
    for (const msg of messages) {
      this.add(msg);
    }
  }

  /**
   * Get all messages
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Get current token count estimate
   */
  getTokenCount(): number {
    return this.tokenCount;
  }

  /**
   * Clear all messages except system prompt
   */
  clear(): void {
    const systemMessage = this.messages.find((m) => m.role === 'system');
    this.messages = systemMessage ? [systemMessage] : [];
    this.tokenCount = systemMessage ? this.estimateMessageTokens(systemMessage) : 0;
  }

  /**
   * Compact the context by summarizing older messages
   */
  private compact(): { beforeTokens: number; afterTokens: number } {
    const beforeTokens = this.tokenCount;

    // Find system message
    const systemMessage = this.messages.find((m) => m.role === 'system');

    // Get recent messages to preserve
    const recentMessages = this.messages.slice(-this.preserveRecentCount);

    // Get middle messages to summarize
    const startIndex = systemMessage ? 1 : 0;
    const endIndex = this.messages.length - this.preserveRecentCount;

    if (endIndex <= startIndex) {
      // Not enough messages to compact
      return { beforeTokens, afterTokens: beforeTokens };
    }

    const middleMessages = this.messages.slice(startIndex, endIndex);

    // Generate summary
    const summary = this.generateSummary(middleMessages);

    // Rebuild messages array
    this.messages = [];

    if (systemMessage) {
      this.messages.push(systemMessage);
    }

    // Add summary as a context message
    if (summary) {
      this.messages.push({
        role: 'user',
        content: `[Previous conversation summary]\n${summary}\n[End of summary]`,
      });
    }

    // Add recent messages
    this.messages.push(...recentMessages);

    // Recalculate token count
    this.tokenCount = this.messages.reduce((sum, msg) => sum + this.estimateMessageTokens(msg), 0);

    // Notify callback
    this.onCompact?.(beforeTokens, this.tokenCount);

    return { beforeTokens, afterTokens: this.tokenCount };
  }

  /**
   * Generate a summary of messages (simple implementation)
   * In production, you might want to use LLM for summarization
   */
  private generateSummary(messages: Message[]): string {
    const summaryParts: string[] = [];

    let currentUserQuery = '';
    let toolResults: string[] = [];

    for (const msg of messages) {
      switch (msg.role) {
        case 'user':
          // Save user query
          if (msg.content && !msg.content.startsWith('[Previous conversation')) {
            currentUserQuery = msg.content.slice(0, 200);
            if (msg.content.length > 200) currentUserQuery += '...';
          }
          break;

        case 'assistant':
          // Summarize assistant response
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            const toolNames = msg.tool_calls.map((tc) => tc.function.name).join(', ');
            summaryParts.push(`- Called tools: ${toolNames}`);
          } else if (msg.content) {
            const snippet = msg.content.slice(0, 150);
            summaryParts.push(`- Q: ${currentUserQuery}\n  A: ${snippet}${msg.content.length > 150 ? '...' : ''}`);
          }
          break;

        case 'tool':
          // Collect tool results
          if (msg.content) {
            const resultSnippet = msg.content.slice(0, 100);
            toolResults.push(`${resultSnippet}${msg.content.length > 100 ? '...' : ''}`);
          }
          break;
      }
    }

    if (toolResults.length > 0) {
      summaryParts.push(`- Tool results collected: ${toolResults.length} results`);
    }

    return summaryParts.join('\n');
  }

  /**
   * Estimate tokens for a message
   */
  private estimateMessageTokens(message: Message): number {
    let text = message.content || '';

    // Include tool call information in estimate
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        text += tc.function.name + tc.function.arguments;
      }
    }

    return this.tokenEstimator(text);
  }

  /**
   * Default token estimator (rough approximation)
   * ~4 characters per token for English text
   */
  private defaultTokenEstimator(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Force compaction (useful for testing or manual control)
   */
  forceCompact(): { beforeTokens: number; afterTokens: number } {
    return this.compact();
  }

  /**
   * Get statistics about the context
   */
  getStats(): {
    messageCount: number;
    tokenCount: number;
    maxTokens: number;
    utilizationPercent: number;
  } {
    return {
      messageCount: this.messages.length,
      tokenCount: this.tokenCount,
      maxTokens: this.maxTokens,
      utilizationPercent: (this.tokenCount / this.maxTokens) * 100,
    };
  }
}
