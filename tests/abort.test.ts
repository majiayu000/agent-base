import { describe, it, expect, vi } from 'vitest';
import {
  abortableDelay,
  createAbortError,
  isAbortError,
  mergeAbortSignals,
  throwIfAborted,
} from '../src/utils/abort.js';
import { parseStream, LLMClient } from '../src/core/llm-client.js';
import { ToolExecutor, defineTool } from '../src/core/tool-executor.js';
import { Agent } from '../src/core/agent.js';
import type { ToolCall } from '../src/core/types.js';
import { httpGetTool } from '../src/tools/http.js';
import { shellExecTool, shellRunTool, killActiveShellChildren } from '../src/tools/shell.js';
import { deleteTool, listDirectoryTool, writeFileTool } from '../src/tools/filesystem.js';
import type { Stream } from 'openai/streaming';
import type OpenAI from 'openai';
import { createServer, type AddressInfo } from 'http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
    expect(merged.signal.aborted).toBe(false);
    b.abort();
    expect(merged.signal.aborted).toBe(true);
  });

  it('mergeAbortSignals fallback dispose removes unused source listeners', () => {
    const abortSignalAny = (
      AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal }
    ).any;
    const a = new AbortController();
    const b = new AbortController();

    // Force the manual fallback path even on runtimes that have AbortSignal.any.
    (
      AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal }
    ).any = undefined;

    try {
      const merged = mergeAbortSignals(a.signal, b.signal);
      expect(merged.signal.aborted).toBe(false);
      merged.dispose();
      // After dispose, aborting sources must not affect the merged signal.
      a.abort();
      expect(merged.signal.aborted).toBe(false);
    } finally {
      (
        AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal }
      ).any = abortSignalAny;
    }
  });

  it('mergeAbortSignals fallback removes listeners attached before an already-aborted source', () => {
    const abortSignalAny = (
      AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal }
    ).any;
    const a = new AbortController();
    const b = new AbortController();
    b.abort();

    (
      AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal }
    ).any = undefined;

    let attached = 0;
    const origAdd = a.signal.addEventListener.bind(a.signal);
    const origRemove = a.signal.removeEventListener.bind(a.signal);
    a.signal.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      if (type === 'abort') attached++;
      return origAdd(type, listener, options);
    }) as typeof a.signal.addEventListener;
    a.signal.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions
    ) => {
      if (type === 'abort') attached--;
      return origRemove(type, listener, options);
    }) as typeof a.signal.removeEventListener;

    try {
      const merged = mergeAbortSignals(a.signal, b.signal);
      expect(merged.signal.aborted).toBe(true);
      // Early return must detach listeners already attached to the live source.
      expect(attached).toBe(0);
    } finally {
      (
        AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal }
      ).any = abortSignalAny;
    }
  });

  it('isAbortError detects AbortError name', () => {
    expect(isAbortError(createAbortError())).toBe(true);
    expect(isAbortError(new Error('other'))).toBe(false);
  });

  it('isAbortError does not treat TimeoutError as abort', () => {
    const timeout =
      typeof DOMException !== 'undefined'
        ? new DOMException('The operation was aborted due to timeout', 'TimeoutError')
        : Object.assign(new Error('The operation was aborted due to timeout'), {
            name: 'TimeoutError',
          });
    expect(isAbortError(timeout)).toBe(false);
  });

  it('isAbortError does not treat abort-shaped messages without AbortError name', () => {
    expect(isAbortError(new Error('transaction aborted due to conflict'))).toBe(false);
    expect(isAbortError(new Error('request was aborted by the peer'))).toBe(false);
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

  it('rejects when abort fires while handling the final chunk', async () => {
    const controller = new AbortController();
    let aborted = false;
    const streamController = {
      abort: () => {
        aborted = true;
      },
    };

    async function* chunks() {
      yield {
        choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
    }

    const stream = Object.assign(chunks(), { controller: streamController }) as unknown as Stream<
      OpenAI.Chat.Completions.ChatCompletionChunk
    >;

    const pending = parseStream(stream, {
      signal: controller.signal,
      onToken: () => {
        controller.abort();
      },
    });

    await expectAbort(pending);
    expect(aborted).toBe(true);
  });

  it('stops processing later fields in the same chunk after onThinking aborts', async () => {
    const controller = new AbortController();
    let aborted = false;
    let onTokenCount = 0;
    const streamController = {
      abort: () => {
        aborted = true;
      },
    };

    async function* chunks() {
      yield {
        choices: [
          {
            delta: {
              thinking: 'plan',
              content: 'should-not-reach',
            } as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta,
            finish_reason: null,
          },
        ],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
    }

    const stream = Object.assign(chunks(), { controller: streamController }) as unknown as Stream<
      OpenAI.Chat.Completions.ChatCompletionChunk
    >;

    const pending = parseStream(stream, {
      signal: controller.signal,
      onThinking: () => {
        controller.abort();
      },
      onToken: () => {
        onTokenCount += 1;
      },
    });

    await expectAbort(pending);
    expect(aborted).toBe(true);
    expect(onTokenCount).toBe(0);
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
    // Use the current runtime binary so the long-running child works on
    // Windows (no Unix-only `sleep` executable) as well as POSIX.
    const pending = shellExecTool.execute(
      {
        command: process.execPath,
        args: ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000)'],
        timeout: 60_000,
      },
      controller.signal
    );

    setTimeout(() => controller.abort(), 50);
    await expectAbort(pending);
  }, 10_000);

  it('killActiveShellChildren terminates tracked detached groups without abort', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const pidFile = join(tmpdir(), `agent-base-active-kill-${Date.now()}-${process.pid}.pid`);
    const pending = shellRunTool.execute({
      script: `sleep 60 & echo $! > "${pidFile}"; wait`,
      timeout: 60_000,
    });

    try {
      const started = Date.now();
      while (!existsSync(pidFile) && Date.now() - started < 3000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(existsSync(pidFile)).toBe(true);
      const childPid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isFinite(childPid) && childPid > 0).toBe(true);

      killActiveShellChildren();

      const result = await pending;
      expect(result.exitCode).not.toBe(0);

      // Grandchild should be gone after synchronous process-group cleanup.
      const gone = Date.now();
      let alive = true;
      while (Date.now() - gone < 3000) {
        try {
          process.kill(childPid, 0);
          await new Promise((r) => setTimeout(r, 20));
        } catch {
          alive = false;
          break;
        }
      }
      expect(alive).toBe(false);
    } finally {
      try {
        unlinkSync(pidFile);
      } catch {
        // best-effort cleanup of temp pid file
      }
    }
  }, 10_000);
});

