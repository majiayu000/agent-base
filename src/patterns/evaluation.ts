// ============================================================================
// Evaluation & Monitoring Pattern - Performance assessment and tracking
// ============================================================================

export interface MetricValue {
  /** Metric name */
  name: string;
  /** Metric value */
  value: number;
  /** Timestamp */
  timestamp: Date;
  /** Additional labels/tags */
  labels?: Record<string, string>;
  /** Unit of measurement */
  unit?: string;
}

export interface EvaluationCriteria {
  /** Criteria ID */
  id: string;
  /** Criteria name */
  name: string;
  /** Criteria description */
  description: string;
  /** Weight (0-1) for scoring */
  weight: number;
  /** Scoring function */
  evaluate: (input: unknown, output: unknown, context?: Record<string, unknown>) => number | Promise<number>;
}

export interface EvaluationResult {
  /** Overall score (0-1) */
  score: number;
  /** Scores by criteria */
  criteriaScores: Record<string, number>;
  /** Passed threshold? */
  passed: boolean;
  /** Feedback */
  feedback: string[];
  /** Evaluation timestamp */
  timestamp: Date;
  /** Evaluation duration in ms */
  durationMs: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface MonitorConfig {
  /** Enable monitoring (default: true) */
  enabled: boolean;
  /** Metrics retention period in ms (default: 24 hours) */
  retentionMs: number;
  /** Alert thresholds */
  alertThresholds?: Record<string, { min?: number; max?: number }>;
  /** Alert callback */
  onAlert?: (metric: string, value: number, threshold: { min?: number; max?: number }) => void;
  /** Metric callback */
  onMetric?: (metric: MetricValue) => void;
}

export interface MonitorStats {
  /** Total metrics collected */
  totalMetrics: number;
  /** Metrics by name */
  metricCounts: Record<string, number>;
  /** Average values by metric */
  averages: Record<string, number>;
  /** Min values by metric */
  mins: Record<string, number>;
  /** Max values by metric */
  maxs: Record<string, number>;
  /** Alert count */
  alertCount: number;
  /** Uptime in ms */
  uptimeMs: number;
}

/**
 * Evaluator - evaluates agent outputs against criteria
 */
export class Evaluator {
  private criteria: Map<string, EvaluationCriteria> = new Map();
  private passThreshold: number;
  private history: EvaluationResult[] = [];

  constructor(options?: { passThreshold?: number }) {
    this.passThreshold = options?.passThreshold ?? 0.7;
  }

  /**
   * Add evaluation criteria
   */
  addCriteria(criteria: EvaluationCriteria): this {
    this.criteria.set(criteria.id, criteria);
    return this;
  }

  /**
   * Add multiple criteria
   */
  addCriteriaList(criteriaList: EvaluationCriteria[]): this {
    for (const c of criteriaList) {
      this.addCriteria(c);
    }
    return this;
  }

  /**
   * Remove criteria
   */
  removeCriteria(id: string): boolean {
    return this.criteria.delete(id);
  }

  /**
   * Get all criteria
   */
  getCriteria(): EvaluationCriteria[] {
    return Array.from(this.criteria.values());
  }

  /**
   * Evaluate an output
   */
  async evaluate(
    input: unknown,
    output: unknown,
    context?: Record<string, unknown>
  ): Promise<EvaluationResult> {
    const startTime = Date.now();
    const criteriaScores: Record<string, number> = {};
    const feedback: string[] = [];

    let totalWeight = 0;
    let weightedSum = 0;

    for (const [id, criteria] of this.criteria) {
      const score = await criteria.evaluate(input, output, context);
      criteriaScores[id] = score;

      weightedSum += score * criteria.weight;
      totalWeight += criteria.weight;

      if (score < 0.5) {
        feedback.push(`${criteria.name}: Low score (${(score * 100).toFixed(0)}%) - ${criteria.description}`);
      }
    }

    const overallScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const passed = overallScore >= this.passThreshold;

    if (passed) {
      feedback.push('Overall evaluation passed');
    } else {
      feedback.push(`Overall score (${(overallScore * 100).toFixed(0)}%) below threshold (${(this.passThreshold * 100).toFixed(0)}%)`);
    }

    const result: EvaluationResult = {
      score: overallScore,
      criteriaScores,
      passed,
      feedback,
      timestamp: new Date(),
      durationMs: Date.now() - startTime,
      metadata: context,
    };

    this.history.push(result);
    return result;
  }

  /**
   * Batch evaluate multiple outputs
   */
  async evaluateBatch(
    items: Array<{ input: unknown; output: unknown; context?: Record<string, unknown> }>
  ): Promise<EvaluationResult[]> {
    return Promise.all(items.map((item) => this.evaluate(item.input, item.output, item.context)));
  }

  /**
   * Get evaluation history
   */
  getHistory(): EvaluationResult[] {
    return [...this.history];
  }

