import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createShellTools,
  createShellExecTool,
  createShellRunTool,
  shellRunTool,
  shellExecTool,
  buildChildEnv,
  isSecretEnvKey,
  assertAllowedCommand,
  assertAllowedCwd,
} from '../src/tools/shell.js';

describe('Shell security (SEC-07)', () => {
  let tmpRoot: string;
  let outsideRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-base-shell-'));
    outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-base-shell-out-'));
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  describe('default-deny shell_run', () => {
    it('denies shell_run by default on exported tool', async () => {
      await expect(
        shellRunTool.execute({ script: 'echo pwned' })
      ).rejects.toThrow(/shell_run denied by default/);
    });

    it('denies shell_run when createShellTools omits allowShellRun', async () => {
      const [exec, run] = createShellTools({
        allowedCommands: ['echo'],
        allowedCwdRoots: [tmpRoot],
      });
      expect(exec.name).toBe('shell_exec');
      expect(run.name).toBe('shell_run');
      await expect(run.execute({ script: 'echo hi' })).rejects.toThrow(
        /shell_run denied by default/
      );
    });

    it('allows shell_run only when explicitly enabled', async () => {
      const run = createShellRunTool({
        allowShellRun: true,
        allowedCwdRoots: [tmpRoot],
      });
      const result = await run.execute({
        script: 'echo enabled',
        cwd: tmpRoot,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('enabled');
    });
  });

  describe('shell_exec allowlist', () => {
    it('rejects when no commands are allowlisted (default export)', async () => {
      await expect(
        shellExecTool.execute({ command: 'echo', args: ['x'] })
      ).rejects.toThrow(/no commands allowlisted/);
    });

    it('rejects non-allowlisted binaries', async () => {
      const exec = createShellExecTool({
        allowedCommands: ['echo'],
        allowedCwdRoots: [tmpRoot],
      });
      await expect(
        exec.execute({ command: 'ls', cwd: tmpRoot })
      ).rejects.toThrow(/not allowlisted/);
    });

    it('rejects path traversal in command', () => {
      expect(() =>
        assertAllowedCommand('../echo', ['echo'])
      ).toThrow(/path traversal/);
    });
  });

  describe('cwd jail', () => {
    it('rejects cwd outside allowed roots', async () => {
      const exec = createShellExecTool({
        allowedCommands: ['echo'],
        allowedCwdRoots: [tmpRoot],
      });
      await expect(
        exec.execute({
          command: 'echo',
          args: ['nope'],
          cwd: outsideRoot,
        })
      ).rejects.toThrow(/cwd outside allowed roots/);
    });

    it('assertAllowedCwd accepts paths under root', () => {
      const nested = path.join(tmpRoot, 'nested');
      fs.mkdirSync(nested, { recursive: true });
      expect(assertAllowedCwd(nested, [tmpRoot])).toBe(path.resolve(nested));
    });
  });

  describe('env scrubbing', () => {
    it('detects secret-like env keys', () => {
      expect(isSecretEnvKey('OPENAI_API_KEY')).toBe(true);
      expect(isSecretEnvKey('GH_TOKEN')).toBe(true);
      expect(isSecretEnvKey('DB_SECRET')).toBe(true);
      expect(isSecretEnvKey('PASSWORD')).toBe(true);
      expect(isSecretEnvKey('DB_PASSWORD')).toBe(true);
      expect(isSecretEnvKey('PATH')).toBe(false);
      expect(isSecretEnvKey('HOME')).toBe(false);
    });

    it('strips secret keys from child env', () => {
      const prev = process.env.TEST_HARNESS_API_KEY;
      process.env.TEST_HARNESS_API_KEY = 'super-secret';
      try {
        const env = buildChildEnv(
          { SAFE_FLAG: '1', OTHER_TOKEN: 'leak' },
          true
        );
        expect(env.TEST_HARNESS_API_KEY).toBeUndefined();
        expect(env.OTHER_TOKEN).toBeUndefined();
        expect(env.SAFE_FLAG).toBe('1');
      } finally {
        if (prev === undefined) {
          delete process.env.TEST_HARNESS_API_KEY;
        } else {
          process.env.TEST_HARNESS_API_KEY = prev;
        }
      }
    });

    it('does not pass scrubbed secrets into a successful child process', async () => {
      const exec = createShellExecTool({
        allowedCommands: ['node'],
        allowedCwdRoots: [tmpRoot],
        scrubEnv: true,
      });
      const prev = process.env.SHELL_SEC_TEST_API_KEY;
      process.env.SHELL_SEC_TEST_API_KEY = 'should-not-leak';
      try {
        const result = await exec.execute({
          command: 'node',
          args: [
            '-e',
            'process.stdout.write(process.env.SHELL_SEC_TEST_API_KEY ?? "ABSENT")',
          ],
          cwd: tmpRoot,
          env: { SHELL_SEC_TEST_TOKEN: 'also-secret' },
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('ABSENT');
      } finally {
        if (prev === undefined) {
          delete process.env.SHELL_SEC_TEST_API_KEY;
        } else {
          process.env.SHELL_SEC_TEST_API_KEY = prev;
        }
      }
    });
  });

  describe('allowlisted success path', () => {
    it('runs allowlisted command with safe cwd', async () => {
      const tools = createShellTools({
        allowedCommands: ['echo'],
        allowedCwdRoots: [tmpRoot],
        allowShellRun: false,
      });
      const exec = tools[0];
      const result = await exec.execute({
        command: 'echo',
        args: ['ok'],
        cwd: tmpRoot,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('ok');
      expect(result.killed).toBe(false);
    });

    it('createShellTools returns three registered tools', () => {
      const tools = createShellTools({
        allowedCommands: ['pwd'],
        allowedCwdRoots: [tmpRoot],
      });
      expect(tools.map((t) => t.name)).toEqual([
        'shell_exec',
        'shell_run',
        'command_exists',
      ]);
    });
  });
});
