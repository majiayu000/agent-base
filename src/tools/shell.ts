import { spawn } from 'child_process';
import * as path from 'path';
import { defineTool } from '../core/tool-executor.js';
import type { Tool } from '../core/types.js';

// ============================================================================
// Shell Command Tools (SEC-07 hardened)
// ============================================================================

export interface ShellResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  killed: boolean;
}

/**
 * Security policy for shell tools.
 * Defaults are fail-closed: deny shell_run, empty command allowlist, cwd jailed to process.cwd(), scrub secrets.
 */
export interface ShellSecurityPolicy {
  /** When false (default), shell_run rejects all invocations. */
  allowShellRun?: boolean;
  /** Allowed executables for shell_exec (exact name or basename). Empty = deny all. */
  allowedCommands?: string[];
  /** Resolved cwd must stay under one of these roots. Default: [process.cwd()]. */
  allowedCwdRoots?: string[];
  /** Strip secret-like keys from child env. Default: true. */
  scrubEnv?: boolean;
}

export interface ResolvedShellSecurityPolicy {
  allowShellRun: boolean;
  allowedCommands: string[];
  allowedCwdRoots: string[];
  scrubEnv: boolean;
}

const SECRET_ENV_KEY =
  /(_API_KEY|_TOKEN|_SECRET)$|^PASSWORD$|PASSWORD$/i;

export function resolveShellSecurityPolicy(
  policy: ShellSecurityPolicy = {}
): ResolvedShellSecurityPolicy {
  return {
    allowShellRun: policy.allowShellRun ?? false,
    allowedCommands: policy.allowedCommands ?? [],
    allowedCwdRoots:
      policy.allowedCwdRoots && policy.allowedCwdRoots.length > 0
        ? policy.allowedCwdRoots.map((root) => path.resolve(root))
        : [process.cwd()],
    scrubEnv: policy.scrubEnv ?? true,
  };
}

/** True if env key looks like a credential / secret. */
export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY.test(key);
}

/**
 * Build child env from process.env + overlay, scrubbing secret-like keys when enabled.
 */
export function buildChildEnv(
  overlay: Record<string, string> = {},
  scrub = true
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...overlay };
  if (!scrub) {
    return merged;
  }
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    if (isSecretEnvKey(key)) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

/**
 * Ensure command is on the allowlist (exact match or basename match).
 * Rejects empty commands and path traversal via `..`.
 */
export function assertAllowedCommand(
  command: string,
  allowedCommands: string[]
): void {
  if (!command || !command.trim()) {
    throw new Error('shell_exec denied: empty command');
  }
  if (command.includes('..')) {
    throw new Error(`shell_exec denied: command path traversal not allowed: ${command}`);
  }
  if (allowedCommands.length === 0) {
    throw new Error(
      'shell_exec denied: no commands allowlisted (pass allowedCommands via createShellTools)'
    );
  }
  const base = path.basename(command);
  const ok = allowedCommands.some((entry) => entry === command || entry === base);
  if (!ok) {
    throw new Error(
      `shell_exec denied: command not allowlisted: ${command}`
    );
  }
}

/**
 * Resolve cwd and require it to stay under an allowed root.
 */
export function assertAllowedCwd(
  cwd: string | undefined,
  allowedCwdRoots: string[]
): string {
  const resolved = path.resolve(cwd ?? process.cwd());
  const allowed = allowedCwdRoots.some((root) => {
    const normalizedRoot = path.resolve(root);
    return (
      resolved === normalizedRoot ||
      resolved.startsWith(normalizedRoot + path.sep)
    );
  });
  if (!allowed) {
    throw new Error(
      `shell denied: cwd outside allowed roots: ${resolved}`
    );
  }
  return resolved;
}

function runArgvProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    displayCommand: string;
  }
): Promise<ShellResult> {
  const startTime = Date.now();
  const maxTimeout = Math.min(options.timeout, 300000);

  return new Promise<ShellResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, maxTimeout);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (stdout.length > 100000) {
        stdout = stdout.slice(0, 100000) + '\n...[truncated]';
        killed = true;
        child.kill('SIGTERM');
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > 100000) {
        stderr = stderr.slice(0, 100000) + '\n...[truncated]';
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        command: options.displayCommand,
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        killed,
      });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Create a policy-aware shell_exec tool (argv-only, shell:false).
 */
