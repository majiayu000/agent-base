/**
 * Example 3: Planning Pattern
 *
 * This example shows how to decompose complex tasks into
 * executable steps using the Planning pattern.
 */

import { createPlanner } from '../src/index.js';
import type { PlanStep } from '../src/index.js';

async function main() {
  // Create a planner
  const planner = createPlanner({
    // Custom step executor
    stepExecutor: async (step: PlanStep, context) => {
      console.log(`  Executing: ${step.action}`);

      // Simulate different actions
      switch (step.action) {
        case 'research':
          await sleep(100);
          return { findings: ['fact1', 'fact2', 'fact3'] };

        case 'analyze':
          await sleep(100);
          const prevFindings = context.results.get(step.dependencies?.[0] || '');
          return {
            analysis: `Analyzed ${(prevFindings as { findings: string[] })?.findings?.length || 0} findings`,
          };

        case 'summarize':
          await sleep(100);
          return { summary: 'Final summary of research and analysis' };

        default:
          return { result: `Completed ${step.action}` };
      }
    },
    maxConcurrentSteps: 2,
  });

  // Create a manual plan
  console.log('=== Manual Plan Execution ===\n');

  const plan = {
    id: 'research-plan',
    goal: 'Research and summarize a topic',
    steps: [
      {
        id: 'step-1',
        action: 'research',
        description: 'Gather initial information',
        status: 'pending' as const,
        priority: 1,
      },
      {
        id: 'step-2',
        action: 'analyze',
        description: 'Analyze the gathered information',
        status: 'pending' as const,
        priority: 2,
        dependencies: ['step-1'],
      },
      {
        id: 'step-3',
        action: 'summarize',
        description: 'Create final summary',
        status: 'pending' as const,
        priority: 3,
        dependencies: ['step-2'],
      },
    ],
    createdAt: new Date(),
    status: 'pending' as const,
  };

  console.log('Plan:', plan.goal);
  console.log('Steps:');
  plan.steps.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.description} (depends on: ${s.dependencies?.join(', ') || 'none'})`);
  });

  console.log('\nExecuting plan...\n');

  const result = await planner.executePlan(plan);

  console.log('\n--- Results ---');
  console.log('Success:', result.success);
  console.log('Completed steps:', result.completedSteps);
  console.log('Duration:', result.totalDurationMs, 'ms');

  console.log('\nStep results:');
  for (const [stepId, stepResult] of result.stepResults) {
    console.log(`  ${stepId}:`, stepResult);
  }

  // Example with LLM-generated plan (simulated)
  console.log('\n=== LLM-Generated Plan (Simulated) ===\n');

  const complexTask = 'Build a REST API for a todo application';
  console.log('Task:', complexTask);
  console.log('\nA real implementation would call an LLM to generate steps like:');
  console.log('  1. Design data models');
  console.log('  2. Set up Express server');
  console.log('  3. Create CRUD endpoints');
  console.log('  4. Add validation');
  console.log('  5. Write tests');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
