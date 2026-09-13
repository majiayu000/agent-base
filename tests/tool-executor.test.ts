import { describe, it, expect, beforeEach } from 'vitest';
import { ToolExecutor, defineTool, createTool } from '../src/core/tool-executor.js';
import type { Tool, ToolCall } from '../src/core/types.js';

describe('ToolExecutor', () => {
  let executor: ToolExecutor;

  const echoTool = defineTool<{ message: string }, { echo: string }>({
    name: 'echo',
    description: 'Echo back the message',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to echo' },
      },
      required: ['message'],
    },
    execute: async ({ message }) => ({ echo: message }),
  });

  const failingTool = defineTool<Record<string, never>, never>({
    name: 'failing',
    description: 'Always fails',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      throw new Error('Tool failure');
    },
  });

  beforeEach(() => {
    executor = new ToolExecutor();
  });

  describe('registration', () => {
    it('should register a tool', () => {
      executor.register(echoTool);

      expect(executor.has('echo')).toBe(true);
      expect(executor.count).toBe(1);
    });

    it('should register multiple tools', () => {
      executor.registerMany([echoTool, failingTool]);

      expect(executor.count).toBe(2);
      expect(executor.getNames()).toContain('echo');
      expect(executor.getNames()).toContain('failing');
    });

    it('should unregister a tool', () => {
      executor.register(echoTool);
      const removed = executor.unregister('echo');

      expect(removed).toBe(true);
      expect(executor.has('echo')).toBe(false);
    });

    it('should get tool by name', () => {
      executor.register(echoTool);
      const tool = executor.get('echo');

      expect(tool).toBeDefined();
      expect(tool?.name).toBe('echo');
    });

    it('should return schemas for LLM', () => {
      executor.registerMany([echoTool, failingTool]);
      const schemas = executor.getSchemas();

      expect(schemas).toHaveLength(2);
      expect(schemas[0]).toHaveProperty('name');
      expect(schemas[0]).toHaveProperty('description');
      expect(schemas[0]).toHaveProperty('parameters');
    });
  });

  describe('execution', () => {
    beforeEach(() => {
      executor.registerMany([echoTool, failingTool]);
    });

    it('should execute a tool call successfully', async () => {
      const toolCall: ToolCall = {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'echo',
          arguments: JSON.stringify({ message: 'Hello' }),
        },
      };

      const result = await executor.execute(toolCall);

      expect(result.toolCallId).toBe('call_1');
      expect(result.toolName).toBe('echo');
      expect(result.error).toBeUndefined();
      expect(JSON.parse(result.result)).toEqual({ echo: 'Hello' });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle unknown tool', async () => {
      const toolCall: ToolCall = {
        id: 'call_2',
        type: 'function',
        function: {
          name: 'unknown',
          arguments: '{}',
        },
      };

      const result = await executor.execute(toolCall);

      expect(result.error).toContain('Unknown tool');
    });

    it('should handle tool execution error', async () => {
      const toolCall: ToolCall = {
        id: 'call_3',
        type: 'function',
        function: {
          name: 'failing',
          arguments: '{}',
        },
      };

      const result = await executor.execute(toolCall);

      expect(result.error).toContain('Tool failure');
    });

    it('should handle invalid JSON arguments', async () => {
      const toolCall: ToolCall = {
        id: 'call_4',
        type: 'function',
        function: {
          name: 'echo',
          arguments: 'invalid json',
        },
      };

      const result = await executor.execute(toolCall);

      expect(result.error).toContain('Failed to parse');
    });

    it('should execute multiple tools in parallel', async () => {
      const calls: ToolCall[] = [
        {
          id: 'call_a',
          type: 'function',
          function: { name: 'echo', arguments: JSON.stringify({ message: 'A' }) },
        },
        {
          id: 'call_b',
          type: 'function',
          function: { name: 'echo', arguments: JSON.stringify({ message: 'B' }) },
        },
      ];

      const results = await executor.executeMany(calls);

      expect(results).toHaveLength(2);
      expect(results[0].toolCallId).toBe('call_a');
      expect(results[1].toolCallId).toBe('call_b');
    });

    it('should execute multiple tools sequentially', async () => {
      const calls: ToolCall[] = [
        {
          id: 'call_x',
          type: 'function',
          function: { name: 'echo', arguments: JSON.stringify({ message: 'X' }) },
        },
        {
          id: 'call_y',
          type: 'function',
          function: { name: 'echo', arguments: JSON.stringify({ message: 'Y' }) },
        },
      ];

      const results = await executor.executeManySequential(calls);

      expect(results).toHaveLength(2);
    });
  });

  describe('caching', () => {
    it('should re-execute mutating tools within TTL when cacheable is absent', async () => {
      let executions = 0;
      const writeFileTool = defineTool<{ path: string }, { ok: boolean }>({
        name: 'write_file',
        description: 'Write a file (mutating)',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
        execute: async () => {
          executions += 1;
          return { ok: true };
        },
      });

      executor.register(writeFileTool);
      executor.setCacheTTL(60_000);

      const toolCall: ToolCall = {
        id: 'call_write',
        type: 'function',
        function: {
          name: 'write_file',
          arguments: JSON.stringify({ path: '/tmp/x' }),
        },
      };

      const first = await executor.execute(toolCall, true);
      const second = await executor.execute(toolCall, true);

      expect(first.error).toBeUndefined();
      expect(second.error).toBeUndefined();
      expect(executions).toBe(2);
    });

    it('should cache opt-in cacheable tools when useCache is true', async () => {
      let executions = 0;
      const pureTool = defineTool<{ q: string }, { answer: string }>({
        name: 'lookup',
        description: 'Pure lookup',
        cacheable: true,
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string' },
          },
          required: ['q'],
        },
        execute: async ({ q }) => {
          executions += 1;
          return { answer: q };
        },
      });

      executor.register(pureTool);
      executor.setCacheTTL(60_000);

      const toolCall: ToolCall = {
        id: 'call_lookup',
        type: 'function',
        function: {
          name: 'lookup',
          arguments: JSON.stringify({ q: 'hello' }),
        },
      };

      const first = await executor.execute(toolCall, true);
      const second = await executor.execute(toolCall, true);

      expect(JSON.parse(first.result)).toEqual({ answer: 'hello' });
      expect(JSON.parse(second.result)).toEqual({ answer: 'hello' });
      expect(executions).toBe(1);
    });

    it('should not cache cacheable tools when useCache is false', async () => {
      let executions = 0;
      const pureTool = defineTool<Record<string, never>, number>({
        name: 'counter',
        description: 'Cacheable counter',
        cacheable: true,
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          executions += 1;
          return executions;
        },
      });

      executor.register(pureTool);

      const toolCall: ToolCall = {
        id: 'call_counter',
        type: 'function',
        function: { name: 'counter', arguments: '{}' },
      };

      await executor.execute(toolCall, false);
      await executor.execute(toolCall, false);

      expect(executions).toBe(2);
    });

    it('should plumb cacheable through ToolBuilder', async () => {
      let executions = 0;
      const tool = createTool<{ n: number }>()
        .name('double')
        .description('Double a number')
        .cacheable(true)
        .parameters({
          type: 'object',
          properties: { n: { type: 'number' } },
          required: ['n'],
        })
        .execute(async ({ n }) => {
          executions += 1;
          return n * 2;
        });

      expect(tool.cacheable).toBe(true);
      executor.register(tool);

      const toolCall: ToolCall = {
        id: 'call_double',
        type: 'function',
        function: {
          name: 'double',
          arguments: JSON.stringify({ n: 3 }),
        },
      };

      await executor.execute(toolCall, true);
      await executor.execute(toolCall, true);
      expect(executions).toBe(1);
    });
  });

  describe('tool builders', () => {
    it('should create tool with defineTool', () => {
      const tool = defineTool({
        name: 'test',
        description: 'Test tool',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'done',
      });

      expect(tool.name).toBe('test');
      expect(tool.description).toBe('Test tool');
      expect(tool.cacheable).toBeUndefined();
    });

    it('should create tool with fluent builder', () => {
      const tool = createTool<{ value: number }>()
        .name('multiply')
        .description('Multiply by 2')
        .parameters({
          type: 'object',
          properties: {
            value: { type: 'number' },
          },
          required: ['value'],
        })
        .execute(async ({ value }) => value * 2);

      expect(tool.name).toBe('multiply');
      expect(tool.cacheable).toBeUndefined();
    });

    it('should throw error for missing name', () => {
      expect(() =>
        createTool().description('Test').execute(async () => {})
      ).toThrow('Tool name is required');
    });
  });
});
