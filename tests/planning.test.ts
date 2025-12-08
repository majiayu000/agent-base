import { describe, it, expect } from 'bun:test';
import { Planner, createPlanner } from '../src/patterns/planning.js';
import type { Plan, PlanStep } from '../src/patterns/planning.js';

describe('Planning Pattern', () => {
  describe('createPlanner', () => {
    it('should create planner with default config', () => {
      const planner = createPlanner();
      expect(planner).toBeInstanceOf(Planner);
    });

    it('should create planner with custom config', () => {
      const planner = createPlanner({
        maxSteps: 5,
        allowRevision: false,
      });
      expect(planner).toBeInstanceOf(Planner);
    });
  });

  describe('Planner class', () => {
    it('should initialize with default values', () => {
      const planner = new Planner();
      expect(planner).toBeDefined();
    });

    it('should accept custom planning prompt', () => {
      const customPrompt = 'Create plan for: {task}';
      const planner = new Planner({
        planningPrompt: customPrompt,
      });
      expect(planner).toBeDefined();
    });

    it('should accept custom execution prompt', () => {
      const customPrompt = 'Execute step {stepNumber}: {stepDescription}';
      const planner = new Planner({
        executionPrompt: customPrompt,
      });
      expect(planner).toBeDefined();
    });
  });

  describe('Plan structure', () => {
    it('should have correct structure', () => {
      const mockPlan: Plan = {
        id: 'test-id',
        task: 'Test task',
        steps: [
          {
            step: 1,
            description: 'First step',
            status: 'pending',
            dependsOn: [],
          },
          {
            step: 2,
            description: 'Second step',
            status: 'pending',
            dependsOn: [1],
          },
        ],
        status: 'planning',
        createdAt: new Date(),
      };

      expect(mockPlan.id).toBe('test-id');
      expect(mockPlan.steps).toHaveLength(2);
      expect(mockPlan.steps[1].dependsOn).toContain(1);
    });
  });

  describe('PlanStep structure', () => {
    it('should have correct structure', () => {
      const mockStep: PlanStep = {
        step: 1,
        description: 'Test step',
        tool: 'calculator',
        expectedOutput: 'A number',
        dependsOn: [],
        status: 'completed',
        result: '42',
      };

      expect(mockStep.step).toBe(1);
      expect(mockStep.tool).toBe('calculator');
      expect(mockStep.status).toBe('completed');
      expect(mockStep.result).toBe('42');
    });

    it('should handle failed status with error', () => {
      const mockStep: PlanStep = {
        step: 1,
        description: 'Failed step',
        status: 'failed',
        error: 'Something went wrong',
        dependsOn: [],
      };

      expect(mockStep.status).toBe('failed');
      expect(mockStep.error).toBe('Something went wrong');
    });
  });

  describe('PlanningResult structure', () => {
    it('should have correct structure', () => {
      const mockResult = {
        plan: {
          id: 'test',
          task: 'Test',
          steps: [],
          status: 'completed' as const,
          createdAt: new Date(),
          completedAt: new Date(),
        },
        response: 'Final response',
        executionTimeMs: 1000,
        stepsExecuted: 3,
        stepsFailed: 0,
      };

      expect(mockResult.response).toBe('Final response');
      expect(mockResult.executionTimeMs).toBe(1000);
      expect(mockResult.stepsExecuted).toBe(3);
      expect(mockResult.stepsFailed).toBe(0);
    });
  });
});