  /**
   * Get aggregate statistics
   */
  getStats(): {
    totalEvaluations: number;
    passRate: number;
    averageScore: number;
    averageDurationMs: number;
    criteriaAverages: Record<string, number>;
  } {
    if (this.history.length === 0) {
      return {
        totalEvaluations: 0,
        passRate: 0,
        averageScore: 0,
        averageDurationMs: 0,
        criteriaAverages: {},
      };
    }

    const passCount = this.history.filter((r) => r.passed).length;
    const totalScore = this.history.reduce((sum, r) => sum + r.score, 0);
    const totalDuration = this.history.reduce((sum, r) => sum + r.durationMs, 0);

    const criteriaAverages: Record<string, number> = {};
    for (const criteria of this.criteria.values()) {
      const scores = this.history
        .map((r) => r.criteriaScores[criteria.id])
        .filter((s) => s !== undefined);
      if (scores.length > 0) {
        criteriaAverages[criteria.id] = scores.reduce((a, b) => a + b, 0) / scores.length;
      }
    }

    return {
      totalEvaluations: this.history.length,
      passRate: passCount / this.history.length,
      averageScore: totalScore / this.history.length,
      averageDurationMs: totalDuration / this.history.length,
      criteriaAverages,
    };
  }

  /**
   * Clear history
   */
  clearHistory(): void {
    this.history = [];
  }
}

/**
 * Monitor - collects and tracks metrics
 */
export class Monitor {
  private config: MonitorConfig;
  private metrics: MetricValue[] = [];
  private alertCount: number = 0;
  private startTime: Date;

  constructor(config?: Partial<MonitorConfig>) {
    this.config = {
      enabled: config?.enabled ?? true,
      retentionMs: config?.retentionMs ?? 24 * 60 * 60 * 1000,
      alertThresholds: config?.alertThresholds,
      onAlert: config?.onAlert,
      onMetric: config?.onMetric,
    };
    this.startTime = new Date();
  }

  /**
   * Record a metric
   */
  record(name: string, value: number, options?: { labels?: Record<string, string>; unit?: string }): void {
    if (!this.config.enabled) return;

    const metric: MetricValue = {
      name,
      value,
      timestamp: new Date(),
      labels: options?.labels,
      unit: options?.unit,
    };

    this.metrics.push(metric);
    this.config.onMetric?.(metric);

    // Check alert thresholds
    this.checkAlerts(name, value);

    // Cleanup old metrics
    this.cleanup();
  }

  /**
   * Record latency (convenience method)
   */
  recordLatency(name: string, durationMs: number, labels?: Record<string, string>): void {
    this.record(name, durationMs, { labels, unit: 'ms' });
  }

  /**
   * Record count (convenience method)
   */
  recordCount(name: string, count: number = 1, labels?: Record<string, string>): void {
    this.record(name, count, { labels, unit: 'count' });
  }

  /**
   * Record gauge (convenience method)
   */
  recordGauge(name: string, value: number, labels?: Record<string, string>): void {
    this.record(name, value, { labels, unit: 'gauge' });
  }

  /**
   * Create a timer for measuring duration
   */
  startTimer(name: string, labels?: Record<string, string>): () => number {
    const start = Date.now();
    return () => {
      const duration = Date.now() - start;
      this.recordLatency(name, duration, labels);
      return duration;
    };
  }

  /**
   * Check and trigger alerts
   */
  private checkAlerts(name: string, value: number): void {
    const threshold = this.config.alertThresholds?.[name];
    if (!threshold) return;

    if ((threshold.min !== undefined && value < threshold.min) ||
        (threshold.max !== undefined && value > threshold.max)) {
      this.alertCount++;
      this.config.onAlert?.(name, value, threshold);
    }
  }

  /**
   * Cleanup old metrics
   */
  private cleanup(): void {
    const cutoff = Date.now() - this.config.retentionMs;
    this.metrics = this.metrics.filter((m) => m.timestamp.getTime() > cutoff);
  }

  /**
   * Get metrics by name
   */
  getMetrics(name: string, options?: { since?: Date; labels?: Record<string, string> }): MetricValue[] {
    let filtered = this.metrics.filter((m) => m.name === name);

    if (options?.since) {
      filtered = filtered.filter((m) => m.timestamp >= options.since!);
    }

    if (options?.labels) {
      filtered = filtered.filter((m) => {
        if (!m.labels) return false;
        return Object.entries(options.labels!).every(([k, v]) => m.labels![k] === v);
      });
    }

    return filtered;
  }

  /**
   * Get all metric names
   */
  getMetricNames(): string[] {
    return [...new Set(this.metrics.map((m) => m.name))];
  }

  /**
   * Get statistics
   */
  getStats(): MonitorStats {
    const metricCounts: Record<string, number> = {};
    const sums: Record<string, number> = {};
    const mins: Record<string, number> = {};
    const maxs: Record<string, number> = {};

    for (const metric of this.metrics) {
      metricCounts[metric.name] = (metricCounts[metric.name] || 0) + 1;
      sums[metric.name] = (sums[metric.name] || 0) + metric.value;

      if (mins[metric.name] === undefined || metric.value < mins[metric.name]) {
        mins[metric.name] = metric.value;
      }
      if (maxs[metric.name] === undefined || metric.value > maxs[metric.name]) {
        maxs[metric.name] = metric.value;
      }
    }

    const averages: Record<string, number> = {};
    for (const [name, sum] of Object.entries(sums)) {
      averages[name] = sum / metricCounts[name];
    }

    return {
      totalMetrics: this.metrics.length,
      metricCounts,
      averages,
      mins,
      maxs,
      alertCount: this.alertCount,
      uptimeMs: Date.now() - this.startTime.getTime(),
    };
  }