describe('shell_run abort', () => {
  it('terminates descendant process tree when signal aborts', async () => {
    if (process.platform === 'win32') {
      // Process-tree kill uses taskkill; this PID-file check is POSIX-oriented.
      return;
    }

    const controller = new AbortController();
    const pidFile = join(tmpdir(), `agent-base-tree-kill-${Date.now()}-${process.pid}.pid`);

    try {
      const pending = shellRunTool.execute(
        {
          // Start a long-lived grandchild, record its PID, then wait on it.
          script: `sleep 60 & echo $! > "${pidFile}"; wait`,
          timeout: 60_000,
        },
        controller.signal
      );

      // Wait until the grandchild PID is recorded
      const started = Date.now();
      while (!existsSync(pidFile) && Date.now() - started < 3000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(existsSync(pidFile)).toBe(true);
      const childPid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isFinite(childPid) && childPid > 0).toBe(true);

      controller.abort();
      await expectAbort(pending);

      // Give the kernel a moment to reap the process group
      await new Promise((r) => setTimeout(r, 200));
      let stillAlive = false;
      try {
        process.kill(childPid, 0);
        stillAlive = true;
      } catch (err) {
        // ESRCH means the process is gone — expected after tree kill.
        stillAlive = false;
        void err;
      }
      expect(stillAlive).toBe(false);
    } finally {
      try {
        unlinkSync(pidFile);
      } catch (err) {
        void err;
      }
    }
  }, 10_000);

  it('escalates to SIGKILL when a descendant ignores SIGTERM after the leader exits', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const controller = new AbortController();
    const pidFile = join(tmpdir(), `agent-base-sigkill-esc-${Date.now()}-${process.pid}.pid`);

    try {
      const pending = shellRunTool.execute(
        {
          // Grandchild ignores SIGTERM; wrapper exits on abort SIGTERM so the
          // old hasExited gate would skip SIGKILL and leave this alive.
          script: `(trap '' TERM; sleep 60) & echo $! > "${pidFile}"; wait`,
          timeout: 60_000,
        },
        controller.signal
      );

      const started = Date.now();
      while (!existsSync(pidFile) && Date.now() - started < 3000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(existsSync(pidFile)).toBe(true);
      const childPid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isFinite(childPid) && childPid > 0).toBe(true);

      controller.abort();
      await expectAbort(pending);

      // Wait past KILL_ESCALATION_MS (5s) for SIGKILL against the process group.
      await new Promise((r) => setTimeout(r, 5500));
      let stillAlive = false;
      try {
        process.kill(childPid, 0);
        stillAlive = true;
      } catch (err) {
        stillAlive = false;
        void err;
      }
      expect(stillAlive).toBe(false);
    } finally {
      try {
        unlinkSync(pidFile);
      } catch (err) {
        void err;
      }
    }
  }, 20_000);
});

