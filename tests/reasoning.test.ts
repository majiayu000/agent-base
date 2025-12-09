import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ChainOfThought,
  TreeOfThought,
  SelfConsistency,
  ReActReasoner,
  createCoT,
  createToT,
  createSelfConsistency,
  createReAct,
} from '../src/patterns/reasoning.js';

describe('Reasoning Techniques Pattern', () => {
  describe('ChainOfThought', () => {
    let cot: ChainOfThought;

    beforeEach(() => {
      cot = createCoT({ maxSteps: 10 });
    });

    describe('createCoT', () => {
      it('should create CoT with default config', () => {
        const c = createCoT();
        expect(c).toBeInstanceOf(ChainOfThought);
      });

      it('should create CoT with custom config', () => {
        const c = createCoT({
          maxSteps: 5,
          minConfidence: 0.8,
          verbose: true,
        });
        expect(c).toBeInstanceOf(ChainOfThought);
      });
    });

    describe('generatePrompt', () => {
      it('should generate CoT prompt', () => {
        const prompt = cot.generatePrompt('What is 2 + 2?');

        expect(prompt).toContain('step by step');
        expect(prompt).toContain('What is 2 + 2?');
      });

      it('should include context if provided', () => {
        const prompt = cot.generatePrompt('Solve the problem', 'x = 5');

        expect(prompt).toContain('Context:');
        expect(prompt).toContain('x = 5');
      });
    });

    describe('parseSteps', () => {
      it('should parse reasoning steps', () => {
        const text = `First, let me understand the problem.
I notice that we need to add two numbers.
Therefore, the answer is 4.`;

        const steps = cot.parseSteps(text);

        expect(steps.length).toBe(3);
        expect(steps[0].type).toBe('action');
        expect(steps[2].type).toBe('conclusion');
      });

      it('should identify observation steps', () => {
        const text = 'I observe that the value is positive.';
        const steps = cot.parseSteps(text);

        expect(steps[0].type).toBe('observation');
      });

      it('should identify reflection steps', () => {
        const text = 'Checking my calculation to verify.';
        const steps = cot.parseSteps(text);

        expect(steps[0].type).toBe('reflection');
      });
    });

    describe('calculateConfidence', () => {
      it('should calculate confidence from steps', () => {
        const steps = cot.parseSteps(`
Let me think about this.
I observe the pattern.
Let me verify.
Therefore, the answer is correct.
`);

        const confidence = cot.calculateConfidence(steps);

        expect(confidence).toBeGreaterThan(0.5);
        expect(confidence).toBeLessThanOrEqual(1);
      });

      it('should return 0 for empty steps', () => {
        const confidence = cot.calculateConfidence([]);
        expect(confidence).toBe(0);
      });
    });

    describe('reason', () => {
      it('should perform CoT reasoning', async () => {
        const thinkingFn = async (prompt: string) => `
Let me think about this step by step.
First, I understand we need to solve: ${prompt.includes('2 + 2') ? '2 + 2' : 'the problem'}
The answer is clearly 4.
Therefore, the final answer is 4.`;

        const result = await cot.reason('What is 2 + 2?', thinkingFn);

        expect(result.answer).toContain('4');
        expect(result.steps.length).toBeGreaterThan(0);
        expect(result.method).toBe('chain-of-thought');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      });

      it('should call onStep callback', async () => {
        const stepsCalled: number[] = [];
        const cotWithCallback = createCoT({
          onStep: (step) => stepsCalled.push(step.step),
        });

        const thinkingFn = async () => 'Step 1.\nStep 2.\nConclusion.';
        await cotWithCallback.reason('test', thinkingFn);

        expect(stepsCalled.length).toBeGreaterThan(0);
      });
    });
  });

  describe('TreeOfThought', () => {
    let tot: TreeOfThought;

    beforeEach(() => {
      tot = createToT({ maxSteps: 3, branchingFactor: 2 });
    });

    describe('createToT', () => {
      it('should create ToT with default config', () => {
        const t = createToT();
        expect(t).toBeInstanceOf(TreeOfThought);
      });

      it('should create ToT with custom config', () => {
        const t = createToT({
          maxSteps: 5,
          branchingFactor: 4,
        });
        expect(t).toBeInstanceOf(TreeOfThought);
      });
    });

    describe('evaluatePath', () => {
      it('should evaluate reasoning paths', () => {
        const path = [
          { step: 1, type: 'thought' as const, content: 'First thought', confidence: 0.8, timestamp: new Date() },
          { step: 2, type: 'observation' as const, content: 'Observation', confidence: 0.9, timestamp: new Date() },
          { step: 3, type: 'conclusion' as const, content: 'Conclusion', confidence: 0.85, timestamp: new Date() },
        ];

        const score = tot['evaluatePath'](path);

        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThanOrEqual(1);
      });

      it('should return 0 for empty path', () => {
        const score = tot['evaluatePath']([]);
        expect(score).toBe(0);
      });
    });

    describe('reason', () => {
      it('should perform ToT reasoning', async () => {
        let callCount = 0;
        const thinkingFn = async () => {
          callCount++;
          return `Alternative approach ${callCount}: This could be the answer.`;
        };

        const result = await tot.reason('What is the best approach?', thinkingFn);

        expect(result.answer).toBeDefined();
        expect(result.method).toBe('tree-of-thought');
        expect(result.steps.length).toBeGreaterThan(0);
      });
    });
  });

  describe('SelfConsistency', () => {
    let sc: SelfConsistency;

    beforeEach(() => {
      sc = createSelfConsistency({ numSamples: 3 });
    });

    describe('createSelfConsistency', () => {
      it('should create SC with default config', () => {
        const s = createSelfConsistency();
        expect(s).toBeInstanceOf(SelfConsistency);
      });

      it('should create SC with custom config', () => {
        const s = createSelfConsistency({
          numSamples: 5,
          maxSteps: 8,
        });
        expect(s).toBeInstanceOf(SelfConsistency);
      });
    });

    describe('findMajorityAnswer', () => {
      it('should find majority answer', () => {
        const samples = [
          { answer: 'Yes', steps: [] },
          { answer: 'Yes', steps: [] },
          { answer: 'No', steps: [] },
        ];

        const result = sc['findMajorityAnswer'](samples);

        expect(result.answer.toLowerCase()).toBe('yes');
        expect(result.count).toBe(2);
        expect(result.confidence).toBeCloseTo(2 / 3);
      });

      it('should handle case-insensitive matching', () => {
        const samples = [
          { answer: 'YES', steps: [] },
          { answer: 'yes', steps: [] },
          { answer: 'Yes', steps: [] },
        ];

        const result = sc['findMajorityAnswer'](samples);

        expect(result.count).toBe(3);
        expect(result.confidence).toBe(1);
      });
    });

    describe('reason', () => {
      it('should perform self-consistency reasoning', async () => {
        let callCount = 0;
        const thinkingFn = async () => {
          callCount++;
          // Return consistent answer most of the time
          if (callCount % 3 !== 0) {
            return 'Step 1.\nTherefore, the answer is 42.';
          }
          return 'Step 1.\nTherefore, the answer is 43.';
        };

        const result = await sc.reason('What is the answer?', thinkingFn);

        expect(result.answer).toContain('42');
        expect(result.method).toBe('self-consistency');
        expect(result.confidence).toBeGreaterThan(0.5);
      });
    });
  });

  describe('ReActReasoner', () => {
    let react: ReActReasoner;

    beforeEach(() => {
      react = createReAct({ maxSteps: 5 });
    });

    describe('createReAct', () => {
      it('should create ReAct with default config', () => {
        const r = createReAct();
        expect(r).toBeInstanceOf(ReActReasoner);
      });
    });

    describe('registerTool', () => {
      it('should register tools', () => {
        react.registerTool('search', async (input) => `Results for: ${input}`);
        react.registerTool('calculate', async (input) => `Calculated: ${input}`);

        // Tools are private, but we can test they work via reason
        expect(react).toBeDefined();
      });

      it('should support chaining', () => {
        const result = react
          .registerTool('tool1', async () => 'result1')
          .registerTool('tool2', async () => 'result2');

        expect(result).toBe(react);
      });
    });

    describe('parseAction', () => {
      it('should parse Action: Tool[input] format', () => {
        const response = 'Thought: I need to search.\nAction: Search[query term]';
        const action = react['parseAction'](response);

        expect(action?.tool).toBe('Search');
        expect(action?.input).toBe('query term');
      });

      it('should parse Action/Input format', () => {
        const response = 'Action: Calculate\nInput: 2 + 2';
        const action = react['parseAction'](response);

        expect(action?.tool).toBe('Calculate');
        expect(action?.input).toBe('2 + 2');
      });

      it('should return null for no action', () => {
        const response = 'Just some thinking without action.';
        const action = react['parseAction'](response);

        expect(action).toBeNull();
      });
    });

    describe('reason', () => {
      it('should perform ReAct reasoning with tools', async () => {
        react.registerTool('lookup', async (input) => `The answer to ${input} is 42`);

        let step = 0;
        const thinkingFn = async () => {
          step++;
          if (step === 1) {
            return 'Thought: I need to look up the answer.\nAction: Lookup[the question]';
          }
          return 'Thought: Now I have the answer.\nAnswer: The answer is 42.';
        };

        const result = await react.reason('What is the answer?', thinkingFn);

        expect(result.answer).toContain('42');
        expect(result.method).toBe('react');
        expect(result.steps.some((s) => s.type === 'action')).toBe(true);
        expect(result.steps.some((s) => s.type === 'observation')).toBe(true);
      });

      it('should handle tool not found', async () => {
        let step = 0;
        const thinkingFn = async () => {
          step++;
          if (step === 1) {
            return 'Thought: Let me try a tool.\nAction: NonExistentTool[input]';
          }
          return 'Answer: Could not find tool.';
        };

        const result = await react.reason('test', thinkingFn);

        // The observation should contain "not found"
        expect(result.steps.some((s) => s.type === 'observation' && s.content.includes('not found'))).toBe(true);
      });

      it('should handle tool errors', async () => {
        react.registerTool('error_tool', async () => {
          throw new Error('Tool failed');
        });

        const thinkingFn = async () => 'Action: Error_Tool[input]\nAnswer: Error occurred.';

        const result = await react.reason('test', thinkingFn);

        expect(result.steps.some((s) => s.content.includes('Error'))).toBe(true);
      });

      it('should respect maxSteps', async () => {
        const limitedReact = createReAct({ maxSteps: 2 });
        limitedReact.registerTool('loop', async () => 'Keep going');

        let calls = 0;
        const thinkingFn = async () => {
          calls++;
          return 'Thought: Need more steps.\nAction: Loop[again]';
        };

        const result = await limitedReact.reason('test', thinkingFn);

        // Should stop after max steps without answer
        expect(result.confidence).toBeLessThan(0.5);
      });

      it('should call onStep callback', async () => {
        const steps: string[] = [];
        const reactWithCallback = createReAct({
          onStep: (step) => steps.push(step.type),
        });

        reactWithCallback.registerTool('test', async () => 'result');

        const thinkingFn = async () => 'Thought: Testing.\nAction: Test[input]\nAnswer: Done.';
        await reactWithCallback.reason('test', thinkingFn);

        expect(steps).toContain('thought');
      });
    });
  });

  describe('Integration', () => {
    it('should work with simulated LLM calls', async () => {
      const cot = createCoT();

      // Simulate an LLM that solves math problems
      const mathLLM = async (prompt: string) => {
        if (prompt.includes('2 + 2')) {
          return `Let me solve this step by step.
First, I identify the operation: addition.
The numbers are 2 and 2.
Adding them together: 2 + 2 = 4.
Therefore, the answer is 4.`;
        }
        return 'I need more information to answer.';
      };

      const result = await cot.reason('What is 2 + 2?', mathLLM);

      expect(result.answer).toContain('4');
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('should handle complex reasoning scenarios', async () => {
      const react = createReAct({ maxSteps: 10 });

      react.registerTool('weather', async (city) => {
        if (city.toLowerCase().includes('tokyo')) {
          return 'Tokyo: 25°C, Sunny';
        }
        return 'Unknown city';
      });

      react.registerTool('convert', async (temp) => {
        const celsius = parseFloat(temp);
        const fahrenheit = (celsius * 9/5) + 32;
        return `${fahrenheit}°F`;
      });

      let step = 0;
      const thinkingFn = async () => {
        step++;
        switch (step) {
          case 1:
            return 'Thought: I need to check the weather in Tokyo.\nAction: Weather[Tokyo]';
          case 2:
            return 'Thought: I got 25°C. Let me convert to Fahrenheit.\nAction: Convert[25]';
          case 3:
            return 'Thought: The temperature is 77°F.\nAnswer: The weather in Tokyo is 25°C (77°F) and sunny.';
          default:
            return 'Answer: Done.';
        }
      };

      const result = await react.reason('What is the weather in Tokyo?', thinkingFn);

      expect(result.steps.length).toBeGreaterThan(2);
      expect(result.answer).toContain('77');
    });
  });
});
