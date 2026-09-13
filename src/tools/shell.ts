import { spawn, type ChildProcess } from 'child_process';
import { defineTool } from '../core/tool-executor.js';
import { createAbortError, throwIfAborted } from '../utils/abort.js';

// ============================================================================
// Shell Command Tools
// ============================================================================

export interface ShellResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  killed: boolean;
}

const KILL_ESCALATION_MS = 5000;

/** Active detached shell children — cleaned up on parent process exit. */
const activeChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function trackChild(child: ChildProcess): void {
  activeChildren.add(child);
  const untrack = () => {
    activeChildren.delete(child);
  };
  child.once('close', untrack);
  child.once('error', untrack);
  installExitHook();
}

/**
 * Synchronously terminate every tracked shell process tree.
 * Used on parent shutdown where async SIGKILL escalation cannot run.
 */
export function killActiveShellChildren(): void {
  for (const child of [...activeChildren]) {
    killProcessTree(child, 'SIGTERM');
    killProcessTree(child, 'SIGKILL');
    activeChildren.delete(child);
  }
}

function installExitHook(): void {
  if (exitHookInstalled || typeof process === 'undefined' || typeof process.on !== 'function') {
    return;
  }
  exitHookInstalled = true;

  // process.exit / normal exit: kill detached groups the parent would otherwise orphan.
  process.on('exit', () => {
    killActiveShellChildren();
  });

  // Default SIGINT/SIGTERM do not always reach detached POSIX process groups, and
  // relying on `exit` alone is insufficient for library consumers that never
  // install their own handlers (unlike src/cli.ts). Clean up on those signals;
  // if we replaced the default handler (no prior listeners), restore exit.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const hadPriorListeners = process.listenerCount(signal) > 0;
    process.on(signal, () => {
      killActiveShellChildren();
      if (!hadPriorListeners && process.listenerCount(signal) === 1) {
        // We are the only listener — restore conventional default exit codes.
        const code = signal === 'SIGINT' ? 130 : 143;
        process.exit(code);
      }
    });
  }
}

function hasExited(child: ChildProcess): boolean {
  // exitCode/signalCode are set when the process exits; child.killed is true as
  // soon as a kill signal was *sent*, which must not skip SIGKILL escalation.
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * True when the POSIX process group still has at least one member.
 * Used after the group leader exits so we can still escalate against orphans.
 */
function processGroupExists(pid: number): boolean {
  if (process.platform === 'win32') {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminate a spawned process and its descendants.
 * POSIX: child is started in its own process group (detached); we signal -pid.
 * Windows: taskkill /T walks the process tree.
 *
 * Intentionally does not require the group leader to still be alive: a wrapper
 * shell may exit on SIGTERM while descendants that ignore SIGTERM remain.
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid == null) {
    return;
  }

  const { pid } = child;

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  // Skip only when both the leader and the process group are gone.
  if (hasExited(child) && !processGroupExists(pid)) {
    return;
  }

  try {
    // Negative PID = process group (requires detached: true at spawn).
    process.kill(-pid, signal);
  } catch (err) {
    // Fall back to signaling the direct child if it is still alive.
    if (!hasExited(child)) {
      try {
        child.kill(signal);
      } catch (fallbackErr) {
        void fallbackErr;
      }
    }
    void err;
  }
}

function killChild(child: ChildProcess): void {
  if (child.pid == null) {
    return;
  }

  // Always attempt SIGTERM against the tree/group first.
  killProcessTree(child, 'SIGTERM');

  const escalationTimer = setTimeout(() => {
    // Escalate SIGKILL even if the group leader has exited — descendants that
    // ignore SIGTERM may still be running and holding pipes open.
    // killProcessTree itself no-ops only when the whole group is gone.
    killProcessTree(child, 'SIGKILL');
  }, KILL_ESCALATION_MS);

  // Do not keep short-lived CLIs alive solely for the escalation interval.
  escalationTimer.unref?.();

  const clearEscalationIfTreeGone = () => {
    if (child.pid == null || !processGroupExists(child.pid)) {
      clearTimeout(escalationTimer);
    }
  };

  // Cancel escalation once the leader exits and the process group is gone.
  // If orphans remain after the leader exits, leave the (unref'd) timer armed.
  if (hasExited(child)) {
    clearEscalationIfTreeGone();
  } else {
    child.once('close', clearEscalationIfTreeGone);
  }
}

function spawnCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean }
): ChildProcess {
  const isWindows = process.platform === 'win32';
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell ?? false,
    // New process group on POSIX so killProcessTree can signal descendants.
    // On Windows, taskkill /T covers the tree without requiring detached.
    detached: !isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  trackChild(child);
  return child;
}

/**
 * Execute a shell command
 */
export const shellExecTool = defineTool<
  {
    command: string;
    args?: string[];
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
  },
  ShellResult
