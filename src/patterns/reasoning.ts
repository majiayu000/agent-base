// ============================================================================
// Reasoning Techniques Pattern - Enhanced decision-making capabilities
// ============================================================================

export interface ReasoningStep {
  /** Step number */
  step: number;
  /** Step type */
  type: 'thought' | 'action' | 'observation' | 'reflection' | 'conclusion';
  /** Step content */
  content: string;
  /** Confidence level (0-1) */
  confidence?: number;
  /** Timestamp */
  timestamp: Date;
}

export interface ReasoningResult {
  /** Final answer/conclusion */
  answer: string;
  /** Reasoning steps */
  steps: ReasoningStep[];
  /** Overall confidence */
  confidence: number;
  /** Reasoning method used */
  method: string;
  /** Total reasoning time in ms */
  durationMs: number;
  /** Token usage (if applicable) */
  tokenUsage?: { input: number; output: number };
}

export interface ReasoningConfig {
  /** Maximum reasoning steps (default: 10) */
  maxSteps: number;
  /** Minimum confidence to accept answer (default: 0.7) */
  minConfidence: number;
  /** Enable verbose logging */
  verbose: boolean;
  /** Step callback */
  onStep?: (step: ReasoningStep) => void;
}

/**
 * Chain of Thought (CoT) Reasoner
 * Breaks down complex problems into step-by-step reasoning
 */
export class ChainOfThought {
  private config: ReasoningConfig;

  constructor(config?: Partial<ReasoningConfig>) {
    this.config = {
      maxSteps: config?.maxSteps ?? 10,
      minConfidence: config?.minConfidence ?? 0.7,
      verbose: config?.verbose ?? false,
      onStep: config?.onStep,
    };
  }

  /**
   * Generate a CoT prompt
   */
  generatePrompt(question: string, context?: string): string {
    let prompt = `Let's think through this step by step.

Question: ${question}
`;

    if (context) {
      prompt += `\nContext: ${context}\n`;
    }

    prompt += `
Please break down your reasoning:
1. First, understand what is being asked
2. Identify the key information
3. Work through the logic step by step
4. Arrive at a conclusion
5. Verify your answer

Show your complete reasoning process, then provide your final answer.`;

    return prompt;
  }

  /**
   * Parse reasoning steps from text
   */
  parseSteps(text: string): ReasoningStep[] {
    const steps: ReasoningStep[] = [];
    const lines = text.split('\n').filter((l) => l.trim());

    let stepNum = 0;
    for (const line of lines) {
      stepNum++;

      // Determine step type based on content
      let type: ReasoningStep['type'] = 'thought';
      const lowerLine = line.toLowerCase();

      if (lowerLine.includes('therefore') || lowerLine.includes('conclusion') || lowerLine.includes('answer')) {
        type = 'conclusion';
      } else if (lowerLine.includes('observe') || lowerLine.includes('notice') || lowerLine.includes('see that')) {
        type = 'observation';
      } else if (lowerLine.includes('let me') || lowerLine.includes('i will') || lowerLine.includes('step')) {
        type = 'action';
      } else if (lowerLine.includes('checking') || lowerLine.includes('verify') || lowerLine.includes('reconsider')) {
        type = 'reflection';
      }

      const step: ReasoningStep = {
        step: stepNum,
        type,
        content: line.trim(),
        timestamp: new Date(),
      };

      steps.push(step);
      this.config.onStep?.(step);
    }

    return steps;
  }

  /**
   * Calculate confidence from steps
   */
  calculateConfidence(steps: ReasoningStep[]): number {
    if (steps.length === 0) return 0;

    // Factors that increase confidence
    let confidence = 0.5;

    // Has conclusion
    if (steps.some((s) => s.type === 'conclusion')) {
      confidence += 0.2;
    }

    // Has verification/reflection
    if (steps.some((s) => s.type === 'reflection')) {
      confidence += 0.1;
    }

    // Reasonable number of steps
    if (steps.length >= 3 && steps.length <= 8) {
      confidence += 0.1;
    }

    // Has observations
    if (steps.some((s) => s.type === 'observation')) {
      confidence += 0.1;
    }

    return Math.min(1, confidence);
  }

