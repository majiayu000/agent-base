// ============================================================================
// Prompt Chaining Pattern - Sequential task decomposition and execution
// ============================================================================

export interface ChainStep<TInput = unknown, TOutput = unknown> {
  /** Step identifier */
  id: string;
  /** Step name */
  name: string;
  /** Step description */
  description?: string;
  /** Execute function */
  execute: (input: TInput, context: ChainContext) => Promise<TOutput>;
  /** Validate input before execution */
  validateInput?: (input: TInput) => boolean | Promise<boolean>;
  /** Transform output before passing to next step */
  transformOutput?: (output: TOutput) => unknown;
  /** Retry configuration */
  retry?: {
    maxAttempts: number;
    delayMs: number;
    backoff?: 'linear' | 'exponential';
  };
  /** Timeout in ms (0 = no timeout) */
  timeoutMs?: number;
  /** Whether to continue on error */
  continueOnError?: boolean;
  /** Condition to skip this step */
  skipIf?: (input: TInput, context: ChainContext) => boolean | Promise<boolean>;
}

export interface ChainContext {
  /** Results from previous steps */
  results: Map<string, unknown>;
  /** Shared data between steps */
  shared: Record<string, unknown>;
  /** Current step index */
  currentStepIndex: number;
  /** Total steps count */
  totalSteps: number;
  /** Chain start time */
  startTime: Date;
  /** Abort signal */
  abortSignal?: AbortSignal;
}

export interface ChainStepResult<T = unknown> {
  /** Step ID */
  stepId: string;
  /** Step name */
  stepName: string;
  /** Whether step succeeded */
  success: boolean;
  /** Step output */
  output?: T;
  /** Error if failed */
  error?: Error;
  /** Execution time in ms */
  durationMs: number;
  /** Whether step was skipped */
  skipped: boolean;
  /** Number of retry attempts */
  retryAttempts: number;
}

export interface ChainResult<T = unknown> {
  /** Whether the entire chain succeeded */
  success: boolean;
  /** Final output */
  output?: T;
  /** Results from each step */
  stepResults: ChainStepResult[];
  /** Total execution time in ms */
  totalDurationMs: number;
  /** Number of successful steps */
  successfulSteps: number;
  /** Number of failed steps */
  failedSteps: number;
  /** Number of skipped steps */
  skippedSteps: number;
  /** Context at end of chain */
  context: ChainContext;
}

export interface ChainConfig {
  /** Stop chain on first error (default: true) */
  stopOnError: boolean;
  /** Default timeout for steps in ms (default: 30000) */
  defaultTimeoutMs: number;
  /** Default retry config */
  defaultRetry?: {
    maxAttempts: number;
    delayMs: number;
    backoff?: 'linear' | 'exponential';
  };
  /** Hook called before each step */
  beforeStep?: (step: ChainStep, context: ChainContext) => void | Promise<void>;
  /** Hook called after each step */
  afterStep?: (step: ChainStep, result: ChainStepResult, context: ChainContext) => void | Promise<void>;
  /** Hook called on step error */
  onStepError?: (step: ChainStep, error: Error, context: ChainContext) => void | Promise<void>;
}

/**
 * Prompt Chain - Sequential task execution with dependencies
 */
export class PromptChain<TInput = unknown, TOutput = unknown> {
  private steps: ChainStep[] = [];
  private config: ChainConfig;

  constructor(config?: Partial<ChainConfig>) {
    this.config = {
      stopOnError: config?.stopOnError ?? true,
      defaultTimeoutMs: config?.defaultTimeoutMs ?? 30000,
      defaultRetry: config?.defaultRetry,
      beforeStep: config?.beforeStep,
      afterStep: config?.afterStep,
      onStepError: config?.onStepError,
    };
  }

  /**
   * Add a step to the chain
   */
  addStep<TStepInput = unknown, TStepOutput = unknown>(
    step: ChainStep<TStepInput, TStepOutput>
  ): this {
    this.steps.push(step as ChainStep);
    return this;
  }

