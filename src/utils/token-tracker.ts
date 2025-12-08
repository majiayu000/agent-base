// ============================================================================
// Token & Cost Tracker - Track token usage and calculate costs
// ============================================================================

export interface ModelPricing {
  inputPricePerMillion: number;  // USD per 1M input tokens
  outputPricePerMillion: number; // USD per 1M output tokens
}

export interface UsageRecord {
  timestamp: Date;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

export interface UsageSummary {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalInputCost: number;
  totalOutputCost: number;
  totalCost: number;
  totalDurationMs: number;
  averageTokensPerRequest: number;
  averageCostPerRequest: number;
  averageLatencyMs: number;
  byModel: Record<string, {
    requests: number;
    tokens: number;
    cost: number;
  }>;
}

// OpenRouter / LiteLLM 模型定价 (2025年12月)
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // DeepSeek Models
  'deepseek/deepseek-chat': { inputPricePerMillion: 0.14, outputPricePerMillion: 0.28 },
  'deepseek/deepseek-v3.2-20251201': { inputPricePerMillion: 0.14, outputPricePerMillion: 0.28 },
  'deepseek/deepseek-v3.1-terminus': { inputPricePerMillion: 0.14, outputPricePerMillion: 0.28 },
  'deepseek/deepseek-r1': { inputPricePerMillion: 0.55, outputPricePerMillion: 2.19 },
  'deepseek/deepseek-r1:free': { inputPricePerMillion: 0, outputPricePerMillion: 0 },

  // Claude Models
  'anthropic/claude-sonnet-4.5': { inputPricePerMillion: 3.0, outputPricePerMillion: 15.0 },
  'anthropic/claude-opus-4.5': { inputPricePerMillion: 15.0, outputPricePerMillion: 75.0 },
  'anthropic/claude-3.5-sonnet': { inputPricePerMillion: 3.0, outputPricePerMillion: 15.0 },
  'anthropic/claude-3.7-sonnet': { inputPricePerMillion: 3.0, outputPricePerMillion: 15.0 },

  // OpenAI Models
  'openai/gpt-4o': { inputPricePerMillion: 2.5, outputPricePerMillion: 10.0 },
  'openai/gpt-4o-mini': { inputPricePerMillion: 0.15, outputPricePerMillion: 0.6 },
  'openai/gpt-5.1': { inputPricePerMillion: 5.0, outputPricePerMillion: 15.0 },

  // Google Models
  'google/gemini-3-pro-preview': { inputPricePerMillion: 1.25, outputPricePerMillion: 5.0 },
  'google/gemini-2.0-flash': { inputPricePerMillion: 0.1, outputPricePerMillion: 0.4 },

  // Default fallback
  'default': { inputPricePerMillion: 1.0, outputPricePerMillion: 3.0 },
};

export class TokenTracker {
  private records: UsageRecord[] = [];
  private customPricing: Record<string, ModelPricing> = {};

  /**
   * Set custom pricing for a model
   */
  setModelPricing(model: string, pricing: ModelPricing): void {
    this.customPricing[model] = pricing;
  }

  /**
   * Get pricing for a model
   */
  getPricing(model: string): ModelPricing {
    return this.customPricing[model] || MODEL_PRICING[model] || MODEL_PRICING['default'];
  }

  /**
   * Calculate cost from tokens
   */
  calculateCost(model: string, promptTokens: number, completionTokens: number): {
    inputCost: number;
    outputCost: number;
    totalCost: number;
  } {
    const pricing = this.getPricing(model);
    const inputCost = (promptTokens / 1_000_000) * pricing.inputPricePerMillion;
    const outputCost = (completionTokens / 1_000_000) * pricing.outputPricePerMillion;

    return {
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
    };
  }

