// Run with Vitest/Node: these tests assert node:http connection-close events.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingMiddleware, type MiddlewareContext } from '../src/utils/middleware.js';
import { defaultConfig } from '../src/core/types.js';
import { Agent } from '../src/core/agent.js';
import { LLMClient, parseStream } from '../src/core/llm-client.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function serve(handler: (response: ServerResponse, request: IncomingMessage) => void) {
  const server = createServer((request, response) => handler(response, request));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-test-only' };
}

function fail(response: ServerResponse) {
  response.writeHead(503, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'local upstream unavailable' } }));
}

function token(response: ServerResponse, content: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Agent request retry and cancellation contracts (real SDK, local HTTP)', () => {
  it.each([NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid maxRetries=%s before sending a request', async (maxRetries) => {
    let requests = 0;
    const llmConfig = await serve((response) => { requests++; fail(response); });
    expect(() => new Agent({ systemPrompt: 'test', llmConfig, config: { maxRetries } }))
      .toThrow('maxRetries must be a non-negative safe integer');
    expect(requests).toBe(0);
  });

  it('explicit undefined maxRetries retains the finite default retry budget', async () => {
    let requests = 0;
    const llmConfig = await serve((response) => { requests++; fail(response); });
    const agent = new Agent({ systemPrompt: 'test', llmConfig, config: { maxRetries: undefined, retryDelayMs: 0 } });
    // Bound a regressed implementation so this test cannot itself retry forever.
    const timeout = setTimeout(() => agent.abort(), 2000);
    try {
      await expect(agent.run('test')).rejects.toThrow('local upstream unavailable');
      expect(requests).toBe(defaultConfig.maxRetries + 1);
    } finally {
      clearTimeout(timeout);
    }
  });

  it.each(['success', 'exhausted', 'stream-error', 'middleware-error', 'completion-error', 'max-completion-error', 'event-error', 'error-hook-error', 'cancel-headers', 'cancel-stream', 'cancel-backoff'] as const)(
    'releases timing state after %s and dispatches error middleware once', async (stage) => {
      const timing = timingMiddleware();
      let context!: MiddlewareContext;
      let middlewareErrors = 0;
      let eventErrors = 0;
      let requests = 0;
      const started = deferred();
      let response!: ServerResponse;
      const llmConfig = await serve((res) => {
        requests++;
        response = res;
        if (stage === 'exhausted' || stage === 'cancel-backoff' || stage === 'event-error' || stage === 'error-hook-error') {
          res.once('finish', started.resolve);
          return fail(res);
        }
        if (stage === 'cancel-headers') { started.resolve(); return; }
        if (stage === 'max-completion-error') {
          const tool = { index: 0, id: 'call_local', type: 'function', function: { name: 'missing', arguments: '{}' } };
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [tool] } }] })}\n\ndata: [DONE]\n\n`);
          return;
        }
        token(res, 'ok');
        if (stage !== 'stream-error' && stage !== 'cancel-stream') res.end('data: [DONE]\n\n');
      });
      const agent = new Agent({
        systemPrompt: 'test', llmConfig,
        config: { maxRetries: 1, retryDelayMs: stage === 'cancel-backoff' ? 60_000 : 0, maxIterations: 1 },
        events: {
          onError: () => { eventErrors++; if (stage === 'event-error') throw new Error('event failed'); },
          onToken: () => { started.resolve(); if (stage === 'stream-error') response.destroy(); },
        },
        middlewares: [
          { name: 'capture', beforeRequest: async (ctx) => { context = ctx; },
            onComplete: async () => { if (stage === 'completion-error' || stage === 'max-completion-error') throw new Error('completion failed'); },
            onError: async () => { if (stage === 'error-hook-error') throw new Error('error hook failed'); } },
          timing,
          { name: 'observe', beforeRequest: async () => { if (stage === 'middleware-error') throw new Error('middleware failed'); },
            onError: async () => { middlewareErrors++; } },
        ],
      });
      const run = agent.run('test');
      const cancelled = stage.startsWith('cancel-');
      const outcome = stage === 'success' ? expect(run).resolves.toMatchObject({ response: 'ok' })
        : cancelled ? expect(run).rejects.toMatchObject({ name: 'AbortError' }) : expect(run).rejects.toThrow(stage === 'event-error' ? 'event failed' : stage === 'error-hook-error' ? 'error hook failed' : undefined);
      if (cancelled) {
        await started.promise;
        if (stage === 'cancel-backoff') await new Promise((resolve) => setTimeout(resolve, 50));
        agent.abort();
      }
      await outcome;
      expect(middlewareErrors).toBe(stage === 'success' ? 0 : 1);
      expect(eventErrors).toBe(stage === 'success' || cancelled ? 0 : 1);
      expect(requests).toBe(stage === 'middleware-error' ? 0 : ['exhausted', 'event-error', 'error-hook-error'].includes(stage) ? 2 : 1);
      if (stage === 'success') expect(context.metadata.timing).toBeDefined();
      // A retained timing entry would recreate metadata when this context is revisited.
      delete context.metadata.timing;
      await timing.onComplete!(context, { response: '', iterations: 1 });
      expect(context.metadata.timing).toBeUndefined();
      expect(agent.getStats().isRunning).toBe(false);
    },
  );

  it.each(['afterResponse', 'beforeToolCall', 'afterToolCall', 'duringTool'] as const)(
    'continue after cancellation at %s sends paired tool history', async (stage) => {
      let requests = 0;
      let executions = 0;
      let cancelOnce = true;
      let continuedMessages: Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string; content?: string }> = [];
      const llmConfig = await serve((response, request) => {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
          if (++requests === 1) {
            const tool = { index: 0, id: 'call_effect', type: 'function', function: { name: 'effect', arguments: '{}' } };
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [tool] } }] })}\n\ndata: [DONE]\n\n`);
            return;
          }
          continuedMessages = JSON.parse(body).messages;
          const unmatched = continuedMessages.some((message) => message.tool_calls?.some(
            (call) => !continuedMessages.some((result) => result.role === 'tool' && result.tool_call_id === call.id),
          ));
          if (unmatched) {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'missing tool result' } }));
            return;
          }
          token(response, 'continued');
          response.end('data: [DONE]\n\n');
        });
      });
      const agent = new Agent({ systemPrompt: 'test', llmConfig, config: { maxRetries: 0 } });
      const cancel = () => { if (cancelOnce) { cancelOnce = false; agent.abort(); } };
      agent.registerTool({
        name: 'effect', description: 'count effects', parameters: { type: 'object', properties: {} },
        execute: async () => { executions++; if (stage === 'duringTool') cancel(); return 'effect completed'; },
      });
      if (stage !== 'duringTool') agent.use({ name: 'cancel-once', [stage]: async () => { cancel(); } });
      await expect(agent.run('first')).rejects.toMatchObject({ name: 'AbortError' });
      await expect(agent.continue('continue')).resolves.toMatchObject({ response: 'continued' });
      const executed = stage === 'afterToolCall' || stage === 'duringTool';
      expect(executions).toBe(executed ? 1 : 0);
      if (executed) expect(continuedMessages).toContainEqual({ role: 'tool', tool_call_id: 'call_effect', content: 'effect completed' });
      expect(requests).toBe(2);
    },
  );

  it('settles running tools before rejecting a cancelled parallel batch', async () => {
    const running = deferred();
    const releaseTool = deferred();
    const releasePending = deferred();
    let pendingExecutions = 0;
    const llmConfig = await serve((response) => {
      const tool_calls = ['running', 'pending'].map((name, index) => ({
        index, id: `call_${name}`, type: 'function', function: { name, arguments: '{}' },
      }));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls } }] })}\n\ndata: [DONE]\n\n`);
    });
    const agent = new Agent({ systemPrompt: 'test', llmConfig });
    agent.registerTool({
      name: 'running', description: 'running effect', parameters: { type: 'object', properties: {} },
      execute: async () => { running.resolve(); await releaseTool.promise; return 'completed effect'; },
    });
    agent.registerTool({
      name: 'pending', description: 'pending effect', parameters: { type: 'object', properties: {} },
      execute: async () => { pendingExecutions++; return 'unexpected'; },
    });
    agent.use({ name: 'hold-pending', beforeToolCall: async (_ctx, call) => {
      if (call.function.name === 'pending') await releasePending.promise;
    } });
    const run = agent.run('test');
    const rejection = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await running.promise;
    agent.abort();
    releasePending.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    const stillRunning = agent.getStats().isRunning;
    releaseTool.resolve();
    await rejection;
    expect(stillRunning).toBe(true);
    expect(pendingExecutions).toBe(0);
    expect(agent.getMessages()).toContainEqual({ role: 'tool', tool_call_id: 'call_running', content: 'completed effect' });
    expect(agent.getMessages()).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'call_pending' }));
  });

  it.each([
    ['afterResponse', false],
    ['afterResponse', true],
    ['beforeToolCall', true],
    ['afterToolCall', true],
    ['onComplete', false],
    ['onComplete', true],
  ] as const)('abort during %s rejects after middleware returns (tools=%s)', async (stage, withTool) => {
    let executions = 0;
    const llmConfig = await serve((response) => {
      if (withTool) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const tool = { index: 0, id: 'call_local', type: 'function', function: { name: 'effect', arguments: '{}' } };
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [tool] } }] })}\n\n`);
      } else token(response, 'ok');
      response.end('data: [DONE]\n\n');
    });
    const agent = new Agent({ systemPrompt: 'test', llmConfig, config: { maxIterations: 1 } });
    agent.registerTool({
      name: 'effect', description: 'count side effects', parameters: { type: 'object', properties: {} },
      execute: async () => { executions++; return 'done'; },
    });
    agent.use({ name: 'abort-at-boundary', [stage]: async () => { agent.abort(); } });
    await expect(agent.run('test')).rejects.toMatchObject({ name: 'AbortError' });
    expect(executions).toBe(withTool && (stage === 'afterToolCall' || stage === 'onComplete') ? 1 : 0);
    expect(agent.getStats().isRunning).toBe(false);
  });

  it.each([0, 1, 3])('maxRetries=%s bounds actual HTTP requests and rejects without a new iteration', async (maxRetries) => {
    let requests = 0;
    let errors = 0;
    let middlewareErrors = 0;
    const llmConfig = await serve((response) => { requests++; fail(response); });
    const agent = new Agent({
      systemPrompt: 'test', llmConfig,
      config: { maxRetries, retryDelayMs: 0, maxIterations: 10 },
      events: { onError: () => { errors++; } },
      middlewares: [{ name: 'observe', onError: async () => { middlewareErrors++; } }],
    });
    await expect(agent.run('test')).rejects.toThrow('local upstream unavailable');
    expect(requests).toBe(maxRetries + 1);
    expect(errors).toBe(1);
    expect(middlewareErrors).toBe(1);
    expect(agent.getStats().isRunning).toBe(false);
    expect(agent.getMessages()).toHaveLength(2); // no recovery prompt appended
  });

  it('recovers within the retry budget and runs the configured middleware', async () => {
    let requests = 0;
    let beforeRequests = 0;
    const llmConfig = await serve((response) => {
      if (++requests === 1) return fail(response);
      token(response, 'ok');
      response.end('data: [DONE]\n\n');
    });
    const agent = new Agent({
      systemPrompt: 'test', llmConfig,
      config: { maxRetries: 1, retryDelayMs: 0 },
      middlewares: [{ name: 'observe', beforeRequest: async () => { beforeRequests++; } }],
    });
    const result = await agent.run('test');
    expect(result.response).toBe('ok');
    expect(result.iterations).toBe(1);
    expect(requests).toBe(2);
    expect(beforeRequests).toBe(1);
  });

  it('does not replay a stream after partial output and a transport failure', async () => {
    let requests = 0;
    let output = '';
    let response!: ServerResponse;
    const llmConfig = await serve((res) => { requests++; response = res; token(res, 'partial'); });
    const agent = new Agent({
      systemPrompt: 'test', llmConfig,
      config: { maxRetries: 3, retryDelayMs: 0 },
      events: { onToken: (text) => { output += text; response.destroy(); } },
    });
    await expect(agent.run('test')).rejects.toThrow();
    expect(output).toBe('partial');
    expect(requests).toBe(1);
    expect(agent.getMessages()).toHaveLength(2);
  });

  it.each(['headers', 'stream'] as const)('abort closes a hanging %s request and rejects without retry', async (stage) => {
    let requests = 0;
    const started = deferred();
    const closed = deferred();
    const llmConfig = await serve((response) => {
      requests++;
      response.once('close', closed.resolve);
      if (stage === 'headers') started.resolve();
      else token(response, 'partial'); // intentionally never finish the SSE response
    });
    const agent = new Agent({
      systemPrompt: 'test', llmConfig,
      config: { maxRetries: 3, retryDelayMs: 0 },
      events: { onToken: started.resolve },
    });
    const run = agent.run('test');
    const rejection = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    agent.abort();
    await rejection;
    await closed.promise;
    expect(requests).toBe(1);
    expect(agent.getStats().isRunning).toBe(false);
    expect(agent.getMessages()).toHaveLength(2);
  });

  it('abort interrupts retry backoff without another HTTP request', async () => {
    let requests = 0;
    const failed = deferred();
    const llmConfig = await serve((response) => {
      requests++;
      response.once('finish', failed.resolve);
      fail(response);
    });
    const agent = new Agent({
      systemPrompt: 'test', llmConfig,
      config: { maxRetries: 3, retryDelayMs: 60_000 },
    });
    const run = agent.run('test');
    const rejection = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await failed.promise;
    // Allow the SDK to process the failed response and enter backoff.
    await new Promise((resolve) => setTimeout(resolve, 50));
    agent.abort();
    await rejection;
    expect(requests).toBe(1);
  });

  it('parseStream cancels a stalled SDK stream with its own consumer signal', async () => {
    const started = deferred();
    const closed = deferred();
    const llmConfig = await serve((response) => {
      response.once('close', closed.resolve);
      token(response, 'partial');
    });
    const client = new LLMClient(llmConfig);
    const stream = await client.createStream({ model: 'test', messages: [] });
    const controller = new AbortController();
    const parsed = parseStream(stream, { onToken: started.resolve }, controller.signal);
    const rejection = expect(parsed).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    controller.abort();
    await rejection;
    await closed.promise;
    expect(stream.controller.signal.aborted).toBe(true);
  });

  it('non-streaming LLMClient.create forwards cancellation to the real SDK', async () => {
    const started = deferred();
    const closed = deferred();
    let requests = 0;
    const llmConfig = await serve((response) => {
      requests++;
      response.once('close', closed.resolve);
      started.resolve();
    });
    const client = new LLMClient(llmConfig);
    const controller = new AbortController();
    const request = client.create({ model: 'test', messages: [], signal: controller.signal });
    const rejection = expect(request).rejects.toThrow();
    await started.promise;
    controller.abort();
    await rejection;
    await closed.promise;
    expect(requests).toBe(1);
  });
});
