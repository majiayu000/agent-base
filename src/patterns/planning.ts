import type { Agent } from '../core/agent.js';
import type { AgentResult } from '../core/types.js';

// ============================================================================
// Planning Pattern - Multi-step plan creation and execution
// ============================================================================

export interface PlanStep {
  /** Step number */
  step: number;
  /** Step description */
  description: string;
  /** Tool to use (optional) */
  tool?: string;
  /** Expected output */
  expectedOutput?: string;
  /** Dependencies on other steps */
  dependsOn?: number[];
  /** Step status */
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** Actual result after execution */
  result?: string;
  /** Error if failed */
  error?: string;
}

export interface Plan {
  /** Plan ID */
  id: string;
  /** Original task */
  task: string;
  /** Plan steps */
  steps: PlanStep[];
  /** Overall status */
  status: 'planning' | 'executing' | 'completed' | 'failed';
  /** Creation timestamp */
  createdAt: Date;
  /** Completion timestamp */
  completedAt?: Date;
}

export interface PlanningConfig {
  /** Maximum steps in a plan (default: 10) */
  maxSteps: number;
  /** Whether to allow plan revision during execution (default: true) */
  allowRevision: boolean;
  /** Custom planning prompt */
  planningPrompt?: string;
  /** Custom step execution prompt */
  executionPrompt?: string;
}

export interface PlanningResult {
  /** The executed plan */
  plan: Plan;
  /** Final response combining all step results */
  response: string;
  /** Total execution time in ms */
  executionTimeMs: number;
  /** Number of steps executed */
  stepsExecuted: number;
  /** Number of steps that failed */
  stepsFailed: number;
}

const DEFAULT_PLANNING_PROMPT = `You are a planning assistant. Create a detailed step-by-step plan to accomplish the following task.

Task: {task}

Create a plan with clear, actionable steps. Output your plan in the following JSON format:
{
  "steps": [
    {
      "step": 1,
      "description": "<what to do>",
      "tool": "<tool name if needed, or null>",
      "expectedOutput": "<what result is expected>",
      "dependsOn": [<step numbers this depends on>]
    }
  ]
}

Keep the plan focused and efficient. Maximum {maxSteps} steps.
Only output the JSON, no other text.`;

const DEFAULT_EXECUTION_PROMPT = `Execute the following step of the plan.

Overall task: {task}

Current step ({stepNumber}/{totalSteps}):
{stepDescription}

Previous step results:
{previousResults}

Execute this step and provide the result. Be concise and focused on completing just this step.`;

/**
 * Planner class - implements multi-step planning and execution
 */
export class Planner {
  private config: PlanningConfig;

  constructor(config?: Partial<PlanningConfig>) {
    this.config = {
      maxSteps: config?.maxSteps ?? 10,
      allowRevision: config?.allowRevision ?? true,
      planningPrompt: config?.planningPrompt,
      executionPrompt: config?.executionPrompt,
    };
  }

  /**
   * Create a plan for a task
   */
  async createPlan(agent: Agent, task: string): Promise<Plan> {
    const prompt = (this.config.planningPrompt || DEFAULT_PLANNING_PROMPT)
      .replace('{task}', task)
      .replace('{maxSteps}', String(this.config.maxSteps));

    const result = await agent.run(prompt);

    const plan: Plan = {
      id: crypto.randomUUID(),
      task,
      steps: [],
      status: 'planning',
      createdAt: new Date(),
    };

    try {
      const jsonMatch = result.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.steps)) {
          plan.steps = parsed.steps.slice(0, this.config.maxSteps).map((s: any, i: number) => ({
            step: s.step || i + 1,
            description: s.description || `Step ${i + 1}`,
            tool: s.tool || undefined,
            expectedOutput: s.expectedOutput || undefined,
            dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
            status: 'pending' as const,
          }));
        }
      }
    } catch {
      // If parsing fails, create a simple single-step plan
      plan.steps = [{
        step: 1,
        description: task,
        status: 'pending',
        dependsOn: [],
      }];
    }

    return plan;
  }

  /**
   * Execute a plan
   */
  async executePlan(
    agent: Agent,
    plan: Plan,
    callbacks?: {
      onStepStart?: (step: PlanStep) => void;
      onStepComplete?: (step: PlanStep) => void;
      onStepFailed?: (step: PlanStep, error: string) => void;
      onPlanRevised?: (plan: Plan) => void;
    }
  ): Promise<PlanningResult> {
    const startTime = Date.now();
    plan.status = 'executing';

    let stepsExecuted = 0;
    let stepsFailed = 0;
    const results: string[] = [];

    // Execute steps in order, respecting dependencies
    for (const step of plan.steps) {
      // Check if dependencies are met
      const dependenciesMet = step.dependsOn?.every(
        (depStep) => plan.steps.find((s) => s.step === depStep)?.status === 'completed'
      ) ?? true;

      if (!dependenciesMet) {
        step.status = 'failed';
        step.error = 'Dependencies not met';
        stepsFailed++;
        callbacks?.onStepFailed?.(step, step.error);
        continue;
      }

      step.status = 'in_progress';
      callbacks?.onStepStart?.(step);

      try {
        // Build context from previous results
        const previousResults = results
          .map((r, i) => `Step ${i + 1}: ${r}`)
          .join('\n') || 'None yet';

        const prompt = (this.config.executionPrompt || DEFAULT_EXECUTION_PROMPT)
          .replace('{task}', plan.task)
          .replace('{stepNumber}', String(step.step))
          .replace('{totalSteps}', String(plan.steps.length))
          .replace('{stepDescription}', step.description)
          .replace('{previousResults}', previousResults);

        const result = await agent.run(prompt);
        step.result = result.response;
        step.status = 'completed';
        stepsExecuted++;
        results.push(result.response);

        callbacks?.onStepComplete?.(step);
      } catch (error) {
        step.status = 'failed';
        step.error = error instanceof Error ? error.message : String(error);
        stepsFailed++;
        callbacks?.onStepFailed?.(step, step.error);

        // If revision is allowed and step failed, we could revise the plan
        // For now, we continue with remaining steps
      }
    }

    // Determine final plan status
    const allCompleted = plan.steps.every((s) => s.status === 'completed');
    const anyFailed = plan.steps.some((s) => s.status === 'failed');

    plan.status = allCompleted ? 'completed' : anyFailed ? 'failed' : 'completed';
    plan.completedAt = new Date();

    // Combine results into final response
    const response = results.length > 0
      ? results.join('\n\n---\n\n')
      : 'No steps were executed successfully.';

    return {
      plan,
      response,
      executionTimeMs: Date.now() - startTime,
      stepsExecuted,
      stepsFailed,
    };
  }

  /**
   * Create and execute a plan in one call
   */
  async planAndExecute(
    agent: Agent,
    task: string,
    callbacks?: {
      onPlanCreated?: (plan: Plan) => void;
      onStepStart?: (step: PlanStep) => void;
      onStepComplete?: (step: PlanStep) => void;
      onStepFailed?: (step: PlanStep, error: string) => void;
    }
  ): Promise<PlanningResult> {
    const plan = await this.createPlan(agent, task);
    callbacks?.onPlanCreated?.(plan);

    return this.executePlan(agent, plan, callbacks);
  }
}

/**
 * Create a planner instance
 */
export function createPlanner(config?: Partial<PlanningConfig>): Planner {
  return new Planner(config);
}
