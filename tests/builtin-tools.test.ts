import { describe, it, expect } from 'vitest';
import {
  calculatorTool,
  currentTimeTool,
  jsonParserTool,
  stringUtilsTool,
} from '../src/tools/builtin.js';

describe('Built-in Tools', () => {
  describe('calculatorTool', () => {
    it('should evaluate basic arithmetic', async () => {
      const result = await calculatorTool.execute({ expression: '2 + 3 * 4' });
      expect(result.result).toBe(14);
    });

    it('should handle exponents', async () => {
      const result = await calculatorTool.execute({ expression: '2^10' });
      expect(result.result).toBe(1024);
    });

    it('should handle math functions', async () => {
      const result = await calculatorTool.execute({ expression: 'sqrt(16)' });
      expect(result.result).toBe(4);
    });

    it('should handle parentheses', async () => {
      const result = await calculatorTool.execute({ expression: '(2 + 3) * 4' });
      expect(result.result).toBe(20);
    });

    it('should handle PI constant', async () => {
      const result = await calculatorTool.execute({ expression: 'PI * 2' });
      expect(result.result).toBeCloseTo(Math.PI * 2);
    });

    it('should reject invalid expressions', async () => {
      await expect(calculatorTool.execute({ expression: 'invalid!' })).rejects.toThrow();
    });
  });

  describe('currentTimeTool', () => {
    it('should return current time in ISO format', async () => {
      const result = await currentTimeTool.execute({ format: 'iso' });
      expect(result.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.unix).toBeGreaterThan(0);
    });

    it('should return unix timestamp', async () => {
      const result = await currentTimeTool.execute({ format: 'unix' });
      expect(parseInt(result.time)).toBeGreaterThan(1700000000);
    });

    it('should return locale format', async () => {
      const result = await currentTimeTool.execute({ format: 'locale' });
      expect(result.time).toBeTruthy();
      expect(result.timezone).toBeTruthy();
    });
  });

  describe('jsonParserTool', () => {
    it('should parse JSON string', async () => {
      const result = await jsonParserTool.execute({
        json: '{"name": "test", "value": 42}',
      });
      expect(result.parsed).toEqual({ name: 'test', value: 42 });
    });

    it('should extract with query path', async () => {
      const result = await jsonParserTool.execute({
        json: '{"users": [{"name": "Alice"}, {"name": "Bob"}]}',
        query: 'users.0.name',
      });
      expect(result.result).toBe('Alice');
    });

    it('should handle nested queries', async () => {
      const result = await jsonParserTool.execute({
        json: '{"data": {"items": [1, 2, 3]}}',
        query: 'data.items.1',
      });
      expect(result.result).toBe(2);
    });

    it('should reject invalid JSON', async () => {
      await expect(jsonParserTool.execute({ json: 'not json' })).rejects.toThrow();
    });
  });

  describe('stringUtilsTool', () => {
    it('should get string length', async () => {
      const result = await stringUtilsTool.execute({
        text: 'hello',
        operation: 'length',
      });
      expect(result.result).toBe(5);
    });

    it('should convert to uppercase', async () => {
      const result = await stringUtilsTool.execute({
        text: 'hello',
        operation: 'uppercase',
      });
      expect(result.result).toBe('HELLO');
    });

    it('should convert to lowercase', async () => {
      const result = await stringUtilsTool.execute({
        text: 'HELLO',
        operation: 'lowercase',
      });
      expect(result.result).toBe('hello');
    });

    it('should reverse string', async () => {
      const result = await stringUtilsTool.execute({
        text: 'hello',
        operation: 'reverse',
      });
      expect(result.result).toBe('olleh');
    });

    it('should trim string', async () => {
      const result = await stringUtilsTool.execute({
        text: '  hello  ',
        operation: 'trim',
      });
      expect(result.result).toBe('hello');
    });

    it('should split string', async () => {
      const result = await stringUtilsTool.execute({
        text: 'a,b,c',
        operation: 'split',
        delimiter: ',',
      });
      expect(result.result).toEqual(['a', 'b', 'c']);
    });
  });
});
