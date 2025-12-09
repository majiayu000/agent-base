/**
 * Example 8: Prompt Chaining Pattern
 *
 * This example demonstrates sequential task execution
 * with data transformation using the Chaining pattern.
 */

import { createChain, createStep, chainBuilder, executeParallel, executeConditional } from '../src/index.js';

async function main() {
  console.log('=== Basic Chain ===\n');

  // Create a simple data processing chain
  const processChain = createChain<string, string[]>()
    .addStep(
      createStep('fetch', 'Fetch Data', async (input: string) => {
        console.log(`  Fetching data for: ${input}`);
        // Simulated data fetch
        return ['apple', 'banana', 'cherry', input];
      })
    )
    .addStep(
      createStep('filter', 'Filter Data', async (data: string[]) => {
        console.log(`  Filtering ${data.length} items`);
        return data.filter((item) => item.length > 4);
      })
    )
    .addStep(
      createStep('transform', 'Transform Data', async (data: string[]) => {
        console.log(`  Transforming ${data.length} items`);
        return data.map((item) => item.toUpperCase());
      })
    );

  console.log('Executing chain...');
  const result = await processChain.execute('orange');

  console.log('\nResult:', result.output);
  console.log('Success:', result.success);
  console.log('Steps completed:', result.successfulSteps);
  console.log('Duration:', result.totalDurationMs, 'ms');

  console.log('\n=== Chain with Validation & Skip ===\n');

  const validatedChain = createChain<number, number>()
    .addStep(
      createStep(
        'validate',
        'Validate Input',
        async (n: number) => {
          console.log(`  Validating: ${n}`);
          return n;
        },
        {
          validateInput: (n: number) => n > 0,
        }
      )
    )
    .addStep(
      createStep(
        'double',
        'Double Value',
        async (n: number) => {
          console.log(`  Doubling: ${n}`);
          return n * 2;
        },
        {
          skipIf: (n: number) => n > 100, // Skip if input > 100
        }
      )
    )
    .addStep(
      createStep('add10', 'Add 10', async (n: number) => {
        console.log(`  Adding 10 to: ${n}`);
        return n + 10;
      })
    );

  // Test with valid input
  console.log('Test with 5:');
  const validResult = await validatedChain.execute(5);
  console.log(`  Result: ${validResult.output}`); // 5 * 2 + 10 = 20

  // Test with large input (skip double)
  console.log('\nTest with 150 (skip double):');
  const skipResult = await validatedChain.execute(150);
  console.log(`  Result: ${skipResult.output}`); // 150 + 10 = 160
  console.log(`  Skipped steps: ${skipResult.skippedSteps}`);

  // Test with invalid input
  console.log('\nTest with -5 (validation fail):');
  const invalidResult = await validatedChain.execute(-5);
  console.log(`  Success: ${invalidResult.success}`);
  console.log(`  Error: ${invalidResult.stepResults[0].error?.message}`);

  console.log('\n=== Chain with Retry ===\n');

  let attemptCount = 0;
  const retryChain = createChain<number, number>().addStep(
    createStep(
      'flaky',
      'Flaky Operation',
      async (n: number) => {
        attemptCount++;
        console.log(`  Attempt ${attemptCount}...`);
        if (attemptCount < 3) {
          throw new Error('Temporary failure');
        }
        return n * 2;
      },
      {
        retry: { maxAttempts: 3, delayMs: 100, backoff: 'exponential' },
      }
    )
  );

  const retryResult = await retryChain.execute(5);
  console.log(`Success after ${retryResult.stepResults[0].retryAttempts + 1} attempts`);
  console.log(`Result: ${retryResult.output}`);

  console.log('\n=== Fluent Chain Builder ===\n');

  const fluentResult = await chainBuilder<string>()
    .step('split', 'Split String', async (s: string) => s.split(','))
    .step('trim', 'Trim Items', async (arr: string[]) => arr.map((s) => s.trim()))
    .step('filter', 'Filter Empty', async (arr: string[]) => arr.filter((s) => s.length > 0))
    .step('join', 'Join Back', async (arr: string[]) => arr.join(' | '))
    .execute('  hello , world ,  , test  ');

  console.log('Input: "  hello , world ,  , test  "');
  console.log('Output:', fluentResult.output);

  console.log('\n=== Parallel Chains ===\n');

  const mathChain = createChain<number, number>().addStep(
    createStep('compute', 'Compute', async (n: number) => {
      await sleep(100);
      return n * n;
    })
  );

  const textChain = createChain<string, number>().addStep(
    createStep('length', 'Get Length', async (s: string) => {
      await sleep(100);
      return s.length;
    })
  );

  console.log('Running chains in parallel...');
  const startTime = Date.now();

  const parallelResults = await executeParallel([
    { chain: mathChain, input: 5 },
    { chain: mathChain, input: 10 },
    { chain: textChain as any, input: 'hello world' },
  ]);

  console.log(`Completed in ${Date.now() - startTime}ms (should be ~100ms, not 300ms)`);
  console.log('Results:', parallelResults.map((r) => r.output));

  console.log('\n=== Conditional Chains ===\n');

  const positiveChain = createChain<number, string>().addStep(
    createStep('positive', 'Handle Positive', async (n: number) => `${n} is positive`)
  );

  const negativeChain = createChain<number, string>().addStep(
    createStep('negative', 'Handle Negative', async (n: number) => `${n} is negative`)
  );

  for (const n of [5, -3, 0]) {
    const condResult = await executeConditional(n, (x) => x > 0, positiveChain, negativeChain);
    console.log(`Input ${n}: ${condResult?.output || 'No chain executed'}`);
  }

  console.log('\n=== Chain with Shared Context ===\n');

  const contextChain = createChain<number, number>()
    .addStep(
      createStep('init', 'Initialize', async (n: number, ctx) => {
        ctx.shared['multiplier'] = 3;
        ctx.shared['offset'] = 100;
        return n;
      })
    )
    .addStep(
      createStep('multiply', 'Multiply', async (n: number, ctx) => {
        return n * (ctx.shared['multiplier'] as number);
      })
    )
    .addStep(
      createStep('offset', 'Add Offset', async (n: number, ctx) => {
        return n + (ctx.shared['offset'] as number);
      })
    );

  const contextResult = await contextChain.execute(5);
  console.log('Input: 5');
  console.log('Operation: (5 * 3) + 100 = 115');
  console.log('Result:', contextResult.output);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