describe('http_get abort', () => {
  it('cancels fetch when signal aborts', async () => {
    // Local server that accepts the connection but never responds — avoids
    // environment-flaky unreachable IPs / blocked ports rejecting before abort.
    const server = createServer((_req, _res) => {
      // intentionally hang
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;

    const controller = new AbortController();
    const pending = httpGetTool.execute(
      {
        url: `http://127.0.0.1:${port}/`,
        timeout: 30_000,
      },
      controller.signal
    );

    setTimeout(() => controller.abort(), 30);
    try {
      await expectAbort(pending);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }, 10_000);
});

describe('filesystem abort', () => {
  it('rejects write_file when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const target = join(tmpdir(), `agent-base-fs-abort-${Date.now()}.txt`);
    await expectAbort(
      writeFileTool.execute(
        { path: target, content: 'should-not-write' },
        controller.signal
      )
    );
    expect(existsSync(target)).toBe(false);
  });

  it('preserves existing file contents when write_file aborts after temp write', async () => {
    const fsPromises = await import('fs/promises');
    const target = join(tmpdir(), `agent-base-fs-atomic-${Date.now()}-${process.pid}.txt`);
    writeFileSync(target, 'original-content');
    const controller = new AbortController();

    const realWriteFile = fsPromises.writeFile.bind(fsPromises);
    const spy = vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (path, data, options) => {
      await realWriteFile(path, data as never);
      // Simulate abort winning after the temp file was written but before rename.
      controller.abort();
    });

    try {
      await expectAbort(
        writeFileTool.execute(
          { path: target, content: 'new-content-should-not-land' },
          controller.signal
        )
      );
      expect(readFileSync(target, 'utf8')).toBe('original-content');
    } finally {
      spy.mockRestore();
      unlinkSync(target);
    }
  });

  it('preserves existing file mode when write_file replaces a file', async () => {
    const { statSync } = await import('fs');
    const target = join(tmpdir(), `agent-base-fs-mode-${Date.now()}-${process.pid}.sh`);
    writeFileSync(target, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    const beforeMode = statSync(target).mode & 0o777;

    try {
      await writeFileTool.execute({ path: target, content: '#!/bin/sh\necho replaced\n' });
      const afterMode = statSync(target).mode & 0o777;
      expect(afterMode).toBe(beforeMode);
      expect(readFileSync(target, 'utf8')).toContain('replaced');
    } finally {
      unlinkSync(target);
    }
  });

  it('keeps the destination until Windows-style replace commits', async () => {
    const fsPromises = await import('fs/promises');
    const target = join(tmpdir(), `agent-base-fs-winreplace-${Date.now()}-${process.pid}.txt`);
    writeFileSync(target, 'original-content');

    const realRename = fsPromises.rename.bind(fsPromises);
    let renameAttempts = 0;
    const spy = vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      renameAttempts += 1;
      // First rename(tmp → dest) fails as on Windows when dest exists.
      if (renameAttempts === 1) {
        const err = new Error('EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realRename(from, to);
    });

    try {
      await writeFileTool.execute({ path: target, content: 'replacement-content' });
      expect(readFileSync(target, 'utf8')).toBe('replacement-content');
      // Move-aside + commit + optional bak cleanup ⇒ at least 2 renames, never unlink-first.
      expect(renameAttempts).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
      unlinkSync(target);
    }
  });

  it('rejects write_file when the destination is a directory', async () => {
    const dir = join(tmpdir(), `agent-base-fs-dir-${Date.now()}-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keep.txt'), 'keep');

    try {
      await expect(
        writeFileTool.execute({ path: dir, content: 'should-not-replace-dir' })
      ).rejects.toThrow(/directory/i);
      expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
      expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('keep');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes through a symlink to the target file without replacing the link', async () => {
    const { lstatSync, readlinkSync } = await import('fs');
    const base = join(tmpdir(), `agent-base-fs-symlink-write-${Date.now()}-${process.pid}`);
    mkdirSync(base, { recursive: true });
    const target = join(base, 'target.txt');
    const link = join(base, 'link.txt');
    writeFileSync(target, 'via-symlink-original');

    try {
      try {
        symlinkSync(target, link);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES') {
          return; // unprivileged Windows — skip rather than fail the suite
        }
        throw err;
      }

      const beforeLink = readlinkSync(link);
      await writeFileTool.execute({ path: link, content: 'via-symlink-updated' });
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(beforeLink);
      expect(readFileSync(target, 'utf8')).toBe('via-symlink-updated');
      expect(readFileSync(link, 'utf8')).toBe('via-symlink-updated');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('uses distinct exclusive temp paths for parallel write_file calls', async () => {
    const fsPromises = await import('fs/promises');
    const target = join(tmpdir(), `agent-base-fs-parallel-${Date.now()}-${process.pid}.txt`);
    writeFileSync(target, 'seed');

    const opened = new Set<string>();
    const realOpen = fsPromises.open.bind(fsPromises);
    const spy = vi.spyOn(fsPromises, 'open').mockImplementation(async (p, flags, mode) => {
      const pathStr = String(p);
      if (typeof flags === 'string' && flags.includes('x') && pathStr.endsWith('.tmp')) {
        if (opened.has(pathStr)) {
          const err = new Error('EEXIST') as NodeJS.ErrnoException;
          err.code = 'EEXIST';
          throw err;
        }
        opened.add(pathStr);
      }
      return realOpen(p, flags as never, mode as never);
    });

    try {
      await Promise.all([
        writeFileTool.execute({ path: target, content: 'writer-a' }),
        writeFileTool.execute({ path: target, content: 'writer-b' }),
      ]);
      expect(opened.size).toBeGreaterThanOrEqual(2);
      const final = readFileSync(target, 'utf8');
      expect(final === 'writer-a' || final === 'writer-b').toBe(true);
    } finally {
      spy.mockRestore();
      unlinkSync(target);
    }
  });

  it('rejects list_directory when aborted between recursive entries', async () => {
    const controller = new AbortController();
    // Abort immediately so the first throwIfAborted in listDir fires.
    controller.abort();
    await expectAbort(
      listDirectoryTool.execute(
        { path: process.cwd(), recursive: true },
        controller.signal
      )
    );
  });

  it('rejects recursive delete_path when aborted between entries', async () => {
    const root = join(tmpdir(), `agent-base-rm-abort-${Date.now()}-${process.pid}`);
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'a');
    writeFileSync(join(root, 'nested', 'b.txt'), 'b');

    const controller = new AbortController();
    controller.abort();

    try {
      await expectAbort(
        deleteTool.execute({ path: root, recursive: true }, controller.signal)
      );
      // Pre-abort should leave the tree intact.
      expect(existsSync(join(root, 'a.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('unlinks a directory symlink without deleting the target contents', async () => {
    const base = join(tmpdir(), `agent-base-rm-symlink-${Date.now()}-${process.pid}`);
    const target = join(base, 'target');
    const link = join(base, 'link');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'keep.txt'), 'keep');

    // Windows without SeCreateSymbolicLinkPrivilege cannot create dir symlinks;
    // junctions work without elevation. Skip only when neither is available.
    try {
      if (process.platform === 'win32') {
        symlinkSync(target, link, 'junction');
      } else {
        symlinkSync(target, link);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        rmSync(base, { recursive: true, force: true });
        return;
      }
      rmSync(base, { recursive: true, force: true });
      throw err;
    }

    try {
      const result = await deleteTool.execute({ path: link, recursive: true });
      expect(result.deleted).toBe(true);
      expect(existsSync(link)).toBe(false);
      expect(existsSync(join(target, 'keep.txt'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
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

describe('Agent abort path regressions', () => {
  it('reports abort when onError calls Agent.abort on the final iteration', async () => {
    const agent = new Agent({
      systemPrompt: 'test',
      config: { maxIterations: 1, maxRetries: 1, retryDelayMs: 1 },
      llmConfig: { apiKey: 'test', baseURL: 'http://127.0.0.1:9/v1' },
      events: {
        onError: () => {
          agent.abort();
        },
      },
    });

    const createStream = vi
      .spyOn(LLMClient.prototype, 'createStream')
      .mockRejectedValue(new Error('upstream failure'));

    try {
      const result = await agent.run('hello');
      expect(result.response).toBe('Agent run was aborted.');
      expect(result.maxIterationsReached).toBe(false);
    } finally {
      createStream.mockRestore();
    }
  });

  it('skips tool callbacks after abort and pairs synthetic cancel results', async () => {
    let beforeToolCallCount = 0;
    let onToolCallCount = 0;

    const agent = new Agent({
      systemPrompt: 'test',
      config: { maxIterations: 1, maxRetries: 1, retryDelayMs: 1 },
      llmConfig: { apiKey: 'test', baseURL: 'http://127.0.0.1:9/v1' },
      events: {
        onIteration: () => {
          agent.abort();
        },
        onToolCall: () => {
          onToolCallCount += 1;
        },
      },
      middlewares: [
        {
          beforeToolCall: async (_ctx, toolCall) => {
            beforeToolCallCount += 1;
            return toolCall;
          },
        },
      ],
    });

    agent.registerTool(
      defineTool({
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'should-not-run',
      })
    );

    async function* chunks() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'echo', arguments: '{}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
      yield {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
    }

    const createStream = vi.spyOn(LLMClient.prototype, 'createStream').mockResolvedValue(
      Object.assign(chunks(), {
        controller: { abort: () => {} },
      }) as unknown as Stream<OpenAI.Chat.Completions.ChatCompletionChunk>
    );

    try {
      const result = await agent.run('hello');
      expect(result.response).toBe('Agent run was aborted.');
      expect(beforeToolCallCount).toBe(0);
      expect(onToolCallCount).toBe(0);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.error).toMatch(/aborted/i);

      const messages = agent.getMessages();
      const toolMessages = messages.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.tool_call_id).toBe('call_1');
    } finally {
      createStream.mockRestore();
    }
  });

  it('skips post-beforeToolCall callbacks when aborted during middleware', async () => {
    let onToolCallCount = 0;
    let onToolResultCount = 0;
    let afterToolCallCount = 0;
    let toolExecuted = false;

    const agent = new Agent({
      systemPrompt: 'test',
      config: { maxIterations: 1, maxRetries: 1, retryDelayMs: 1 },
      llmConfig: { apiKey: 'test', baseURL: 'http://127.0.0.1:9/v1' },
      events: {
        onToolCall: () => {
          onToolCallCount += 1;
        },
        onToolResult: () => {
          onToolResultCount += 1;
        },
      },
      middlewares: [
        {
          beforeToolCall: async (_ctx, toolCall) => {
            agent.abort();
            return toolCall;
          },
          afterToolCall: async (_ctx, result) => {
            afterToolCallCount += 1;
            return result;
          },
        },
      ],
    });

    agent.registerTool(
      defineTool({
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          toolExecuted = true;
          return 'should-not-run';
        },
      })
    );

    async function* chunks() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_pre',
                  function: { name: 'echo', arguments: '{}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
      yield {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
    }

    const createStream = vi.spyOn(LLMClient.prototype, 'createStream').mockResolvedValue(
      Object.assign(chunks(), {
        controller: { abort: () => {} },
      }) as unknown as Stream<OpenAI.Chat.Completions.ChatCompletionChunk>
    );

    try {
      const result = await agent.run('hello');
      expect(result.response).toBe('Agent run was aborted.');
      expect(onToolCallCount).toBe(0);
      expect(onToolResultCount).toBe(0);
      expect(afterToolCallCount).toBe(0);
      expect(toolExecuted).toBe(false);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.error).toMatch(/aborted/i);

      const messages = agent.getMessages();
      const toolMessages = messages.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.tool_call_id).toBe('call_pre');
    } finally {
      createStream.mockRestore();
    }
  });

  it('skips afterToolCall/onToolResult when aborted during ToolExecutor.execute', async () => {
    let onToolResultCount = 0;
    let afterToolCallCount = 0;
    let toolStarted = false;

    const agent = new Agent({
      systemPrompt: 'test',
      config: { maxIterations: 1, maxRetries: 1, retryDelayMs: 1 },
      llmConfig: { apiKey: 'test', baseURL: 'http://127.0.0.1:9/v1' },
      events: {
        onToolResult: () => {
          onToolResultCount += 1;
        },
      },
      middlewares: [
        {
          afterToolCall: async (_ctx, result) => {
            afterToolCallCount += 1;
            return result;
          },
        },
      ],
    });

    agent.registerTool(
      defineTool({
        name: 'slow',
        description: 'slow',
        parameters: { type: 'object', properties: {} },
        execute: async (_args, signal) => {
          toolStarted = true;
          agent.abort();
          // Simulate ToolExecutor seeing an abort mid-flight.
          throwIfAborted(signal);
          return 'should-not-complete';
        },
      })
    );

    async function* chunks() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_exec',
                  function: { name: 'slow', arguments: '{}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
      yield {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
    }

    const createStream = vi.spyOn(LLMClient.prototype, 'createStream').mockResolvedValue(
      Object.assign(chunks(), {
        controller: { abort: () => {} },
      }) as unknown as Stream<OpenAI.Chat.Completions.ChatCompletionChunk>
    );

    try {
      const result = await agent.run('hello');
      expect(result.response).toBe('Agent run was aborted.');
      expect(toolStarted).toBe(true);
      expect(onToolResultCount).toBe(0);
      expect(afterToolCallCount).toBe(0);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.error).toMatch(/aborted/i);

      const messages = agent.getMessages();
      const toolMessages = messages.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.tool_call_id).toBe('call_exec');
    } finally {
      createStream.mockRestore();
    }
  });

  it('skips onToolResult when afterToolCall middleware aborts', async () => {
    let onToolResultCount = 0;
    let afterToolCallCount = 0;

    const agent = new Agent({
      systemPrompt: 'test',
      config: { maxIterations: 1, maxRetries: 1, retryDelayMs: 1 },
      llmConfig: { apiKey: 'test', baseURL: 'http://127.0.0.1:9/v1' },
      events: {
        onToolResult: () => {
          onToolResultCount += 1;
        },
      },
      middlewares: [
        {
          afterToolCall: async (_ctx, result) => {
            afterToolCallCount += 1;
            agent.abort();
            return result;
          },
        },
      ],
    });

    agent.registerTool(
      defineTool({
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'ok',
      })
    );

    async function* chunks() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_after',
                  function: { name: 'echo', arguments: '{}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
      yield {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
    }

    const createStream = vi.spyOn(LLMClient.prototype, 'createStream').mockResolvedValue(
      Object.assign(chunks(), {
        controller: { abort: () => {} },
      }) as unknown as Stream<OpenAI.Chat.Completions.ChatCompletionChunk>
    );

    try {
      const result = await agent.run('hello');
      expect(result.response).toBe('Agent run was aborted.');
      expect(afterToolCallCount).toBe(1);
      expect(onToolResultCount).toBe(0);
      expect(result.toolCalls).toHaveLength(1);

      const messages = agent.getMessages();
      const toolMessages = messages.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.tool_call_id).toBe('call_after');
    } finally {
      createStream.mockRestore();
    }
  });

  it('does not treat abort-shaped LLM errors as cancellation when the run signal is live', async () => {
    const agent = new Agent({
      systemPrompt: 'test',
      config: { maxIterations: 1, maxRetries: 1, retryDelayMs: 1 },
      llmConfig: { apiKey: 'test', baseURL: 'http://127.0.0.1:9/v1' },
    });

    const createStream = vi
      .spyOn(LLMClient.prototype, 'createStream')
      .mockRejectedValue(new Error('transaction aborted due to conflict'));

    try {
      const result = await agent.run('hello');
      expect(result.response).not.toBe('Agent run was aborted.');
      expect(result.maxIterationsReached).toBe(true);
    } finally {
      createStream.mockRestore();
    }
  });

  it('does not treat bare AbortError as cancellation when the run signal is live', async () => {
    const agent = new Agent({
      systemPrompt: 'test',
      config: { maxIterations: 1, maxRetries: 1, retryDelayMs: 1 },
      llmConfig: { apiKey: 'test', baseURL: 'http://127.0.0.1:9/v1' },
    });

    const createStream = vi
      .spyOn(LLMClient.prototype, 'createStream')
      .mockRejectedValue(createAbortError('sdk-internal cancel'));

    try {
      const result = await agent.run('hello');
      expect(result.response).not.toBe('Agent run was aborted.');
      expect(result.maxIterationsReached).toBe(true);
    } finally {
      createStream.mockRestore();
    }
  });

  it('pairs tool results when beforeToolCall middleware rejects after abort', async () => {
    let agent!: Agent;
    agent = new Agent({
      systemPrompt: 'test',
      config: { maxIterations: 1, maxRetries: 1, retryDelayMs: 1 },
      llmConfig: { apiKey: 'test', baseURL: 'http://127.0.0.1:9/v1' },
      middlewares: [
        {
          beforeToolCall: async () => {
            agent.abort();
            throw createAbortError('middleware rejected after abort');
          },
        },
      ],
    });

    agent.registerTool(
      defineTool({
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'should-not-run',
      })
    );

    async function* chunks() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_mw_abort',
                  function: { name: 'echo', arguments: '{}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
      yield {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
    }

    const createStream = vi.spyOn(LLMClient.prototype, 'createStream').mockResolvedValue(
      Object.assign(chunks(), {
        controller: { abort: () => {} },
      }) as unknown as Stream<OpenAI.Chat.Completions.ChatCompletionChunk>
    );

    try {
      const result = await agent.run('hello');
      expect(result.response).toBe('Agent run was aborted.');
      const messages = agent.getMessages();
      const toolMsgs = messages.filter((m) => m.role === 'tool');
      expect(toolMsgs).toHaveLength(1);
      expect(toolMsgs[0]?.tool_call_id).toBe('call_mw_abort');
    } finally {
      createStream.mockRestore();
    }
  });

  it('reports abort when aborted during onComplete middleware (tool-free run)', async () => {
    let agent!: Agent;
    agent = new Agent({
      systemPrompt: 'test',
      config: { maxIterations: 2, maxRetries: 1, retryDelayMs: 1 },
      llmConfig: { apiKey: 'test', baseURL: 'http://127.0.0.1:9/v1' },
      middlewares: [
        {
          onComplete: async () => {
            agent.abort();
            await new Promise((resolve) => setTimeout(resolve, 5));
          },
        },
      ],
    });

    async function* chunks() {
      yield {
        choices: [{ delta: { role: 'assistant', content: 'done without tools' }, finish_reason: null }],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
      yield {
        choices: [{ delta: {}, finish_reason: 'stop' }],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
    }

    const createStream = vi.spyOn(LLMClient.prototype, 'createStream').mockResolvedValue(
      Object.assign(chunks(), {
        controller: { abort: () => {} },
      }) as unknown as Stream<OpenAI.Chat.Completions.ChatCompletionChunk>
    );

    try {
      const result = await agent.run('hello');
      expect(result.response).toBe('Agent run was aborted.');
    } finally {
      createStream.mockRestore();
    }
  });

  it('pairs tool_calls when onError aborts after a tool-bearing assistant message', async () => {
    const agent = new Agent({
      systemPrompt: 'test',
      config: { maxIterations: 1, maxRetries: 1, retryDelayMs: 1 },
      llmConfig: { apiKey: 'test', baseURL: 'http://127.0.0.1:9/v1' },
      events: {
        onError: () => {
          agent.abort();
        },
      },
      middlewares: [
        {
          afterResponse: async () => {
            throw new Error('afterResponse boom');
          },
        },
      ],
    });

    async function* chunks() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_onerror_pair',
                  function: { name: 'echo', arguments: '{}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
      yield {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
    }

    const createStream = vi.spyOn(LLMClient.prototype, 'createStream').mockResolvedValue(
      Object.assign(chunks(), {
        controller: { abort: () => {} },
      }) as unknown as Stream<OpenAI.Chat.Completions.ChatCompletionChunk>
    );

    try {
      const result = await agent.run('hello');
      expect(result.response).toBe('Agent run was aborted.');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.error).toMatch(/aborted/i);

      const toolMessages = agent.getMessages().filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.tool_call_id).toBe('call_onerror_pair');
    } finally {
      createStream.mockRestore();
    }
  });

  it('retains completed sibling tool results when another rejects after abort', async () => {
    let agent!: Agent;
    agent = new Agent({
      systemPrompt: 'test',
      config: { maxIterations: 1, maxRetries: 1, retryDelayMs: 1 },
      llmConfig: { apiKey: 'test', baseURL: 'http://127.0.0.1:9/v1' },
      middlewares: [
        {
          afterToolCall: async (_ctx, execResult) => {
            if (execResult.toolName === 'slow') {
              agent.abort();
              throw new Error('canceled sibling middleware');
            }
            return execResult;
          },
        },
      ],
    });

    agent.registerTool(
      defineTool({
        name: 'fast',
        description: 'fast',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'fast-ok',
      })
    );
    agent.registerTool(
      defineTool({
        name: 'slow',
        description: 'slow',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          await new Promise((r) => setTimeout(r, 20));
          return 'slow-ok';
        },
      })
    );

    async function* chunks() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_fast',
                  function: { name: 'fast', arguments: '{}' },
                },
                {
                  index: 1,
                  id: 'call_slow',
                  function: { name: 'slow', arguments: '{}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
      yield {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      } as OpenAI.Chat.Completions.ChatCompletionChunk;
    }

    const createStream = vi.spyOn(LLMClient.prototype, 'createStream').mockResolvedValue(
      Object.assign(chunks(), {
        controller: { abort: () => {} },
      }) as unknown as Stream<OpenAI.Chat.Completions.ChatCompletionChunk>
    );

    try {
      const result = await agent.run('hello');
      expect(result.response).toBe('Agent run was aborted.');
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls.find((t) => t.name === 'fast')?.result).toBe('fast-ok');
      expect(result.toolCalls.find((t) => t.name === 'slow')?.error).toMatch(/aborted|canceled/i);

      const toolMessages = agent.getMessages().filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(2);
      expect(toolMessages.map((m) => m.tool_call_id).sort()).toEqual(['call_fast', 'call_slow']);
    } finally {
      createStream.mockRestore();
    }
  });
});
