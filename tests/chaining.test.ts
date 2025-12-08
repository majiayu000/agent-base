import { describe, it, expect, beforeEach } from 'bun:test';
import {
  PromptChain,
  createChain,
  createStep,
  chainBuilder,
  executeParallel,
  executeConditional,
} from '../src/patterns/chaining.js';
import type { ChainContext, ChainStep } from '../src/patterns/chaining.js';

describe('Prompt Chaining Pattern', () => {
  describe('createChain', () => {
    it('should create chain with default config', () => {
      const chain = createChain();
      expect(chain).toBeInstanceOf(PromptChain);
    });

    it('should create chain with custom config', () => {
      const chain = createChain({
        stopOnError: false,
        defaultTimeoutMs: 60000,
      });
      expect(chain).toBeInstanceOf(PromptChain);
    });
  });

  describe('createStep', () => {
    it('should create a step with required fields', () => {
      const step = createStep('test', 'Test Step', async (input) => input);
      expect(step.id).toBe('test');
      expect(step.name).toBe('Test Step');
    });

    it('should create a step with options', () => {
      const step = createStep(
        'test',
        'Test Step',
        async (input) => input,
        {
          description: 'A test step',
          timeoutMs: 5000,
          continueOnError: true,
        }
      );
      expect(step.description).toBe('A test step');
      expect(step.timeoutMs).toBe(5000);
      expect(step.continueOnError).toBe(true);
    });
  });

  describe('addStep/addSteps', () => {
    it('should add steps to chain', () => {
      const chain = createChain();
      chain.addStep(createStep('s1', 'Step 1', async (x) => x));
      chain.addStep(createStep('s2', 'Step 2', async (x) => x));
      expect(chain.getSteps()).toHaveLength(2);
    });

    it('should support chaining', () => {
      const chain = createChain()
        .addStep(createStep('s1', 'Step 1', async (x) => x))
        .addStep(createStep('s2', 'Step 2', async (x) => x));
      expect(chain.getSteps()).toHaveLength(2);
    });

    it('should add multiple steps at once', () => {
      const chain = createChain();
      chain.addSteps([
        createStep('s1', 'Step 1', async (x) => x),
        createStep('s2', 'Step 2', async (x) => x),
        createStep('s3', 'Step 3', async (x) => x),
      ]);
      expect(chain.getSteps()).toHaveLength(3);
    });
  });

  describe('execute - basic', () => {
    it('should execute a simple chain', async () => {
      const chain = createChain<number, number>()
        .addStep(createStep('double', 'Double', async (x: number) => x * 2))
        .addStep(createStep('add10', 'Add 10', async (x: number) => x + 10));

      const result = await chain.execute(5);

      expect(result.success).toBe(true);
      expect(result.output).toBe(20); // (5 * 2) + 10
      expect(result.stepResults).toHaveLength(2);
      expect(result.successfulSteps).toBe(2);
    });

    it('should pass data between steps', async () => {
      const chain = createChain<string, string[]>()
        .addStep(createStep('split', 'Split', async (s: string) => s.split(',')))
        .addStep(createStep('trim', 'Trim', async (arr: string[]) => arr.map((s) => s.trim())))
        .addStep(createStep('upper', 'Upper', async (arr: string[]) => arr.map((s) => s.toUpperCase())));

      const result = await chain.execute('hello, world, test');

      expect(result.success).toBe(true);
      expect(result.output).toEqual(['HELLO', 'WORLD', 'TEST']);
    });

    it('should store results in context', async () => {
      let capturedContext: ChainContext | null = null;

      const chain = createChain<number, number>()
        .addStep(createStep('s1', 'Step 1', async (x: number) => x + 1))
        .addStep(createStep('s2', 'Step 2', async (x: number, ctx) => {
          capturedContext = ctx;
          return x + 2;
        }));

      await chain.execute(10);

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.results.get('s1')).toBe(11);
    });
  });

  describe('execute - error handling', () => {
    it('should stop on error by default', async () => {
      const chain = createChain<number, number>()
        .addStep(createStep('s1', 'Step 1', async (x: number) => x + 1))
        .addStep(createStep('fail', 'Fail', async () => {
          throw new Error('Step failed');
        }))
        .addStep(createStep('s3', 'Step 3', async (x: number) => x + 3));

      const result = await chain.execute(1);

      expect(result.success).toBe(false);
      expect(result.stepResults).toHaveLength(2);
      expect(result.failedSteps).toBe(1);
    });

    it('should continue on error when configured', async () => {
      const chain = createChain<number, number>({ stopOnError: false })
        .addStep(createStep('s1', 'Step 1', async (x: number) => x + 1))
        .addStep(createStep('fail', 'Fail', async () => {
          throw new Error('Step failed');
        }))
        .addStep(createStep('s3', 'Step 3', async (x: number) => x + 3));

      const result = await chain.execute(1);

      expect(result.success).toBe(false);
      expect(result.stepResults).toHaveLength(3);
    });

    it('should respect continueOnError on step level', async () => {
      const chain = createChain<number, number>()
        .addStep(createStep('s1', 'Step 1', async (x: number) => x + 1))
        .addStep(createStep('fail', 'Fail', async () => {
          throw new Error('Step failed');
        }, { continueOnError: true }))
        .addStep(createStep('s3', 'Step 3', async (x: number) => x + 3));

      const result = await chain.execute(1);

      expect(result.success).toBe(false);
      expect(result.stepResults).toHaveLength(3);
      expect(result.failedSteps).toBe(1);
    });
  });

  describe('execute - skip condition', () => {
    it('should skip step when skipIf returns true', async () => {
      const chain = createChain<number, number>()
        .addStep(createStep('s1', 'Step 1', async (x: number) => x + 1))
        .addStep(createStep('maybe', 'Maybe Skip', async (x: number) => x * 10, {
          skipIf: async (x: number) => x > 5,
        }))
        .addStep(createStep('s3', 'Step 3', async (x: number) => x + 1));

      const result = await chain.execute(10);

      expect(result.success).toBe(true);
      expect(result.skippedSteps).toBe(1);
      expect(result.output).toBe(12); // 10 + 1 + 1 (skip x*10)
    });

    it('should not skip step when skipIf returns false', async () => {
      const chain = createChain<number, number>()
        .addStep(createStep('maybe', 'Maybe Skip', async (x: number) => x * 10, {
          skipIf: async (x: number) => x > 100,
        }));

      const result = await chain.execute(5);

      expect(result.skippedSteps).toBe(0);
      expect(result.output).toBe(50);
    });
  });

  describe('execute - validation', () => {
    it('should validate input before execution', async () => {
      const chain = createChain<number, number>()
        .addStep(createStep('validated', 'Validated', async (x: number) => x * 2, {
          validateInput: (x: number) => x > 0,
        }));

      const result = await chain.execute(-5);

      expect(result.success).toBe(false);
      expect(result.stepResults[0].error?.message).toContain('validation failed');
    });

    it('should pass validation and execute', async () => {
      const chain = createChain<number, number>()
        .addStep(createStep('validated', 'Validated', async (x: number) => x * 2, {
          validateInput: (x: number) => x > 0,
        }));

      const result = await chain.execute(5);

      expect(result.success).toBe(true);
      expect(result.output).toBe(10);
    });
  });

  describe('execute - timeout', () => {
    it('should timeout slow step', async () => {
      const chain = createChain<number, number>()
        .addStep(createStep('slow', 'Slow Step', async (x: number) => {
          await new Promise((r) => setTimeout(r, 200));
          return x;
        }, { timeoutMs: 50 }));

      const result = await chain.execute(1);

      expect(result.success).toBe(false);
      expect(result.stepResults[0].error?.message).toContain('timed out');
    });

    it('should not timeout fast step', async () => {
      const chain = createChain<number, number>()
        .addStep(createStep('fast', 'Fast Step', async (x: number) => {
          await new Promise((r) => setTimeout(r, 10));
          return x * 2;
        }, { timeoutMs: 1000 }));

      const result = await chain.execute(5);

      expect(result.success).toBe(true);
      expect(result.output).toBe(10);
    });
  });

  describe('execute - retry', () => {
    it('should retry failed step', async () => {
      let attempts = 0;

      const chain = createChain<number, number>()
        .addStep(createStep('retry', 'Retry Step', async (x: number) => {
          attempts++;
          if (attempts < 3) {
            throw new Error('Not yet');
          }
          return x * 2;
        }, { retry: { maxAttempts: 3, delayMs: 10 } }));

      const result = await chain.execute(5);

      expect(result.success).toBe(true);
      expect(result.output).toBe(10);
      expect(result.stepResults[0].retryAttempts).toBe(2);
    });

    it('should fail after max retries', async () => {
      let attempts = 0;

      const chain = createChain<number, number>()
        .addStep(createStep('fail', 'Always Fail', async () => {
          attempts++;
          throw new Error('Always fails');
        }, { retry: { maxAttempts: 3, delayMs: 10 } }));

      const result = await chain.execute(5);

      expect(result.success).toBe(false);
      expect(attempts).toBe(3);
    });

    it('should use exponential backoff', async () => {
      const startTime = Date.now();
      let attempts = 0;

      const chain = createChain<number, number>()
        .addStep(createStep('exp', 'Exponential', async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error('Not yet');
          }
          return 1;
        }, { retry: { maxAttempts: 3, delayMs: 20, backoff: 'exponential' } }));

      await chain.execute(1);

      const elapsed = Date.now() - startTime;
      // 20ms + 40ms = 60ms minimum delay
      expect(elapsed).toBeGreaterThanOrEqual(50);
    });
  });

  describe('execute - hooks', () => {
    it('should call beforeStep hook', async () => {
      const beforeCalls: string[] = [];

      const chain = createChain<number, number>({
        beforeStep: async (step) => {
          beforeCalls.push(step.id);
        },
      })
        .addStep(createStep('s1', 'Step 1', async (x: number) => x + 1))
        .addStep(createStep('s2', 'Step 2', async (x: number) => x + 2));

      await chain.execute(0);

      expect(beforeCalls).toEqual(['s1', 's2']);
    });

    it('should call afterStep hook', async () => {
      const afterCalls: { id: string; success: boolean }[] = [];

      const chain = createChain<number, number>({
        afterStep: async (step, result) => {
          afterCalls.push({ id: step.id, success: result.success });
        },
      })
        .addStep(createStep('s1', 'Step 1', async (x: number) => x + 1))
        .addStep(createStep('s2', 'Step 2', async (x: number) => x + 2));

      await chain.execute(0);

      expect(afterCalls).toEqual([
        { id: 's1', success: true },
        { id: 's2', success: true },
      ]);
    });

    it('should call onStepError hook', async () => {
      const errors: { id: string; message: string }[] = [];

      const chain = createChain<number, number>({
        onStepError: async (step, error) => {
          errors.push({ id: step.id, message: error.message });
        },
      })
        .addStep(createStep('fail', 'Fail', async () => {
          throw new Error('Test error');
        }));

      await chain.execute(0);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Test error');
    });
  });

  describe('execute - transform output', () => {
    it('should transform output before passing to next step', async () => {
      const chain = createChain<number, number>()
        .addStep(createStep('s1', 'Step 1', async (x: number) => x * 2, {
          transformOutput: (x: number) => x + 100,
        }))
        .addStep(createStep('s2', 'Step 2', async (x: number) => x + 1));

      const result = await chain.execute(5);

      // 5 * 2 = 10, transform to 110, then 110 + 1 = 111
      expect(result.output).toBe(111);
    });
  });

  describe('execute - abort signal', () => {
    it('should stop on abort signal', async () => {
      const controller = new AbortController();

      const chain = createChain<number, number>()
        .addStep(createStep('s1', 'Step 1', async (x: number) => {
          controller.abort();
          return x + 1;
        }))
        .addStep(createStep('s2', 'Step 2', async (x: number) => x + 2));

      const result = await chain.execute(0, { abortSignal: controller.signal });

      expect(result.success).toBe(false);
      expect(result.stepResults).toHaveLength(1);
    });
  });

  describe('execute - shared context', () => {
    it('should provide shared context between steps', async () => {
      const chain = createChain<number, number>()
        .addStep(createStep('s1', 'Step 1', async (x: number, ctx) => {
          ctx.shared['multiplier'] = 3;
          return x;
        }))
        .addStep(createStep('s2', 'Step 2', async (x: number, ctx) => {
          return x * (ctx.shared['multiplier'] as number);
        }));

      const result = await chain.execute(5);

      expect(result.output).toBe(15);
    });

    it('should accept initial shared data', async () => {
      const chain = createChain<number, number>()
        .addStep(createStep('s1', 'Step 1', async (x: number, ctx) => {
          return x + (ctx.shared['offset'] as number);
        }));

      const result = await chain.execute(5, { shared: { offset: 100 } });

      expect(result.output).toBe(105);
    });
  });

  describe('chainBuilder', () => {
    it('should build chain using fluent API', async () => {
      const result = await chainBuilder<number>()
        .step('double', 'Double', async (x: number) => x * 2)
        .step('add5', 'Add 5', async (x: number) => x + 5)
        .execute(10);

      expect(result.success).toBe(true);
      expect(result.output).toBe(25);
    });

    it('should build and return chain', () => {
      const chain = chainBuilder<string>()
        .step('upper', 'Upper', async (s: string) => s.toUpperCase())
        .build();

      expect(chain).toBeInstanceOf(PromptChain);
      expect(chain.getSteps()).toHaveLength(1);
    });
  });

  describe('executeParallel', () => {
    it('should execute multiple chains in parallel', async () => {
      const chain1 = createChain<number, number>()
        .addStep(createStep('x2', 'Double', async (x: number) => x * 2));

      const chain2 = createChain<number, number>()
        .addStep(createStep('x3', 'Triple', async (x: number) => x * 3));

      const results = await executeParallel([
        { chain: chain1, input: 5 },
        { chain: chain2, input: 5 },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].output).toBe(10);
      expect(results[1].output).toBe(15);
    });
  });

  describe('executeConditional', () => {
    it('should execute ifChain when condition is true', async () => {
      const ifChain = createChain<number, number>()
        .addStep(createStep('double', 'Double', async (x: number) => x * 2));

      const elseChain = createChain<number, number>()
        .addStep(createStep('triple', 'Triple', async (x: number) => x * 3));

      const result = await executeConditional(
        5,
        (x) => x > 0,
        ifChain,
        elseChain
      );

      expect(result?.output).toBe(10);
    });

    it('should execute elseChain when condition is false', async () => {
      const ifChain = createChain<number, number>()
        .addStep(createStep('double', 'Double', async (x: number) => x * 2));

      const elseChain = createChain<number, number>()
        .addStep(createStep('triple', 'Triple', async (x: number) => x * 3));

      const result = await executeConditional(
        -5,
        (x) => x > 0,
        ifChain,
        elseChain
      );

      expect(result?.output).toBe(-15);
    });

    it('should return null when no elseChain and condition is false', async () => {
      const ifChain = createChain<number, number>()
        .addStep(createStep('double', 'Double', async (x: number) => x * 2));

      const result = await executeConditional(
        -5,
        (x) => x > 0,
        ifChain
      );

      expect(result).toBeNull();
    });
  });

  describe('timing and statistics', () => {
    it('should track execution time', async () => {
      const chain = createChain<number, number>()
        .addStep(createStep('slow', 'Slow', async (x: number) => {
          await new Promise((r) => setTimeout(r, 50));
          return x;
        }));

      const result = await chain.execute(1);

      expect(result.totalDurationMs).toBeGreaterThanOrEqual(40);
      expect(result.stepResults[0].durationMs).toBeGreaterThanOrEqual(40);
    });

    it('should provide step statistics', async () => {
      const chain = createChain<number, number>({ stopOnError: false })
        .addStep(createStep('s1', 'Success', async (x: number) => x + 1))
        .addStep(createStep('s2', 'Skip', async (x: number) => x, {
          skipIf: () => true,
        }))
        .addStep(createStep('s3', 'Fail', async () => {
          throw new Error('fail');
        }));

      const result = await chain.execute(1);

      expect(result.successfulSteps).toBe(1);
      expect(result.skippedSteps).toBe(1);
      expect(result.failedSteps).toBe(1);
    });
  });
});
