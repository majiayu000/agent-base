import { z } from 'zod';
import type { Tool, ToolSchema, ToolParameter } from '../core/types.js';

// ============================================================================
// Zod-based Tool Validation
// ============================================================================

/**
 * Convert a Zod schema to JSON Schema (ToolSchema)
 */
export function zodToJsonSchema(schema: z.ZodType): ToolSchema {
  return zodToToolSchema(schema) as ToolSchema;
}

function zodToToolSchema(schema: z.ZodType): ToolParameter | ToolSchema {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, ToolParameter> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToToolSchema(value as z.ZodType) as ToolParameter;

      // Check if field is required (not optional)
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
        required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  if (schema instanceof z.ZodString) {
    const result: ToolParameter = { type: 'string' };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodNumber) {
    const result: ToolParameter = { type: 'number' };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodBoolean) {
    const result: ToolParameter = { type: 'boolean' };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodArray) {
    const result: ToolParameter = {
      type: 'array',
      items: zodToToolSchema(schema.element) as ToolParameter,
    };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodEnum) {
    const result: ToolParameter = {
      type: 'string',
      enum: schema.options as string[],
    };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof z.ZodOptional) {
    return zodToToolSchema(schema.unwrap()) as ToolParameter;
  }

  if (schema instanceof z.ZodDefault) {
    return zodToToolSchema(schema.removeDefault()) as ToolParameter;
  }

  if (schema instanceof z.ZodNullable) {
    return zodToToolSchema(schema.unwrap()) as ToolParameter;
  }

  // Fallback
  return { type: 'string' };
}

/**
 * Create a validated tool using Zod schema
 */
export function createValidatedTool<TInput extends z.ZodRawShape, TOutput>(config: {
  name: string;
  description: string;
  schema: z.ZodObject<TInput>;
  execute: (args: z.infer<z.ZodObject<TInput>>, signal?: AbortSignal) => Promise<TOutput>;
}): Tool<z.infer<z.ZodObject<TInput>>, TOutput> {
  const { name, description, schema, execute } = config;

  return {
    name,
    description,
    parameters: zodToJsonSchema(schema),
    execute: async (args: unknown, signal?: AbortSignal) => {
      // Validate input using Zod
      const parsed = schema.parse(args);
      return execute(parsed, signal);
    },
  };
}

/**
 * Wrap an existing tool with validation
 */
export function withValidation<TInput, TOutput>(
  tool: Tool<TInput, TOutput>,
  schema: z.ZodType<TInput>
): Tool<TInput, TOutput> {
  return {
    ...tool,
    execute: async (args: TInput, signal?: AbortSignal) => {
      const validated = schema.parse(args);
      return tool.execute(validated, signal);
    },
  };
}

// ============================================================================
// Common Zod Schemas
// ============================================================================

/**
 * Common validation schemas for tool parameters
 */
export const commonSchemas = {
  /** File path that exists */
  filePath: z.string().min(1).describe('File path'),

  /** URL string */
  url: z.string().url().describe('Valid URL'),

  /** Positive integer */
  positiveInt: z.number().int().positive(),

  /** Non-empty string */
  nonEmptyString: z.string().min(1),

  /** JSON string */
  jsonString: z.string().refine(
    (val) => {
      try {
        JSON.parse(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid JSON string' }
  ),

  /** Timeout in milliseconds */
  timeout: z.number().int().min(100).max(300000).default(30000),
};

// ============================================================================
// Example: Validated Tool
// ============================================================================

/**
 * Example: Calculator tool with Zod validation
 */
export const validatedCalculatorTool = createValidatedTool({
  name: 'calculator_validated',
  description: 'Evaluate a mathematical expression with input validation',
  schema: z.object({
    expression: z.string().min(1).max(1000).describe('Mathematical expression to evaluate'),
    precision: z.number().int().min(0).max(20).optional().describe('Decimal precision for result'),
  }),
  execute: async ({ expression, precision = 10 }) => {
    const safeExpression = expression
      .replace(/\^/g, '**')
      .replace(/sqrt/g, 'Math.sqrt')
      .replace(/sin/g, 'Math.sin')
      .replace(/cos/g, 'Math.cos')
      .replace(/tan/g, 'Math.tan')
      .replace(/log/g, 'Math.log')
      .replace(/abs/g, 'Math.abs')
      .replace(/PI/g, 'Math.PI');

    const result = new Function(`return ${safeExpression}`)();

    if (typeof result !== 'number' || !isFinite(result)) {
      throw new Error('Expression did not evaluate to a valid number');
    }

    return {
      expression,
      result: Number(result.toFixed(precision)),
    };
  },
});

// ============================================================================
// Validation Error Formatting
// ============================================================================

/**
 * Format Zod validation errors for tool responses
 */
export function formatValidationError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.join('.');
    return `${path ? `${path}: ` : ''}${issue.message}`;
  });

  return `Validation failed:\n${issues.join('\n')}`;
}

/**
 * Safe parse with formatted error
 */
export function safeParse<T>(schema: z.ZodType<T>, data: unknown): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return { success: false, error: formatValidationError(result.error) };
}