>({
  name: 'shell_exec',
  description: 'Execute a shell command and return stdout, stderr, and exit code. Use with caution.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to execute (e.g., "ls", "npm", "git")',
      },
      args: {
        type: 'array',
        description: 'Command arguments as an array (e.g., ["-la", "/tmp"])',
        items: { type: 'string' },
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the command (default: current directory)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 60000, max: 300000)',
      },
      env: {
        type: 'object',
        description: 'Additional environment variables',
      },
    },
    required: ['command'],
  },
  execute: async ({ command, args = [], cwd, timeout = 60000, env = {} }, signal) => {
    throwIfAborted(signal);

    const startTime = Date.now();
    const maxTimeout = Math.min(timeout, 300000); // Max 5 minutes

    return new Promise<ShellResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let killed = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };

      const child = spawnCommand(command, args, {
        cwd,
        env: { ...process.env, ...env },
        shell: false,
      });

      timer = setTimeout(() => {
        killed = true;
        killChild(child);
      }, maxTimeout);

      const onAbort = () => {
        killed = true;
        killChild(child);
        settle(() => {
          reject(signal?.reason instanceof Error ? signal.reason : createAbortError());
        });
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (data) => {
        if (killed) {
          return;
        }
        stdout += data.toString();
        // Limit output size — escalate kill only once on first overrun.
        if (stdout.length > 100000) {
          stdout = stdout.slice(0, 100000) + '\n...[truncated]';
          killed = true;
          killChild(child);
        }
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
        if (stderr.length > 100000) {
          stderr = stderr.slice(0, 100000) + '\n...[truncated]';
        }
      });

      child.on('close', (code) => {
        settle(() => {
          if (signal?.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : createAbortError());
            return;
          }
          resolve({
            command: `${command} ${args.join(' ')}`.trim(),
            exitCode: code ?? -1,
            stdout,
            stderr,
            durationMs: Date.now() - startTime,
            killed,
          });
        });
      });

      child.on('error', (error) => {
        settle(() => reject(error));
      });
    });
  },
});

/**
 * Execute a shell command with shell interpretation (supports pipes, etc.)
 */
export const shellRunTool = defineTool<
  {
    script: string;
    cwd?: string;
    timeout?: number;
    shell?: string;
  },
  ShellResult
>({
  name: 'shell_run',
  description: 'Execute a shell script with full shell interpretation (supports pipes, redirects, etc.). More powerful but less safe than shell_exec.',
  parameters: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description: 'The shell script to execute (e.g., "ls -la | grep txt")',
      },
      cwd: {
        type: 'string',
        description: 'Working directory',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 60000)',
      },
      shell: {
        type: 'string',
        description: 'Shell to use (default: /bin/sh on Unix, cmd.exe on Windows)',
      },
    },
    required: ['script'],
  },
  execute: async ({ script, cwd, timeout = 60000, shell }, signal) => {
    throwIfAborted(signal);

    const startTime = Date.now();
    const maxTimeout = Math.min(timeout, 300000);

    return new Promise<ShellResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let killed = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };

      const shellPath = shell || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
      const shellArgs = process.platform === 'win32' ? ['/c', script] : ['-c', script];

      const child = spawnCommand(shellPath, shellArgs, {
        cwd,
        env: process.env,
      });

      timer = setTimeout(() => {
        killed = true;
        killChild(child);
      }, maxTimeout);

      const onAbort = () => {
        killed = true;
        killChild(child);
        settle(() => {
          reject(signal?.reason instanceof Error ? signal.reason : createAbortError());
        });
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (data) => {
        if (killed) {
          return;
        }
        stdout += data.toString();
        // Limit output size — escalate kill only once on first overrun.
        if (stdout.length > 100000) {
          stdout = stdout.slice(0, 100000) + '\n...[truncated]';
          killed = true;
          killChild(child);
        }
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
        if (stderr.length > 100000) {
          stderr = stderr.slice(0, 100000) + '\n...[truncated]';
        }
      });

      child.on('close', (code) => {
        settle(() => {
          if (signal?.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : createAbortError());
            return;
          }
          resolve({
            command: script,
            exitCode: code ?? -1,
            stdout,
            stderr,
            durationMs: Date.now() - startTime,
            killed,
          });
        });
      });

      child.on('error', (error) => {
        settle(() => reject(error));
      });
    });
  },
});

/**
 * Check if a command exists
 */
export const commandExistsTool = defineTool<
  { command: string },
  { command: string; exists: boolean; path?: string }
>({
  name: 'command_exists',
  description: 'Check if a command is available in the system PATH.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command name to check (e.g., "git", "node", "python")',
      },
    },
    required: ['command'],
  },
  execute: async ({ command }, signal) => {
    throwIfAborted(signal);

    const whichCommand = process.platform === 'win32' ? 'where' : 'which';

    return new Promise<{ command: string; exists: boolean; path?: string }>((resolve, reject) => {
      const child = spawnCommand(whichCommand, [command], { shell: false });
      let stdout = '';

      const onAbort = () => {
        killChild(child);
        reject(signal?.reason instanceof Error ? signal.reason : createAbortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : createAbortError());
          return;
        }
        if (code === 0 && stdout.trim()) {
          resolve({
            command,
            exists: true,
            path: stdout.trim().split('\n')[0],
          });
        } else {
          resolve({ command, exists: false });
        }
      });

      child.on('error', () => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : createAbortError());
          return;
        }
        resolve({ command, exists: false });
      });
    });
  },
});

/**
 * All shell tools
 */
export const shellTools = [shellExecTool, shellRunTool, commandExistsTool];
