// ============================================================================
// Safety Guardrails Pattern - Input/Output validation and filtering
// ============================================================================

export interface GuardrailRule {
  /** Rule identifier */
  id: string;
  /** Rule name */
  name: string;
  /** Rule description */
  description: string;
  /** Check function - returns true if content is safe */
  check: (content: string, context?: Record<string, unknown>) => boolean | Promise<boolean>;
  /** Action to take when rule is violated */
  action: 'block' | 'warn' | 'sanitize';
  /** Sanitize function (required if action is 'sanitize') */
  sanitize?: (content: string) => string;
  /** Whether rule is enabled */
  enabled?: boolean;
  /** Rule priority (higher = checked first) */
  priority?: number;
}

export interface GuardrailViolation {
  /** Rule that was violated */
  rule: GuardrailRule;
  /** Original content that violated the rule */
  content: string;
  /** Timestamp of violation */
  timestamp: Date;
  /** Additional context */
  context?: Record<string, unknown>;
}

export interface GuardrailResult {
  /** Whether content passed all checks */
  passed: boolean;
  /** Original content */
  original: string;
  /** Sanitized content (if any sanitization occurred) */
  sanitized?: string;
  /** List of violations */
  violations: GuardrailViolation[];
  /** Warnings (non-blocking violations) */
  warnings: GuardrailViolation[];
  /** Processing time in ms */
  processingTimeMs: number;
}

export interface GuardrailsConfig {
  /** Whether to run all rules or stop at first block (default: false) */
  runAllRules: boolean;
  /** Maximum content length (default: 100000) */
  maxContentLength: number;
  /** Log violations (default: true) */
  logViolations: boolean;
}

// ============================================================================
// Built-in Rules
// ============================================================================

/**
 * Block content containing potential prompt injection patterns
 */
export const promptInjectionRule: GuardrailRule = {
  id: 'prompt-injection',
  name: 'Prompt Injection Detection',
  description: 'Detects and blocks potential prompt injection attempts',
  action: 'block',
  priority: 100,
  enabled: true,
  check: (content: string) => {
    const patterns = [
      /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?)/i,
      /disregard\s+(all\s+)?(previous|above|prior)/i,
      /forget\s+(everything|all)\s+(you|your)/i,
      /you\s+are\s+now\s+[a-z]+/i,
      /new\s+instructions?:/i,
      /system\s*:\s*you\s+are/i,
      /\[system\]/i,
      /\{\{.*\}\}/i,
      /<\|.*\|>/i,
    ];
    return !patterns.some((p) => p.test(content));
  },
};

/**
 * Block content with PII (Personally Identifiable Information)
 */
export const piiDetectionRule: GuardrailRule = {
  id: 'pii-detection',
  name: 'PII Detection',
  description: 'Detects content containing potential PII',
  action: 'warn',
  priority: 90,
  enabled: true,
  check: (content: string) => {
    const patterns = [
      /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/, // SSN
      /\b\d{16}\b/, // Credit card (simple)
      /\b[A-Z]{2}\d{6,9}\b/, // Passport
      /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/, // Phone
    ];
    return !patterns.some((p) => p.test(content));
  },
};

/**
 * Sanitize HTML/script tags
 */
export const xssSanitizeRule: GuardrailRule = {
  id: 'xss-sanitize',
  name: 'XSS Sanitization',
  description: 'Sanitizes potential XSS content',
  action: 'sanitize',
  priority: 80,
  enabled: true,
  check: (content: string) => {
    const patterns = [
      /<script\b[^>]*>/i,
      /<\/script>/i,
      /javascript:/i,
      /on\w+\s*=/i,
    ];
    return !patterns.some((p) => p.test(content));
  },
  sanitize: (content: string) => {
    return content
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '[SCRIPT REMOVED]')
      .replace(/javascript:/gi, '[BLOCKED]')
      .replace(/on\w+\s*=/gi, '[EVENT REMOVED]=');
  },
};

/**
 * Block extremely long content
 */
export const contentLengthRule: GuardrailRule = {
  id: 'content-length',
  name: 'Content Length Limit',
  description: 'Blocks excessively long content',
  action: 'block',
  priority: 100,
  enabled: true,
  check: (content: string, context) => {
    const maxLength = (context?.maxContentLength as number) || 100000;
    return content.length <= maxLength;
  },
};

/**
 * Detect toxic/harmful language patterns
 */
export const toxicContentRule: GuardrailRule = {
  id: 'toxic-content',
  name: 'Toxic Content Detection',
  description: 'Detects potentially harmful or toxic content',
  action: 'warn',
  priority: 85,
  enabled: true,
  check: (content: string) => {
    // This is a simplified check - production would use ML models
    const toxicPatterns = [
      /\b(kill|murder|attack|bomb|weapon)\s+(yourself|someone|people|them)\b/i,
      /\bhow\s+to\s+(make|build|create)\s+(a\s+)?(bomb|weapon|explosive)/i,
    ];
    return !toxicPatterns.some((p) => p.test(content));
  },
};

