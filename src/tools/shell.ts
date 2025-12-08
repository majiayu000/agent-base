import { spawn } from 'child_process';
import { defineTool } from '../core/tool-executor.js';

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
  execute: async ({ command, args = [], cwd, timeout = 60000, env = {} }) => {
    const startTime = Date.now();
    const maxTimeout = Math.min(timeout, 300000); // Max 5 minutes

    return new Promise<ShellResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        shell: false,
      });

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, maxTimeout);

      child.stdout.on('data', (data) => {
        stdout += data.toString();
        // Limit output size
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
          command: `${command} ${args.join(' ')}`.trim(),
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
  execute: async ({ script, cwd, timeout = 60000, shell }) => {
    const startTime = Date.now();
    const maxTimeout = Math.min(timeout, 300000);

    return new Promise<ShellResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      const shellPath = shell || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
      const shellArgs = process.platform === 'win32' ? ['/c', script] : ['-c', script];

      const child = spawn(shellPath, shellArgs, {
        cwd,
        env: process.env,
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
 * All shell tools
 */
export const shellTools = [shellExecTool, shellRunTool, commandExistsTool];