  /**
   * Process CoT reasoning (simulated - would normally use LLM)
   */
  async reason(
    question: string,
    thinkingFn: (prompt: string) => Promise<string>,
    context?: string
  ): Promise<ReasoningResult> {
    const startTime = Date.now();

    const prompt = this.generatePrompt(question, context);
    const response = await thinkingFn(prompt);

    const steps = this.parseSteps(response);
    const confidence = this.calculateConfidence(steps);

    // Extract final answer (last conclusion or last step)
    const conclusionStep = steps.filter((s) => s.type === 'conclusion').pop();
    const answer = conclusionStep?.content || steps[steps.length - 1]?.content || response;

    return {
      answer,
      steps,
      confidence,
      method: 'chain-of-thought',
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Tree of Thought (ToT) Reasoner
 * Explores multiple reasoning paths and selects the best
 */
export class TreeOfThought {
  private config: ReasoningConfig;
  private branchingFactor: number;

  constructor(config?: Partial<ReasoningConfig> & { branchingFactor?: number }) {
    this.config = {
      maxSteps: config?.maxSteps ?? 5,
      minConfidence: config?.minConfidence ?? 0.7,
      verbose: config?.verbose ?? false,
      onStep: config?.onStep,
    };
    this.branchingFactor = config?.branchingFactor ?? 3;
  }

  /**
   * Generate alternative thoughts for a step
   */
  async generateBranches(
    question: string,
    currentPath: ReasoningStep[],
    generateFn: (prompt: string) => Promise<string>
  ): Promise<ReasoningStep[][]> {
    const branches: ReasoningStep[][] = [];

    const pathSummary = currentPath.map((s) => s.content).join('\n');

    for (let i = 0; i < this.branchingFactor; i++) {
      const prompt = `Question: ${question}

Current reasoning path:
${pathSummary}

Generate an alternative next step in reasoning (approach ${i + 1}):`;

      const response = await generateFn(prompt);

      const newStep: ReasoningStep = {
        step: currentPath.length + 1,
        type: 'thought',
        content: response.trim(),
        confidence: 0.5 + Math.random() * 0.3, // Simulated confidence
        timestamp: new Date(),
      };

      branches.push([...currentPath, newStep]);
    }

    return branches;
  }

  /**
   * Evaluate a reasoning path
   */
  evaluatePath(path: ReasoningStep[]): number {
    if (path.length === 0) return 0;

    let score = 0;

    // Length score
    if (path.length >= 2 && path.length <= this.config.maxSteps) {
      score += 0.3;
    }

    // Confidence scores
    const avgConfidence =
      path.reduce((sum, s) => sum + (s.confidence ?? 0.5), 0) / path.length;
    score += avgConfidence * 0.4;

    // Has conclusion
    if (path.some((s) => s.type === 'conclusion')) {
      score += 0.2;
    }

    // Coherence (simulated - would use LLM in practice)
    score += 0.1;

    return Math.min(1, score);
  }

  /**
   * Perform Tree of Thought reasoning
   */
  async reason(
    question: string,
    thinkingFn: (prompt: string) => Promise<string>,
    context?: string
  ): Promise<ReasoningResult> {
    const startTime = Date.now();

    // Initialize with root
    let paths: ReasoningStep[][] = [[]];

    // Expand tree
    for (let depth = 0; depth < this.config.maxSteps; depth++) {
      const newPaths: ReasoningStep[][] = [];

      for (const path of paths) {
        const branches = await this.generateBranches(question, path, thinkingFn);
        newPaths.push(...branches);
      }

      // Prune: keep top paths by score
      newPaths.sort((a, b) => this.evaluatePath(b) - this.evaluatePath(a));
      paths = newPaths.slice(0, this.branchingFactor);

      // Check if any path is confident enough
      const bestPath = paths[0];
      if (this.evaluatePath(bestPath) >= this.config.minConfidence) {
        break;
      }
    }

    // Select best path
    const bestPath = paths.reduce((best, path) =>
      this.evaluatePath(path) > this.evaluatePath(best) ? path : best
    );

    const confidence = this.evaluatePath(bestPath);
    const answer = bestPath[bestPath.length - 1]?.content || 'Unable to reach conclusion';

    // Notify steps
    for (const step of bestPath) {
      this.config.onStep?.(step);
    }

    return {
      answer,
      steps: bestPath,
      confidence,
      method: 'tree-of-thought',
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Self-Consistency Reasoner
 * Generates multiple reasoning paths and takes majority vote
 */
export class SelfConsistency {
  private config: ReasoningConfig;
  private numSamples: number;

  constructor(config?: Partial<ReasoningConfig> & { numSamples?: number }) {
    this.config = {
      maxSteps: config?.maxSteps ?? 10,
      minConfidence: config?.minConfidence ?? 0.7,
      verbose: config?.verbose ?? false,
      onStep: config?.onStep,
    };
    this.numSamples = config?.numSamples ?? 5;
  }

  /**
   * Generate multiple reasoning paths
   */
  async generateSamples(
    question: string,
    thinkingFn: (prompt: string) => Promise<string>,
    context?: string
  ): Promise<{ answer: string; steps: ReasoningStep[] }[]> {
    const cot = new ChainOfThought(this.config);
    const samples: { answer: string; steps: ReasoningStep[] }[] = [];

    for (let i = 0; i < this.numSamples; i++) {
      const result = await cot.reason(question, thinkingFn, context);
      samples.push({
        answer: result.answer,
        steps: result.steps,
      });
    }

    return samples;
  }

  /**
   * Find majority answer
   */
  findMajorityAnswer(samples: { answer: string; steps: ReasoningStep[] }[]): {
    answer: string;
    count: number;
    confidence: number;
  } {
    const answerCounts = new Map<string, number>();

    for (const sample of samples) {
      // Normalize answer for comparison
      const normalized = sample.answer.toLowerCase().trim();
      answerCounts.set(normalized, (answerCounts.get(normalized) || 0) + 1);
    }

    // Find most common answer
    let majorityAnswer = '';
    let majorityCount = 0;

    for (const [answer, count] of answerCounts) {
      if (count > majorityCount) {
        majorityCount = count;
        majorityAnswer = answer;
      }
    }

    // Find original (non-normalized) answer
    const originalAnswer = samples.find(
      (s) => s.answer.toLowerCase().trim() === majorityAnswer
    )?.answer || majorityAnswer;

    return {
      answer: originalAnswer,
      count: majorityCount,
      confidence: majorityCount / samples.length,
    };
  }

  /**
   * Perform self-consistency reasoning
   */
  async reason(
    question: string,
    thinkingFn: (prompt: string) => Promise<string>,
    context?: string
  ): Promise<ReasoningResult> {
    const startTime = Date.now();

    const samples = await this.generateSamples(question, thinkingFn, context);
    const majority = this.findMajorityAnswer(samples);

    // Get steps from a sample that matches majority answer
    const matchingSample = samples.find(
      (s) => s.answer.toLowerCase().trim() === majority.answer.toLowerCase().trim()
    );

    return {
      answer: majority.answer,
      steps: matchingSample?.steps || [],
      confidence: majority.confidence,
      method: 'self-consistency',
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * ReAct Reasoner
 * Interleaves reasoning and acting (tool use)
 */
export class ReActReasoner {
  private config: ReasoningConfig;
  private tools: Map<string, (input: string) => Promise<string>> = new Map();

  constructor(config?: Partial<ReasoningConfig>) {
    this.config = {
      maxSteps: config?.maxSteps ?? 10,
      minConfidence: config?.minConfidence ?? 0.7,
      verbose: config?.verbose ?? false,
      onStep: config?.onStep,
    };
  }

  /**
   * Register a tool
   */
  registerTool(name: string, fn: (input: string) => Promise<string>): this {
    this.tools.set(name, fn);
    return this;
  }

  /**
   * Parse action from response
   */
  parseAction(response: string): { tool: string; input: string } | null {
    // Look for Action: Tool[input] pattern
    const actionMatch = response.match(/Action:\s*(\w+)\[(.*?)\]/i);
    if (actionMatch) {
      return { tool: actionMatch[1], input: actionMatch[2] };
    }

    // Look for Action: tool with Input: input pattern
    const toolMatch = response.match(/Action:\s*(\w+)/i);
    const inputMatch = response.match(/Input:\s*(.+)/i);
    if (toolMatch && inputMatch) {
      return { tool: toolMatch[1], input: inputMatch[1] };
    }

    return null;
  }

  /**
   * Generate ReAct prompt
   */
  generatePrompt(question: string, steps: ReasoningStep[]): string {
    const toolList = Array.from(this.tools.keys()).join(', ');
    const history = steps.map((s) => `${s.type}: ${s.content}`).join('\n');

    return `Answer the following question using the ReAct approach.
Available tools: ${toolList}

Format:
Thought: [your reasoning]
Action: ToolName[input]
Observation: [tool result]
... (repeat as needed)
Thought: [final reasoning]
Answer: [your answer]

Question: ${question}

${history ? `Previous steps:\n${history}\n` : ''}
Continue:`;
  }

  /**
   * Perform ReAct reasoning
   */
  async reason(
    question: string,
    thinkingFn: (prompt: string) => Promise<string>
  ): Promise<ReasoningResult> {
    const startTime = Date.now();
    const steps: ReasoningStep[] = [];

    for (let i = 0; i < this.config.maxSteps; i++) {
      const prompt = this.generatePrompt(question, steps);
      const response = await thinkingFn(prompt);

      // Parse thought
      const thoughtMatch = response.match(/Thought:\s*(.+?)(?=\n|Action:|Answer:|$)/is);
      if (thoughtMatch) {
        const thoughtStep: ReasoningStep = {
          step: steps.length + 1,
          type: 'thought',
          content: thoughtMatch[1].trim(),
          timestamp: new Date(),
        };
        steps.push(thoughtStep);
        this.config.onStep?.(thoughtStep);
      }

      // Check for final answer
      const answerMatch = response.match(/Answer:\s*(.+)/is);
      if (answerMatch) {
        const conclusionStep: ReasoningStep = {
          step: steps.length + 1,
          type: 'conclusion',
          content: answerMatch[1].trim(),
          timestamp: new Date(),
        };
        steps.push(conclusionStep);
        this.config.onStep?.(conclusionStep);

        return {
          answer: answerMatch[1].trim(),
          steps,
          confidence: 0.8,
          method: 'react',
          durationMs: Date.now() - startTime,
        };
      }

      // Parse and execute action
      const action = this.parseAction(response);
      if (action) {
        const actionStep: ReasoningStep = {
          step: steps.length + 1,
          type: 'action',
          content: `${action.tool}[${action.input}]`,
          timestamp: new Date(),
        };
        steps.push(actionStep);
        this.config.onStep?.(actionStep);

        // Execute tool
        const tool = this.tools.get(action.tool.toLowerCase());
        let observation: string;

        if (tool) {
          try {
            observation = await tool(action.input);
          } catch (error) {
            observation = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
          }
        } else {
          observation = `Tool "${action.tool}" not found`;
        }

        const observationStep: ReasoningStep = {
          step: steps.length + 1,
          type: 'observation',
          content: observation,
          timestamp: new Date(),
        };
        steps.push(observationStep);
        this.config.onStep?.(observationStep);
      }
    }

    // Max steps reached without answer
    return {
      answer: 'Unable to reach conclusion within step limit',
      steps,
      confidence: 0.3,
      method: 'react',
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Create a Chain of Thought reasoner
 */
export function createCoT(config?: Partial<ReasoningConfig>): ChainOfThought {
  return new ChainOfThought(config);
}

/**
 * Create a Tree of Thought reasoner
 */
export function createToT(
  config?: Partial<ReasoningConfig> & { branchingFactor?: number }
): TreeOfThought {
  return new TreeOfThought(config);
}

/**
 * Create a Self-Consistency reasoner
 */
export function createSelfConsistency(
  config?: Partial<ReasoningConfig> & { numSamples?: number }
): SelfConsistency {
  return new SelfConsistency(config);
}

/**
 * Create a ReAct reasoner
 */
export function createReAct(config?: Partial<ReasoningConfig>): ReActReasoner {
  return new ReActReasoner(config);
}