  /**
   * Record a usage event
   */
  record(data: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    durationMs: number;
    metadata?: Record<string, unknown>;
  }): UsageRecord {
    const costs = this.calculateCost(data.model, data.promptTokens, data.completionTokens);

    const record: UsageRecord = {
      timestamp: new Date(),
      model: data.model,
      promptTokens: data.promptTokens,
      completionTokens: data.completionTokens,
      totalTokens: data.promptTokens + data.completionTokens,
      inputCost: costs.inputCost,
      outputCost: costs.outputCost,
      totalCost: costs.totalCost,
      durationMs: data.durationMs,
      metadata: data.metadata,
    };

    this.records.push(record);
    return record;
  }

  /**
   * Get all records
   */
  getRecords(): UsageRecord[] {
    return [...this.records];
  }

  /**
   * Get summary statistics
   */
  getSummary(): UsageSummary {
    const byModel: Record<string, { requests: number; tokens: number; cost: number }> = {};

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalInputCost = 0;
    let totalOutputCost = 0;
    let totalDurationMs = 0;

    for (const record of this.records) {
      totalPromptTokens += record.promptTokens;
      totalCompletionTokens += record.completionTokens;
      totalInputCost += record.inputCost;
      totalOutputCost += record.outputCost;
      totalDurationMs += record.durationMs;

      if (!byModel[record.model]) {
        byModel[record.model] = { requests: 0, tokens: 0, cost: 0 };
      }
      byModel[record.model].requests++;
      byModel[record.model].tokens += record.totalTokens;
      byModel[record.model].cost += record.totalCost;
    }

    const totalRequests = this.records.length;
    const totalTokens = totalPromptTokens + totalCompletionTokens;
    const totalCost = totalInputCost + totalOutputCost;

    return {
      totalRequests,
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      totalInputCost,
      totalOutputCost,
      totalCost,
      totalDurationMs,
      averageTokensPerRequest: totalRequests > 0 ? totalTokens / totalRequests : 0,
      averageCostPerRequest: totalRequests > 0 ? totalCost / totalRequests : 0,
      averageLatencyMs: totalRequests > 0 ? totalDurationMs / totalRequests : 0,
      byModel,
    };
  }

  /**
   * Format summary as string
   */
  formatSummary(): string {
    const summary = this.getSummary();

    const lines = [
      '╔══════════════════════════════════════════════════════════════╗',
      '║                    Token & Cost Summary                      ║',
      '╠══════════════════════════════════════════════════════════════╣',
      `║  Total Requests:     ${summary.totalRequests.toString().padStart(8)}                            ║`,
      `║  Total Tokens:       ${summary.totalTokens.toString().padStart(8)}                            ║`,
      `║    - Input:          ${summary.totalPromptTokens.toString().padStart(8)}                            ║`,
      `║    - Output:         ${summary.totalCompletionTokens.toString().padStart(8)}                            ║`,
      '╠══════════════════════════════════════════════════════════════╣',
      `║  Total Cost:         $${summary.totalCost.toFixed(6).padStart(10)}                          ║`,
      `║    - Input Cost:     $${summary.totalInputCost.toFixed(6).padStart(10)}                          ║`,
      `║    - Output Cost:    $${summary.totalOutputCost.toFixed(6).padStart(10)}                          ║`,
      '╠══════════════════════════════════════════════════════════════╣',
      `║  Avg Tokens/Req:     ${summary.averageTokensPerRequest.toFixed(1).padStart(8)}                            ║`,
      `║  Avg Cost/Req:       $${summary.averageCostPerRequest.toFixed(6).padStart(10)}                          ║`,
      `║  Avg Latency:        ${summary.averageLatencyMs.toFixed(0).padStart(6)}ms                              ║`,
      '╠══════════════════════════════════════════════════════════════╣',
      '║  By Model:                                                   ║',
    ];

    for (const [model, stats] of Object.entries(summary.byModel)) {
      const shortModel = model.length > 35 ? model.slice(0, 32) + '...' : model;
      lines.push(`║    ${shortModel.padEnd(36)} ${stats.requests}req ${stats.tokens}tok $${stats.cost.toFixed(4).padStart(8)} ║`);
    }

    lines.push('╚══════════════════════════════════════════════════════════════╝');

    return lines.join('\n');
  }

  /**
   * Clear all records
   */
  clear(): void {
    this.records = [];
  }

  /**
   * Export to JSON
   */
  toJSON(): string {
    return JSON.stringify({
      records: this.records,
      summary: this.getSummary(),
    }, null, 2);
  }
}

// Singleton instance
export const tokenTracker = new TokenTracker();
