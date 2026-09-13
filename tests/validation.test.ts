import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  zodToJsonSchema,
  createValidatedTool,
  withValidation,
  formatValidationError,
  safeParse,
  commonSchemas,
  validatedCalculatorTool,
} from '../src/utils/validation.js';
import { safeEvaluateMathExpression } from '../src/utils/safe-math.js';
import { defineTool } from '../src/core/tool-executor.js';

describe('Validation Utils', () => {
  describe('zodToJsonSchema', () => {
    it('should convert simple object schema', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const jsonSchema = zodToJsonSchema(schema);

      expect(jsonSchema.type).toBe('object');
      expect(jsonSchema.properties).toHaveProperty('name');
      expect(jsonSchema.properties).toHaveProperty('age');
      expect(jsonSchema.properties.name.type).toBe('string');
      expect(jsonSchema.properties.age.type).toBe('number');
      expect(jsonSchema.required).toContain('name');
      expect(jsonSchema.required).toContain('age');
    });

    it('should handle optional fields', () => {
      const schema = z.object({
        required: z.string(),
        optional: z.string().optional(),
      });

      const jsonSchema = zodToJsonSchema(schema);

      expect(jsonSchema.required).toContain('required');
      expect(jsonSchema.required).not.toContain('optional');
    });

    it('should handle arrays', () => {
      const schema = z.object({
        items: z.array(z.string()),
      });

      const jsonSchema = zodToJsonSchema(schema);

      expect(jsonSchema.properties.items.type).toBe('array');
      expect(jsonSchema.properties.items.items?.type).toBe('string');
    });

    it('should handle enums', () => {
      const schema = z.object({
        status: z.enum(['active', 'inactive', 'pending']),
      });

      const jsonSchema = zodToJsonSchema(schema);

      expect(jsonSchema.properties.status.type).toBe('string');
      expect(jsonSchema.properties.status.enum).toEqual(['active', 'inactive', 'pending']);
    });

    it('should handle boolean', () => {
      const schema = z.object({
        enabled: z.boolean(),
      });

      const jsonSchema = zodToJsonSchema(schema);

      expect(jsonSchema.properties.enabled.type).toBe('boolean');
    });
  });

  describe('createValidatedTool', () => {
    it('should create a tool with validation', async () => {
      const tool = createValidatedTool({
        name: 'greet',
        description: 'Greet someone',
        schema: z.object({
          name: z.string().min(1),
          formal: z.boolean().optional(),
        }),
        execute: async ({ name, formal }) => {
          return formal ? `Good day, ${name}` : `Hi ${name}!`;
        },
      });

      expect(tool.name).toBe('greet');
      expect(tool.parameters.type).toBe('object');

      // Test execution with valid input
      const result = await tool.execute({ name: 'Alice', formal: true });
      expect(result).toBe('Good day, Alice');
    });

    it('should reject invalid input', async () => {
      const tool = createValidatedTool({
        name: 'add',
        description: 'Add two numbers',
        schema: z.object({
          a: z.number(),
          b: z.number(),
        }),
        execute: async ({ a, b }) => a + b,
      });

      // Invalid input should throw
      await expect(tool.execute({ a: 'not a number', b: 2 } as any)).rejects.toThrow();
    });
  });

  describe('withValidation', () => {
    it('should wrap existing tool with validation', async () => {
      const originalTool = defineTool<{ value: number }, number>({
        name: 'double',
        description: 'Double a number',
        parameters: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
        },
        execute: async ({ value }) => value * 2,
      });

      const validatedTool = withValidation(originalTool, z.object({
        value: z.number().min(0).max(100),
      }));

      // Valid input
      const result = await validatedTool.execute({ value: 10 });
      expect(result).toBe(20);

      // Invalid input (out of range)
      await expect(validatedTool.execute({ value: 200 })).rejects.toThrow();
    });
  });

  describe('formatValidationError', () => {
    it('should format validation errors nicely', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number().min(0),
      });

      const result = schema.safeParse({ name: 123, age: -5 });

      if (!result.success) {
        const formatted = formatValidationError(result.error);
        expect(formatted).toContain('Validation failed');
        expect(formatted).toContain('name');
        expect(formatted).toContain('age');
      }
    });
  });

  describe('safeParse', () => {
    it('should return success with valid data', () => {
      const schema = z.object({ x: z.number() });
      const result = safeParse(schema, { x: 42 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ x: 42 });
      }
    });

    it('should return error with invalid data', () => {
      const schema = z.object({ x: z.number() });
      const result = safeParse(schema, { x: 'not a number' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Validation failed');
      }
    });
  });

  describe('commonSchemas', () => {
    it('should validate URLs', () => {
      expect(commonSchemas.url.safeParse('https://example.com').success).toBe(true);
      expect(commonSchemas.url.safeParse('not-a-url').success).toBe(false);
    });

    it('should validate positive integers', () => {
      expect(commonSchemas.positiveInt.safeParse(5).success).toBe(true);
      expect(commonSchemas.positiveInt.safeParse(-1).success).toBe(false);
      expect(commonSchemas.positiveInt.safeParse(1.5).success).toBe(false);
    });

    it('should validate non-empty strings', () => {
      expect(commonSchemas.nonEmptyString.safeParse('hello').success).toBe(true);
      expect(commonSchemas.nonEmptyString.safeParse('').success).toBe(false);
    });

    it('should validate JSON strings', () => {
      expect(commonSchemas.jsonString.safeParse('{"a":1}').success).toBe(true);
      expect(commonSchemas.jsonString.safeParse('invalid').success).toBe(false);
    });

    it('should validate timeout values', () => {
      expect(commonSchemas.timeout.safeParse(5000).success).toBe(true);
      expect(commonSchemas.timeout.safeParse(50).success).toBe(false); // too low
      expect(commonSchemas.timeout.safeParse(500000).success).toBe(false); // too high
    });
  });

  describe('safeEvaluateMathExpression', () => {
    it('should evaluate arithmetic and functions', () => {
      expect(safeEvaluateMathExpression('2 + 3 * 4')).toBe(14);
      expect(safeEvaluateMathExpression('2^10')).toBe(1024);
      expect(safeEvaluateMathExpression('sqrt(16)')).toBe(4);
      expect(safeEvaluateMathExpression('PI * 2')).toBeCloseTo(Math.PI * 2);
      expect(safeEvaluateMathExpression('abs(-5)')).toBe(5);
      expect(safeEvaluateMathExpression('floor(3.9)')).toBe(3);
    });

    it('should give exponentiation higher precedence than unary signs', () => {
      // -2^2 => -(2^2) = -4, not (-2)^2 = 4
      expect(safeEvaluateMathExpression('-2^2')).toBe(-4);
      // 2^-2^2 => 2^(-(2^2)) = 2^-4 = 0.0625
      expect(safeEvaluateMathExpression('2^-2^2')).toBe(0.0625);
      expect(safeEvaluateMathExpression('2^-2')).toBe(0.25);
      expect(safeEvaluateMathExpression('-2^-3')).toBeCloseTo(-0.125);
    });

    it('should reject process.exit injection', () => {
      expect(() => safeEvaluateMathExpression('process.exit(1)')).toThrow();
    });

    it('should reject require fs injection', () => {
      expect(() => safeEvaluateMathExpression("require('fs')")).toThrow();
    });

    it('should reject Function constructor abuse', () => {
      expect(() => safeEvaluateMathExpression('Function("return this")()')).toThrow();
    });

    it('should reject constructor prototype abuse', () => {
      expect(() => safeEvaluateMathExpression('constructor.constructor("return 1")()')).toThrow();
    });
  });

  describe('validatedCalculatorTool', () => {
    it('should evaluate valid expressions with precision', async () => {
      const result = await validatedCalculatorTool.execute({
        expression: 'PI',
        precision: 4,
      });
      expect(result.result).toBe(3.1416);
    });

    it('should reject code injection payloads', async () => {
      await expect(
        validatedCalculatorTool.execute({ expression: 'process.exit(1)' })
      ).rejects.toThrow();
      await expect(
        validatedCalculatorTool.execute({ expression: "require('fs')" })
      ).rejects.toThrow();
      await expect(
        validatedCalculatorTool.execute({ expression: 'Function("return 1")()' })
      ).rejects.toThrow();
    });
  });
});