  /**
   * Get percentile value
   */
  getPercentile(name: string, percentile: number): number | undefined {
    const values = this.getMetrics(name).map((m) => m.value).sort((a, b) => a - b);
    if (values.length === 0) return undefined;

    const index = Math.ceil((percentile / 100) * values.length) - 1;
    return values[Math.max(0, index)];
  }

  /**
   * Set alert threshold
   */
  setAlertThreshold(name: string, threshold: { min?: number; max?: number }): void {
    if (!this.config.alertThresholds) {
      this.config.alertThresholds = {};
    }
    this.config.alertThresholds[name] = threshold;
  }

  /**
   * Enable/disable monitoring
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics = [];
    this.alertCount = 0;
  }

  /**
   * Export metrics
   */
  export(): string {
    return JSON.stringify(this.metrics, null, 2);
  }
}

/**
 * Create an evaluator
 */
export function createEvaluator(options?: { passThreshold?: number }): Evaluator {
  return new Evaluator(options);
}

/**
 * Create a monitor
 */
export function createMonitor(config?: Partial<MonitorConfig>): Monitor {
  return new Monitor(config);
}

// ============================================================================
// Built-in Evaluation Criteria
// ============================================================================

/**
 * Length criteria - checks if output meets length requirements
 */
export const lengthCriteria: EvaluationCriteria = {
  id: 'length',
  name: 'Output Length',
  description: 'Checks if output has appropriate length',
  weight: 0.2,
  evaluate: (input, output) => {
    const text = String(output);
    const minLength = 50;
    const maxLength = 10000;

    if (text.length < minLength) {
      return text.length / minLength;
    }
    if (text.length > maxLength) {
      return maxLength / text.length;
    }
    return 1.0;
  },
};

/**
 * Relevance criteria - checks if output is relevant to input
 */
export const relevanceCriteria: EvaluationCriteria = {
  id: 'relevance',
  name: 'Response Relevance',
  description: 'Checks if output addresses the input',
  weight: 0.4,
  evaluate: (input, output) => {
    const inputText = String(input).toLowerCase();
    const outputText = String(output).toLowerCase();

    // Extract keywords from input
    const inputWords = new Set(
      inputText.split(/\W+/).filter((w) => w.length > 3)
    );

    if (inputWords.size === 0) return 1.0;

    // Count keyword matches in output
    let matches = 0;
    for (const word of inputWords) {
      if (outputText.includes(word)) {
        matches++;
      }
    }

    return matches / inputWords.size;
  },
};

/**
 * Completeness criteria - checks if output is complete
 */
export const completenessCriteria: EvaluationCriteria = {
  id: 'completeness',
  name: 'Response Completeness',
  description: 'Checks if output appears complete',
  weight: 0.2,
  evaluate: (input, output) => {
    const text = String(output);

    // Check for common incomplete patterns
    const incompletePatterns = [
      /\.{3,}$/,           // Trailing ellipsis
      /\s+$\n?$/,          // Trailing whitespace only
      /^\s*$/,             // Empty or whitespace only
      /I cannot|I'm unable/i,  // Refusal patterns
    ];

    for (const pattern of incompletePatterns) {
      if (pattern.test(text)) {
        return 0.5;
      }
    }

    // Check for sentence ending
    const endsWithPunctuation = /[.!?][\s"']*$/.test(text.trim());
    return endsWithPunctuation ? 1.0 : 0.7;
  },
};

/**
 * Format criteria - checks if output has good formatting
 */
export const formatCriteria: EvaluationCriteria = {
  id: 'format',
  name: 'Output Format',
  description: 'Checks if output is well-formatted',
  weight: 0.2,
  evaluate: (input, output) => {
    const text = String(output);
    let score = 1.0;

    // Penalize excessive line breaks
    const lineBreakRatio = (text.match(/\n/g) || []).length / text.length;
    if (lineBreakRatio > 0.1) {
      score -= 0.2;
    }

    // Penalize no paragraphs in long text
    if (text.length > 500 && !text.includes('\n\n')) {
      score -= 0.1;
    }

    // Reward structured content
    if (text.includes('```') || text.includes('- ') || text.includes('1.')) {
      score += 0.1;
    }

    return Math.max(0, Math.min(1, score));
  },
};

/**
 * Built-in criteria collection
 */
export const builtinCriteria: EvaluationCriteria[] = [
  lengthCriteria,
  relevanceCriteria,
  completenessCriteria,
  formatCriteria,
];

/**
 * Create evaluator with built-in criteria
 */
export function createDefaultEvaluator(options?: { passThreshold?: number }): Evaluator {
  return new Evaluator(options).addCriteriaList(builtinCriteria);
}
