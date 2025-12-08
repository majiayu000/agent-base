import type { Agent } from '../core/agent.js';
import type { AgentResult } from '../core/types.js';

// ============================================================================
// Reflection Pattern - Self-evaluation and output optimization
// ============================================================================

export interface ReflectionConfig {
  /** Maximum reflection iterations (default: 3) */
  maxReflections: number;
  /** Minimum quality score to accept output (0-1, default: 0.7) */
  qualityThreshold: number;
  /** Custom evaluation prompt */
  evaluationPrompt?: string;
  /** Custom improvement prompt */
  improvementPrompt?: string;
}

export interface ReflectionResult {
  /** Final optimized response */
  response: string;
  /** Number of reflection iterations performed */
  reflectionCount: number;
  /** Quality scores from each iteration */
  qualityScores: number[];
  /** Original response before reflection */
  originalResponse: string;
  /** Whether quality threshold was met */
  thresholdMet: boolean;
  /** Total token usage across all iterations */
  totalUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface EvaluationResult {
  score: number;
  feedback: string;
  improvements: string[];
}

const DEFAULT_EVALUATION_PROMPT = `Evaluate the following response for quality, accuracy, and completeness.

Response to evaluate:
{response}

Original task:
{task}

Provide your evaluation in the following JSON format:
{
  "score": <number between 0 and 1>,
  "feedback": "<brief explanation of the score>",
  "improvements": ["<improvement 1>", "<improvement 2>", ...]
}

Only output the JSON, no other text.`;

const DEFAULT_IMPROVEMENT_PROMPT = `Improve the following response based on the feedback provided.

Original response:
{response}

Original task:
{task}

Feedback:
{feedback}

Suggested improvements:
{improvements}

Provide an improved response that addresses the feedback. Only output the improved response, no explanations.`;

/**
 * Reflection class - implements self-evaluation and iterative improvement
 */
export class Reflection {
  private config: ReflectionConfig;

  constructor(config?: Partial<ReflectionConfig>) {
    this.config = {
      maxReflections: config?.maxReflections ?? 3,
      qualityThreshold: config?.qualityThreshold ?? 0.7,
      evaluationPrompt: config?.evaluationPrompt,
      improvementPrompt: config?.improvementPrompt,
    };
  }

  /**
   * Run reflection loop on agent output
   */
  async reflect(
    agent: Agent,
    task: string,
    initialResponse: string,
    callbacks?: {
      onEvaluation?: (iteration: number, result: EvaluationResult) => void;
      onImprovement?: (iteration: number, response: string) => void;
    }
  ): Promise<ReflectionResult> {
    const result: ReflectionResult = {
      response: initialResponse,
      reflectionCount: 0,
      qualityScores: [],
      originalResponse: initialResponse,
      thresholdMet: false,
      totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };

    let currentResponse = initialResponse;

    for (let i = 0; i < this.config.maxReflections; i++) {
      // Step 1: Evaluate current response
      const evaluation = await this.evaluate(agent, task, currentResponse);
      result.qualityScores.push(evaluation.score);
      result.reflectionCount = i + 1;

      callbacks?.onEvaluation?.(i + 1, evaluation);

      // Check if quality threshold is met
      if (evaluation.score >= this.config.qualityThreshold) {
        result.thresholdMet = true;
        result.response = currentResponse;
        break;
      }

      // Step 2: Improve response based on feedback
      if (i < this.config.maxReflections - 1) {
        currentResponse = await this.improve(agent, task, currentResponse, evaluation);
        callbacks?.onImprovement?.(i + 1, currentResponse);
      }
    }

    result.response = currentResponse;
    return result;
  }

  /**
   * Evaluate a response
   */
  private async evaluate(agent: Agent, task: string, response: string): Promise<EvaluationResult> {
    const prompt = (this.config.evaluationPrompt || DEFAULT_EVALUATION_PROMPT)
      .replace('{response}', response)
      .replace('{task}', task);

    const result = await agent.run(prompt);

    try {
      // Parse JSON from response
      const jsonMatch = result.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          score: Math.max(0, Math.min(1, parsed.score || 0)),
          feedback: parsed.feedback || '',
          improvements: Array.isArray(parsed.improvements) ? parsed.improvements : [],
        };
      }
    } catch {
      // Fallback if parsing fails
    }

    return {
      score: 0.5,
      feedback: 'Could not parse evaluation',
      improvements: ['Please try again with clearer instructions'],
    };
  }

  /**
   * Improve a response based on feedback
   */
  private async improve(
    agent: Agent,
    task: string,
    response: string,
    evaluation: EvaluationResult
  ): Promise<string> {
    const prompt = (this.config.improvementPrompt || DEFAULT_IMPROVEMENT_PROMPT)
      .replace('{response}', response)
      .replace('{task}', task)
      .replace('{feedback}', evaluation.feedback)
      .replace('{improvements}', evaluation.improvements.join('\n- '));

    const result = await agent.run(prompt);
    return result.response;
  }
}

/**
 * Create a reflection instance
 */
export function createReflection(config?: Partial<ReflectionConfig>): Reflection {
  return new Reflection(config);
}

/**
 * Middleware that adds reflection capability to agent responses
 */
export function reflectionMiddleware(config?: Partial<ReflectionConfig>) {
  const reflection = new Reflection(config);

  return {
    name: 'reflection',
    // This middleware is meant to be used programmatically, not in the standard middleware chain
    reflect: reflection.reflect.bind(reflection),
  };
}
