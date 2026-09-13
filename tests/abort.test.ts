import { describe, it, expect } from 'vitest';
import {
  abortableDelay,
  createAbortError,
  isAbortError,
  mergeAbortSignals,
  throwIfAborted,
} from '../src/utils/abort.js';
import { parseStream, LLMClient } from '../src/core/llm-client.js';
import { ToolExecutor, defineTool } from '../src/core/tool-executor.js';
import type { ToolCall } from '../src/core/types.js';
import { httpGetTool } from '../src/tools/http.js';
import { shellExecTool } from '../src/tools/shell.js';
import type { Stream } from 'openai/streaming';
import type OpenAI from 'openai';

async function expectAbort(promise: Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await promise;
  } catch (err) {
    threw = true;
    expect(
      isAbortError(err) ||
        (err instanceof Error && /abort/i.test(err.message + err.name))
    ).toBe(true);
  }
  expect(threw).toBe(true);
}

describe('abort helpers', () => {
  it('abortableDelay resolves after wait when not aborted', async () => {
    const start = Date.now();
    await abortableDelay(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });

  it('abortableDelay rejects immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expectAbort(abortableDelay(10_000, controller.signal));
  });

  it('abortableDelay rejects mid-wait when aborted (withRetry must not keep sleeping)', async () => {
    const controller = new AbortController();
    const start = Date.now();
    const pending = abortableDelay(10_000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expectAbort(pending);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('throwIfAborted throws after abort', () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow();
  });

  it('mergeAbortSignals aborts when any input aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = mergeAbortSignals(a.signal, b.signal);
    expect(merged.aborted).toBe(false);
    b.abort();
    expect(merged.aborted).toBe(true);
  });

  it('isAbortError detects AbortError name', () => {
    expect(isAbortError(createAbortError())).toBe(true);
    expect(isAbortError(new Error('other'))).toBe(false);
  });
});

describe('parseStream abort', () => {
  it('aborts mid-stream and stops consuming chunks', async () => {
    const controller = new AbortController();
    let aborted = false;
    const streamController = {
      abort: () => {
        aborted = true;
      },
    };

    async function* chunks() {
      yield {
        choices: [{ delta: { content: 'hello' }, finish_reason: null }],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
      await new Promise((r) => setTimeout(r, 5));
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : createAbortError();
      }
      yield {
        choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
    }

    const stream = Object.assign(chunks(), { controller: streamController }) as unknown as Stream<
      OpenAI.Chat.Completions.ChatCompletionChunk
    >;

    const pending = parseStream(stream, { signal: controller.signal });
    setTimeout(() => controller.abort(), 1);
    await expectAbort(pending);
    expect(aborted).toBe(true);
  });
});

describe('ToolExecutor abort', () => {
  it('reports abort when signal is already aborted', async () => {
    const executor = new ToolExecutor();

    executor.register(
      defineTool<{ n: number }, string>({
        name: 'slow',
        description: 'slow tool',
        parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
        execute: async () => 'ok',
      })
    );

    const ac = new AbortController();
    ac.abort();

    const toolCall: ToolCall = {
      id: 'c1',
      type: 'function',
      function: { name: 'slow', arguments: '{"n":1}' },
    };

    const result = await executor.execute(toolCall, { signal: ac.signal, useCache: false });
    expect(result.error).toMatch(/aborted/i);
  });

  it('passes live signal into tool.execute', async () => {
    const executor = new ToolExecutor();
    let received: AbortSignal | undefined;

    executor.register(
      defineTool<Record<string, never>, string>({
        name: 'capture',
        description: 'capture signal',
        parameters: { type: 'object', properties: {} },
        execute: async (_args, signal) => {
          received = signal;
          return 'done';
        },
      })
    );

    const ac = new AbortController();
    const toolCall: ToolCall = {
      id: 'c2',
      type: 'function',
      function: { name: 'capture', arguments: '{}' },
    };

    const result = await executor.execute(toolCall, { signal: ac.signal, useCache: false });
    expect(result.error).toBeUndefined();
    expect(received).toBe(ac.signal);
  });
});

describe('shell_exec abort', () => {
  it('kills child process when signal aborts', async () => {
    const controller = new AbortController();
    const pending = shellExecTool.execute(
      {
        command: 'sleep',
        args: ['30'],
        timeout: 60_000,
      },
      controller.signal
    );

    setTimeout(() => controller.abort(), 50);
    await expectAbort(pending);
  }, 10_000);
});

describe('http_get abort', () => {
  it('cancels fetch when signal aborts', async () => {
    const controller = new AbortController();

    const pending = httpGetTool.execute(
      {
        url: 'http://10.255.255.1:9/',
        timeout: 30_000,
      },
      controller.signal
    );

    setTimeout(() => controller.abort(), 30);
    await expectAbort(pending);
  }, 10_000);
});

describe('LLMClient createStream signal forwarding', () => {
  it('rejects immediately when signal is already aborted', async () => {
    const client = new LLMClient({ apiKey: 'test', baseURL: 'http://127.0.0.1:9/v1' });
    const controller = new AbortController();
    controller.abort();

    await expectAbort(
      client.createStream({
        model: 'test',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      })
    );
  });
});
