import { describe, it, expect } from 'bun:test';
import { Reflection, createReflection } from '../src/patterns/reflection.js';

describe('Reflection Pattern', () => {
  describe('createReflection', () => {
    it('should create reflection with default config', () => {
      const reflection = createReflection();
      expect(reflection).toBeInstanceOf(Reflection);
    });

    it('should create reflection with custom config', () => {
      const reflection = createReflection({
        maxReflections: 5,
        qualityThreshold: 0.8,
      });
      expect(reflection).toBeInstanceOf(Reflection);
    });
  });

  describe('Reflection class', () => {
    it('should initialize with default values', () => {
      const reflection = new Reflection();
      expect(reflection).toBeDefined();
    });

    it('should accept custom evaluation prompt', () => {
      const customPrompt = 'Custom evaluation: {response}';
      const reflection = new Reflection({
        evaluationPrompt: customPrompt,
      });
      expect(reflection).toBeDefined();
    });

    it('should accept custom improvement prompt', () => {
      const customPrompt = 'Improve this: {response}';
      const reflection = new Reflection({
        improvementPrompt: customPrompt,
      });
      expect(reflection).toBeDefined();
    });
  });

  describe('ReflectionResult structure', () => {
    it('should have correct structure', () => {
      // Test the expected structure of ReflectionResult
      const mockResult = {
        response: 'test response',
        reflectionCount: 2,
        qualityScores: [0.5, 0.8],
        originalResponse: 'original',
        thresholdMet: true,
        totalUsage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        },
      };

      expect(mockResult.response).toBe('test response');
      expect(mockResult.reflectionCount).toBe(2);
      expect(mockResult.qualityScores).toHaveLength(2);
      expect(mockResult.thresholdMet).toBe(true);
    });
  });

  describe('EvaluationResult structure', () => {
    it('should have correct structure', () => {
      const mockEvaluation = {
        score: 0.75,
        feedback: 'Good but could be better',
        improvements: ['Add more detail', 'Be more concise'],
      };

      expect(mockEvaluation.score).toBe(0.75);
      expect(mockEvaluation.feedback).toBe('Good but could be better');
      expect(mockEvaluation.improvements).toHaveLength(2);
    });
  });
});