  /**
   * Add multiple steps
   */
  addSteps(steps: ChainStep[]): this {
    for (const step of steps) {
      this.addStep(step);
    }
    return this;
  }

  /**
   * Get all steps
   */
  getSteps(): ChainStep[] {
    return [...this.steps];
  }

  /**
   * Execute the chain
   */
  async execute(
    input: TInput,
    options?: {
      shared?: Record<string, unknown>;
      abortSignal?: AbortSignal;
    }
  ): Promise<ChainResult<TOutput>> {
    const startTime = Date.now();
    const context: ChainContext = {
      results: new Map(),
      shared: options?.shared ?? {},
      currentStepIndex: 0,
      totalSteps: this.steps.length,
      startTime: new Date(),
      abortSignal: options?.abortSignal,
    };

    const stepResults: ChainStepResult[] = [];
    let currentInput: unknown = input;
    let success = true;

    for (let i = 0; i < this.steps.length; i++) {
      // Check abort signal
      if (options?.abortSignal?.aborted) {
        success = false;
        break;
      }

      const step = this.steps[i];
      context.currentStepIndex = i;

      const stepResult = await this.executeStep(step, currentInput, context);
      stepResults.push(stepResult);

      if (stepResult.success && !stepResult.skipped) {
        context.results.set(step.id, stepResult.output);

        // Transform output for next step
        if (step.transformOutput) {
          currentInput = step.transformOutput(stepResult.output);
        } else {
          currentInput = stepResult.output;
        }
      } else if (!stepResult.success) {
        success = false;
        if (this.config.stopOnError && !step.continueOnError) {
          break;
        }
      }
    }

    return {
      success,
      output: success ? (currentInput as TOutput) : undefined,
      stepResults,
      totalDurationMs: Date.now() - startTime,
      successfulSteps: stepResults.filter((r) => r.success && !r.skipped).length,
      failedSteps: stepResults.filter((r) => !r.success).length,
      skippedSteps: stepResults.filter((r) => r.skipped).length,
      context,
    };
  }