export function createShellExecTool(
  policy: ShellSecurityPolicy = {}
): Tool<
  {
    command: string;
    args?: string[];
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
  },
  ShellResult
> {
  const resolved = resolveShellSecurityPolicy(policy);

  return defineTool({
    name: 'shell_exec',
    description:
      'Execute an allowlisted command as argv (no shell). Requires createShellTools policy allowlist + cwd jail; secret env keys are scrubbed by default.',
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
          description: 'Working directory for the command (must be under allowed roots)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 60000, max: 300000)',
        },
        env: {
          type: 'object',
          description: 'Additional environment variables (secret-like keys are scrubbed)',
        },
      },
      required: ['command'],
    },
    execute: async ({ command, args = [], cwd, timeout = 60000, env = {} }) => {
      assertAllowedCommand(command, resolved.allowedCommands);
      const safeCwd = assertAllowedCwd(cwd, resolved.allowedCwdRoots);
      const childEnv = buildChildEnv(env, resolved.scrubEnv);

      return runArgvProcess(command, args, {
        cwd: safeCwd,
        env: childEnv,
        timeout,
        displayCommand: `${command} ${args.join(' ')}`.trim(),
      });
    },
  });
}

/**
 * Create a policy-aware shell_run tool. Denied unless allowShellRun is true.
 */
export function createShellRunTool(
  policy: ShellSecurityPolicy = {}
): Tool<
  {
    script: string;
    cwd?: string;
    timeout?: number;
    shell?: string;
  },
  ShellResult
> {
  const resolved = resolveShellSecurityPolicy(policy);

  return defineTool({
    name: 'shell_run',
    description:
      'Execute a shell script with shell interpretation. Disabled by default (SEC-07); enable only via createShellTools({ allowShellRun: true }). Prefer shell_exec.',
    parameters: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'The shell script to execute (e.g., "ls -la | grep txt")',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (must be under allowed roots)',
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
    execute: async ({ script, cwd, timeout = 60000, shell }) => {
      if (!resolved.allowShellRun) {
        throw new Error(
          'shell_run denied by default (SEC-07): enable with createShellTools({ allowShellRun: true })'
        );
      }

      const safeCwd = assertAllowedCwd(cwd, resolved.allowedCwdRoots);
      const childEnv = buildChildEnv({}, resolved.scrubEnv);
      const startTime = Date.now();
      const maxTimeout = Math.min(timeout, 300000);

      return new Promise<ShellResult>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let killed = false;

        const shellPath =
          shell || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
        const shellArgs =
          process.platform === 'win32' ? ['/c', script] : ['-c', script];

        // Explicit argv to the shell binary only; script is a single -c /c argument.
        const child = spawn(shellPath, shellArgs, {
          cwd: safeCwd,
          env: childEnv,
          shell: false,
        });

        const timer = setTimeout(() => {
          killed = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000);
        }, maxTimeout);

        child.stdout.on('data', (data) => {
          stdout += data.toString();
          if (stdout.length > 100000) {
            stdout = stdout.slice(0, 100000) + '\n...[truncated]';
            killed = true;
            child.kill('SIGTERM');
          }
        });

        child.stderr.on('data', (data) => {
          stderr += data.toString();
          if (stderr.length > 100000) {
            stderr = stderr.slice(0, 100000) + '\n...[truncated]';
          }
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({
            command: script,
            exitCode: code ?? -1,
            stdout,
            stderr,
            durationMs: Date.now() - startTime,
            killed,
          });
        });

        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    },
  });
}

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
  execute: async ({ command }) => {
    const whichCommand = process.platform === 'win32' ? 'where' : 'which';

    return new Promise<{ command: string; exists: boolean; path?: string }>((resolve) => {
      const child = spawn(whichCommand, [command], { shell: false });
      let stdout = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.on('close', (code) => {
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
        resolve({ command, exists: false });
      });
    });
  },
});

/**
 * Build shell tools under an explicit security policy (opt-in allowlists).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createShellTools(policy: ShellSecurityPolicy = {}): Tool<any, any>[] {
  return [
    createShellExecTool(policy),
    createShellRunTool(policy),
    commandExistsTool,
  ];
}

/**
 * Default shell tools — fail-closed (no allowlisted commands, shell_run denied).
 * Prefer createShellTools({ allowedCommands, allowedCwdRoots }) for production agents.
 */
export const shellExecTool = createShellExecTool();
export const shellRunTool = createShellRunTool();
export const shellTools = createShellTools();
