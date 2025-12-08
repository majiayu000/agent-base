import { defineTool } from '../core/tool-executor.js';

// ============================================================================
// Built-in Example Tools
// ============================================================================

/**
 * Calculator tool - performs basic math operations
 */
export const calculatorTool = defineTool<
  { expression: string },
  { result: number; expression: string }
>({
  name: 'calculator',
  description: 'Evaluate a mathematical expression. Supports basic operations (+, -, *, /, ^, %), parentheses, and common math functions (sqrt, sin, cos, tan, log, abs, floor, ceil, round).',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'The mathematical expression to evaluate, e.g., "2 + 3 * 4" or "sqrt(16) + 2^3"',
      },
    },
    required: ['expression'],
  },
  execute: async ({ expression }) => {
    // Safe math evaluation using Function constructor
    // Replace common math functions with Math equivalents
    const safeExpression = expression
      .replace(/\^/g, '**')
      .replace(/sqrt/g, 'Math.sqrt')
      .replace(/sin/g, 'Math.sin')
      .replace(/cos/g, 'Math.cos')
      .replace(/tan/g, 'Math.tan')
      .replace(/log/g, 'Math.log')
      .replace(/abs/g, 'Math.abs')
      .replace(/floor/g, 'Math.floor')
      .replace(/ceil/g, 'Math.ceil')
      .replace(/round/g, 'Math.round')
      .replace(/PI/g, 'Math.PI')
      .replace(/E/g, 'Math.E');

    // Validate expression contains only allowed characters
    if (!/^[\d\s+\-*/%().Math,sqrtincoabfleurndPIE]+$/.test(safeExpression)) {
      throw new Error(`Invalid characters in expression: ${expression}`);
    }

    try {
      const result = new Function(`return ${safeExpression}`)();
      if (typeof result !== 'number' || !isFinite(result)) {
        throw new Error('Expression did not evaluate to a valid number');
      }
      return { result, expression };
    } catch (error) {
      throw new Error(`Failed to evaluate expression: ${expression}`);
    }
  },
});

/**
 * Current time tool - returns the current date and time
 */
export const currentTimeTool = defineTool<
  { timezone?: string; format?: 'iso' | 'locale' | 'unix' },
  { time: string; timezone: string; unix: number }
>({
  name: 'current_time',
  description: 'Get the current date and time. Can return time in different formats and timezones.',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone name (e.g., "America/New_York", "Asia/Shanghai"). Defaults to system timezone.',
      },
      format: {
        type: 'string',
        description: 'Output format: "iso" (ISO 8601), "locale" (human readable), or "unix" (timestamp)',
        enum: ['iso', 'locale', 'unix'],
      },
    },
  },
  execute: async ({ timezone, format = 'iso' }) => {
    const now = new Date();
    const unix = Math.floor(now.getTime() / 1000);

    let time: string;
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    switch (format) {
      case 'unix':
        time = unix.toString();
        break;
      case 'locale':
        time = now.toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' });
        break;
      case 'iso':
      default:
        time = now.toISOString();
        break;
    }

    return { time, timezone: tz, unix };
  },
});

/**
 * JSON parser tool - parse and query JSON data
 */
export const jsonParserTool = defineTool<
  { json: string; query?: string },
  { parsed: unknown; query?: string; result?: unknown }
>({
  name: 'json_parser',
  description: 'Parse a JSON string and optionally extract data using a dot-notation path (e.g., "users.0.name").',
  parameters: {
    type: 'object',
    properties: {
      json: {
        type: 'string',
        description: 'The JSON string to parse',
      },
      query: {
        type: 'string',
        description: 'Optional dot-notation path to extract specific data (e.g., "data.items.0.id")',
      },
    },
    required: ['json'],
  },
  execute: async ({ json, query }) => {
    const parsed = JSON.parse(json);

    if (!query) {
      return { parsed };
    }

    // Navigate the path
    const parts = query.split('.');
    let result: unknown = parsed;

    for (const part of parts) {
      if (result === null || result === undefined) {
        throw new Error(`Cannot access "${part}" on null/undefined`);
      }

      if (typeof result === 'object') {
        result = (result as Record<string, unknown>)[part];
      } else {
        throw new Error(`Cannot access "${part}" on non-object`);
      }
    }

    return { parsed, query, result };
  },
});

/**
 * String utilities tool
 */
export const stringUtilsTool = defineTool<
  { text: string; operation: 'length' | 'uppercase' | 'lowercase' | 'reverse' | 'trim' | 'split'; delimiter?: string },
  { input: string; operation: string; result: string | number | string[] }
>({
  name: 'string_utils',
  description: 'Perform common string operations: length, uppercase, lowercase, reverse, trim, or split.',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The input text to process',
      },
      operation: {
        type: 'string',
        description: 'The operation to perform',
        enum: ['length', 'uppercase', 'lowercase', 'reverse', 'trim', 'split'],
      },
      delimiter: {
        type: 'string',
        description: 'Delimiter for split operation (default: space)',
      },
    },
    required: ['text', 'operation'],
  },
  execute: async ({ text, operation, delimiter = ' ' }) => {
    let result: string | number | string[];

    switch (operation) {
      case 'length':
        result = text.length;
        break;
      case 'uppercase':
        result = text.toUpperCase();
        break;
      case 'lowercase':
        result = text.toLowerCase();
        break;
      case 'reverse':
        result = text.split('').reverse().join('');
        break;
      case 'trim':
        result = text.trim();
        break;
      case 'split':
        result = text.split(delimiter);
        break;
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }

    return { input: text, operation, result };
  },
});

/**
 * All built-in tools as an array
 */
export const builtinTools = [
  calculatorTool,
  currentTimeTool,
  jsonParserTool,
  stringUtilsTool,
];