  /**
   * Execute a single step with retry and timeout
   */
  private async executeStep(
    step: ChainStep,
    input: unknown,
    context: ChainContext
  ): Promise<ChainStepResult> {
    const startTime = Date.now();
    let retryAttempts = 0;

    // Check skip condition
    if (step.skipIf) {
      const shouldSkip = await step.skipIf(input, context);
      if (shouldSkip) {
        return {
          stepId: step.id,
          stepName: step.name,
          success: true,
          skipped: true,
          durationMs: Date.now() - startTime,
          retryAttempts: 0,
        };
      }
    }

    // Validate input
    if (step.validateInput) {
      const isValid = await step.validateInput(input);
      if (!isValid) {
        const error = new Error(`Input validation failed for step: ${step.name}`);
        await this.config.onStepError?.(step, error, context);
        return {
          stepId: step.id,
          stepName: step.name,
          success: false,
          error,
          skipped: false,
          durationMs: Date.now() - startTime,
          retryAttempts: 0,
        };
      }
    }

    // Call before hook
    await this.config.beforeStep?.(step, context);

    const retry = step.retry ?? this.config.defaultRetry;
    const maxAttempts = retry?.maxAttempts ?? 1;
    const timeoutMs = step.timeoutMs ?? this.config.defaultTimeoutMs;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      retryAttempts = attempt;

      try {
        // Execute with timeout
        const output = await this.executeWithTimeout(
          () => step.execute(input, context),
          timeoutMs,
          step.name
        );

        const result: ChainStepResult = {
          stepId: step.id,
          stepName: step.name,
          success: true,
          output,
          skipped: false,
          durationMs: Date.now() - startTime,
          retryAttempts,
        };

        // Call after hook
        await this.config.afterStep?.(step, result, context);

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check abort signal
        if (context.abortSignal?.aborted) {
          break;
        }

        // Wait before retry
        if (attempt < maxAttempts - 1 && retry) {
          const delay = this.calculateRetryDelay(retry, attempt);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    // All attempts failed
    await this.config.onStepError?.(step, lastError!, context);

    const result: ChainStepResult = {
      stepId: step.id,
      stepName: step.name,
      success: false,
      error: lastError!,
      skipped: false,
      durationMs: Date.now() - startTime,
      retryAttempts,
    };

    await this.config.afterStep?.(step, result, context);

    return result;
  }

  /**
   * Execute with timeout
   */
  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    stepName: string
  ): Promise<T> {
    if (timeoutMs === 0) {
      return fn();
    }

    return Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Step "${stepName}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  }

  /**
   * Calculate retry delay with backoff
   */
  private calculateRetryDelay(
    retry: NonNullable<ChainStep['retry']>,
    attempt: number
  ): number {
    if (retry.backoff === 'exponential') {
      return retry.delayMs * Math.pow(2, attempt);
    }
    // Linear backoff
    return retry.delayMs * (attempt + 1);
  }
}

/**
 * Create a prompt chain
 */
export function createChain<TInput = unknown, TOutput = unknown>(
  config?: Partial<ChainConfig>
): PromptChain<TInput, TOutput> {
  return new PromptChain<TInput, TOutput>(config);
}

/**
 * Create a simple step
 */
export function createStep<TInput = unknown, TOutput = unknown>(
  id: string,
  name: string,
  execute: (input: TInput, context: ChainContext) => Promise<TOutput>,
  options?: Partial<Omit<ChainStep<TInput, TOutput>, 'id' | 'name' | 'execute'>>
): ChainStep<TInput, TOutput> {
  return {
    id,
    name,
    execute,
    ...options,
  };
}

/**
 * Chain builder for fluent API
 */
export class ChainBuilder<TInput = unknown, TOutput = unknown> {
  private chain: PromptChain<TInput, TOutput>;

  constructor(config?: Partial<ChainConfig>) {
    this.chain = new PromptChain<TInput, TOutput>(config);
  }

  /**
   * Add a step using fluent API
   */
  step<TStepInput = TInput, TStepOutput = unknown>(
    id: string,
    name: string,
    execute: (input: TStepInput, context: ChainContext) => Promise<TStepOutput>,
    options?: Partial<Omit<ChainStep<TStepInput, TStepOutput>, 'id' | 'name' | 'execute'>>
  ): ChainBuilder<TInput, TStepOutput> {
    this.chain.addStep(createStep(id, name, execute, options));
    return this as unknown as ChainBuilder<TInput, TStepOutput>;
  }

  /**
   * Build and return the chain
   */
  build(): PromptChain<TInput, TOutput> {
    return this.chain;
  }

  /**
   * Execute the chain directly
   */
  async execute(
    input: TInput,
    options?: {
      shared?: Record<string, unknown>;
      abortSignal?: AbortSignal;
    }
  ): Promise<ChainResult<TOutput>> {
    return this.chain.execute(input, options);
  }
}

/**
 * Create a chain builder
 */
export function chainBuilder<TInput = unknown>(
  config?: Partial<ChainConfig>
): ChainBuilder<TInput, TInput> {
  return new ChainBuilder<TInput, TInput>(config);
}

/**
 * Utility: Parallel chain execution
 */
export async function executeParallel<T>(
  chains: Array<{ chain: PromptChain<unknown, T>; input: unknown }>,
  options?: { abortSignal?: AbortSignal }
): Promise<ChainResult<T>[]> {
  return Promise.all(
    chains.map(({ chain, input }) =>
      chain.execute(input, { abortSignal: options?.abortSignal })
    )
  );
}

/**
 * Utility: Conditional chain execution
 */
export async function executeConditional<TInput, TOutput>(
  input: TInput,
  condition: (input: TInput) => boolean | Promise<boolean>,
  ifChain: PromptChain<TInput, TOutput>,
  elseChain?: PromptChain<TInput, TOutput>
): Promise<ChainResult<TOutput> | null> {
  const shouldExecuteIf = await condition(input);

  if (shouldExecuteIf) {
    return ifChain.execute(input);
  } else if (elseChain) {
    return elseChain.execute(input);
  }

  return null;
}