/**
 * All built-in rules
 */
export const builtinRules: GuardrailRule[] = [
  promptInjectionRule,
  piiDetectionRule,
  xssSanitizeRule,
  contentLengthRule,
  toxicContentRule,
];

// ============================================================================
// Guardrails Class
// ============================================================================

/**
 * Guardrails class - implements input/output validation
 */
export class Guardrails {
  private rules: Map<string, GuardrailRule> = new Map();
  private config: GuardrailsConfig;
  private violations: GuardrailViolation[] = [];

  constructor(config?: Partial<GuardrailsConfig>) {
    this.config = {
      runAllRules: config?.runAllRules ?? false,
      maxContentLength: config?.maxContentLength ?? 100000,
      logViolations: config?.logViolations ?? true,
    };
  }

  /**
   * Add a rule
   */
  addRule(rule: GuardrailRule): this {
    this.rules.set(rule.id, { ...rule, enabled: rule.enabled ?? true });
    return this;
  }

  /**
   * Add multiple rules
   */
  addRules(rules: GuardrailRule[]): this {
    for (const rule of rules) {
      this.addRule(rule);
    }
    return this;
  }

  /**
   * Add all built-in rules
   */
  useBuiltinRules(): this {
    return this.addRules(builtinRules);
  }

  /**
   * Remove a rule
   */
  removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  /**
   * Enable/disable a rule
   */
  setRuleEnabled(id: string, enabled: boolean): boolean {
    const rule = this.rules.get(id);
    if (rule) {
      rule.enabled = enabled;
      return true;
    }
    return false;
  }

  /**
   * Get all rules
   */
  getRules(): GuardrailRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Get enabled rules sorted by priority
   */
  getEnabledRules(): GuardrailRule[] {
    return this.getRules()
      .filter((r) => r.enabled)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /**
   * Check content against all rules
   */
  async check(content: string, context?: Record<string, unknown>): Promise<GuardrailResult> {
    const startTime = Date.now();
    const result: GuardrailResult = {
      passed: true,
      original: content,
      violations: [],
      warnings: [],
      processingTimeMs: 0,
    };

    let currentContent = content;
    const ctx = { ...context, maxContentLength: this.config.maxContentLength };

    for (const rule of this.getEnabledRules()) {
      const checkResult = await rule.check(currentContent, ctx);

      if (!checkResult) {
        const violation: GuardrailViolation = {
          rule,
          content: currentContent,
          timestamp: new Date(),
          context: ctx,
        };

        if (this.config.logViolations) {
          this.violations.push(violation);
        }

        switch (rule.action) {
          case 'block':
            result.passed = false;
            result.violations.push(violation);
            if (!this.config.runAllRules) {
              result.processingTimeMs = Date.now() - startTime;
              return result;
            }
            break;

          case 'warn':
            result.warnings.push(violation);
            break;

          case 'sanitize':
            if (rule.sanitize) {
              currentContent = rule.sanitize(currentContent);
              result.sanitized = currentContent;
            }
            break;
        }
      }
    }

    result.processingTimeMs = Date.now() - startTime;
    return result;
  }

  /**
   * Validate input (convenience method)
   */
  async validateInput(input: string): Promise<GuardrailResult> {
    return this.check(input, { type: 'input' });
  }

  /**
   * Validate output (convenience method)
   */
  async validateOutput(output: string): Promise<GuardrailResult> {
    return this.check(output, { type: 'output' });
  }

  /**
   * Get violation history
   */
  getViolations(): GuardrailViolation[] {
    return [...this.violations];
  }

  /**
   * Clear violation history
   */
  clearViolations(): void {
    this.violations = [];
  }

  /**
   * Get violation statistics
   */
  getStats(): {
    totalViolations: number;
    byRule: Record<string, number>;
    byAction: Record<string, number>;
  } {
    const byRule: Record<string, number> = {};
    const byAction: Record<string, number> = {};

    for (const v of this.violations) {
      byRule[v.rule.id] = (byRule[v.rule.id] || 0) + 1;
      byAction[v.rule.action] = (byAction[v.rule.action] || 0) + 1;
    }

    return {
      totalViolations: this.violations.length,
      byRule,
      byAction,
    };
  }
}

/**
 * Create a guardrails instance
 */
export function createGuardrails(config?: Partial<GuardrailsConfig>): Guardrails {
  return new Guardrails(config);
}

/**
 * Create guardrails with built-in rules
 */
export function createDefaultGuardrails(config?: Partial<GuardrailsConfig>): Guardrails {
  return new Guardrails(config).useBuiltinRules();
}
