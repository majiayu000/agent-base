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
  isDangerousEnvKey,
  assertAllowedCommand,
  assertAllowedCwd,
  resolveAllowedCommand,
  resolveShellSecurityPolicy,
  isRunnableFile,
  isPathInsideRoot,
  resolvePathForJail,
  commandHasParentTraversal,
  getCliSafeAllowedCommands,
  createCommandExistsTool,
  captureFileIdentity,
  commandNamesMatch,
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
      expect(() =>
        resolveAllowedCommand('bin/../echo', ['echo'])
      ).toThrow(/path traversal/);
      expect(commandHasParentTraversal('../echo')).toBe(true);
      expect(commandHasParentTraversal('bin/../echo')).toBe(true);
    });

    it('allows allowlisted names that contain adjacent dots but not a .. segment', () => {
      expect(commandHasParentTraversal('my..tool')).toBe(false);
      expect(commandHasParentTraversal('/opt/bin/tool..v2')).toBe(false);
      // Extensionless shebang fixtures are not runnable under the win32 .exe/.com rule.
      if (process.platform === 'win32') return;
      const dottedDir = path.join(tmpRoot, 'dotted-bin');
      fs.mkdirSync(dottedDir, { recursive: true });
      const toolPath = path.join(dottedDir, 'my..tool');
      fs.writeFileSync(toolPath, '#!/bin/sh\necho dotted\n', { mode: 0o755 });
      const realTool = fs.realpathSync(toolPath);
      const resolved = resolveAllowedCommand(
        realTool,
        [realTool],
        process.env.PATH ?? '',
        tmpRoot
      );
      expect(resolved).toBe(realTool);
    });

    it('rejects path-qualified basename bypasses', () => {
      const decoyDir = path.join(tmpRoot, 'attacker');
      fs.mkdirSync(decoyDir, { recursive: true });
      const decoy = path.join(decoyDir, 'echo');
      fs.writeFileSync(decoy, '#!/bin/sh\necho pwned\n', { mode: 0o755 });
      expect(() => resolveAllowedCommand(decoy, ['echo'])).toThrow(/not allowlisted/);
    });

    it('resolves relative path-qualified commands against the requested cwd', () => {
      const binDir = path.join(tmpRoot, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const toolPath = path.join(binDir, 'tool');
      fs.writeFileSync(toolPath, '#!/bin/sh\necho from-cwd\n', { mode: 0o755 });
      const realTool = fs.realpathSync(toolPath);
      const relativeCmd = path.join('.', 'bin', 'tool');

      const resolved = resolveAllowedCommand(
        relativeCmd,
        [realTool],
        process.env.PATH ?? '',
        tmpRoot
      );
      // Spawn path preserves the cwd-resolved invocation path (not realpath).
      expect(resolved).toBe(path.resolve(tmpRoot, relativeCmd));
      expect(fs.realpathSync(resolved)).toBe(realTool);
    });

    it('pins path-qualified allowlist entries at policy resolve against retargeting', async () => {
      if (process.platform === 'win32') return;
      const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-base-allow-'));
      const goodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-base-allow-good-'));
      const evilDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-base-allow-evil-'));
      const goodBin = path.join(goodDir, 'tool');
      const evilBin = path.join(evilDir, 'tool');
      fs.writeFileSync(goodBin, '#!/bin/sh\necho good\n', { mode: 0o755 });
      fs.writeFileSync(evilBin, '#!/bin/sh\necho evil\n', { mode: 0o755 });
      const linkPath = path.join(linkDir, 'tool');
      try {
        fs.symlinkSync(goodBin, linkPath);
      } catch {
        fs.rmSync(linkDir, { recursive: true, force: true });
        fs.rmSync(goodDir, { recursive: true, force: true });
        fs.rmSync(evilDir, { recursive: true, force: true });
        return;
      }

      const pinned = resolveShellSecurityPolicy({
        allowedCommands: [linkPath],
        allowedCwdRoots: [tmpRoot],
      });
      expect(pinned.allowedCommands[0]).toMatchObject({
        name: 'tool',
        canonicalPath: fs.realpathSync(goodBin),
      });
      expect(pinned.allowedCommands[0].identity).toEqual(
        captureFileIdentity(fs.realpathSync(goodBin))
      );

      const exec = createShellExecTool({
        allowedCommands: [linkPath],
        allowedCwdRoots: [tmpRoot],
      });
      const ok = await exec.execute({
        command: goodBin,
        cwd: tmpRoot,
      });
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout.trim()).toBe('good');

      fs.unlinkSync(linkPath);
      fs.symlinkSync(evilBin, linkPath);

      // Retargeted allowlist symlink must not authorize the new target.
      await expect(
        exec.execute({
          command: evilBin,
          cwd: tmpRoot,
        })
      ).rejects.toThrow(/not allowlisted/);

      fs.rmSync(linkDir, { recursive: true, force: true });
      fs.rmSync(goodDir, { recursive: true, force: true });
      fs.rmSync(evilDir, { recursive: true, force: true });
    });

    it('rejects in-place binary replacement after allowlist pin', async () => {
      if (process.platform === 'win32') return;
      const pinDir = path.join(tmpRoot, 'inplace-pin');
      fs.mkdirSync(pinDir, { recursive: true });
      const toolPath = path.join(pinDir, 'mytool');
      fs.writeFileSync(toolPath, '#!/bin/sh\necho original\n', { mode: 0o755 });

      const prevPath = process.env.PATH;
      process.env.PATH = `${pinDir}${path.delimiter}${prevPath ?? ''}`;
      let exec;
      try {
        exec = createShellExecTool({
          allowedCommands: ['mytool'],
          allowedCwdRoots: [tmpRoot],
        });
      } finally {
        if (prevPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = prevPath;
        }
      }

      const ok = await exec!.execute({ command: 'mytool', cwd: tmpRoot });
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout.trim()).toBe('original');

      // Same pathname, different contents/mtime → must be rejected.
      fs.writeFileSync(toolPath, '#!/bin/sh\necho replaced\n', { mode: 0o755 });
      await expect(
        exec!.execute({ command: 'mytool', cwd: tmpRoot })
      ).rejects.toThrow(/not allowlisted/);
    });

    it('rejects same-length in-place replacement even when mtime is restored', async () => {
      if (process.platform === 'win32') return;
      const pinDir = path.join(tmpRoot, 'forge-mtime-pin');
      fs.mkdirSync(pinDir, { recursive: true });
      const toolPath = path.join(pinDir, 'mytool');
      // Keep payloads identical length so size alone cannot detect the swap.
      const original = '#!/bin/sh\necho original\n';
      const forged = '#!/bin/sh\necho FORGED!!\n';
      expect(Buffer.byteLength(original)).toBe(Buffer.byteLength(forged));
      fs.writeFileSync(toolPath, original, { mode: 0o755 });
      const pinnedStat = fs.statSync(toolPath);

      const prevPath = process.env.PATH;
      process.env.PATH = `${pinDir}${path.delimiter}${prevPath ?? ''}`;
      let exec;
      try {
        exec = createShellExecTool({
          allowedCommands: ['mytool'],
          allowedCwdRoots: [tmpRoot],
        });
      } finally {
        if (prevPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = prevPath;
        }
      }

      const ok = await exec!.execute({ command: 'mytool', cwd: tmpRoot });
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout.trim()).toBe('original');

      // Forge: overwrite with same-length payload and restore mtime.
      fs.writeFileSync(toolPath, forged, { mode: 0o755 });
      fs.utimesSync(toolPath, pinnedStat.atime, pinnedStat.mtime);
      await expect(
        exec!.execute({ command: 'mytool', cwd: tmpRoot })
      ).rejects.toThrow(/not allowlisted/);
    });

    it('preserves symlink spawn path so argv[0] multicalls keep working', async () => {
      const multiDir = path.join(tmpRoot, 'multicall-bin');
      fs.mkdirSync(multiDir, { recursive: true });
      const busyboxLike = path.join(multiDir, 'busybox-like');
      // Mimic BusyBox: dispatch on argv[0] basename.
      fs.writeFileSync(
        busyboxLike,
        '#!/bin/sh\nbase=$(basename "$0")\nif [ "$base" = "applet" ]; then echo applet-ok; exit 0; fi\necho "bad argv0=$base"; exit 1\n',
        { mode: 0o755 }
      );
      const appletLink = path.join(multiDir, 'applet');
      try {
        fs.symlinkSync(busyboxLike, appletLink);
      } catch {
        return;
      }

      // PATH lookup must return the symlink path, not the canonical multicall target.
      const fromPath = resolveAllowedCommand('applet', ['applet'], multiDir);
      expect(fromPath).toBe(path.resolve(appletLink));
      expect(fs.realpathSync(fromPath)).toBe(fs.realpathSync(busyboxLike));

      const exec = createShellExecTool({
        allowedCommands: [appletLink],
        allowedCwdRoots: [tmpRoot],
      });
      const result = await exec.execute({
        command: appletLink,
        cwd: tmpRoot,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('applet-ok');
    });

    it('does not let a path allowlist authorize a sibling multicall symlink', async () => {
      const multiDir = path.join(tmpRoot, 'multicall-sibling');
      fs.mkdirSync(multiDir, { recursive: true });
      const busyboxLike = path.join(multiDir, 'busybox-like');
      fs.writeFileSync(
        busyboxLike,
        '#!/bin/sh\nbase=$(basename "$0")\necho "applet=$base"\n',
        { mode: 0o755 }
      );
      const lsLink = path.join(multiDir, 'ls');
      const shLink = path.join(multiDir, 'sh');
      try {
        fs.symlinkSync(busyboxLike, lsLink);
        fs.symlinkSync(busyboxLike, shLink);
      } catch {
        return;
      }

      const exec = createShellExecTool({
        allowedCommands: [lsLink],
        allowedCwdRoots: [tmpRoot],
      });
      const ok = await exec.execute({
        command: lsLink,
        cwd: tmpRoot,
      });
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout.trim()).toBe('applet=ls');

      // Same canonical target, different authorized basename → deny.
      await expect(
        exec.execute({
          command: shLink,
          cwd: tmpRoot,
        })
      ).rejects.toThrow(/not allowlisted/);
    });

    it('pins bare allowlist names at policy resolve against later PATH changes', async () => {
      if (process.platform === 'win32') return;
      const goodDir = path.join(tmpRoot, 'bare-pin-good');
      const evilDir = path.join(tmpRoot, 'bare-pin-evil');
      fs.mkdirSync(goodDir, { recursive: true });
      fs.mkdirSync(evilDir, { recursive: true });
      const goodBin = path.join(goodDir, 'mytool');
      const evilBin = path.join(evilDir, 'mytool');
      fs.writeFileSync(goodBin, '#!/bin/sh\necho good-pin\n', { mode: 0o755 });
      fs.writeFileSync(evilBin, '#!/bin/sh\necho evil-pin\n', { mode: 0o755 });

      const prevPath = process.env.PATH;
      process.env.PATH = `${goodDir}${path.delimiter}${prevPath ?? ''}`;
      let exec;
      try {
        exec = createShellExecTool({
          allowedCommands: ['mytool'],
          allowedCwdRoots: [tmpRoot],
        });
        const pinned = resolveShellSecurityPolicy({
          allowedCommands: ['mytool'],
          allowedCwdRoots: [tmpRoot],
        });
        expect(pinned.allowedCommands[0]).toMatchObject({
          name: 'mytool',
          canonicalPath: fs.realpathSync(goodBin),
          pinnedSpawnPath: path.resolve(goodBin),
        });
        expect(pinned.allowedCommands[0].identity).toEqual(
          captureFileIdentity(fs.realpathSync(goodBin))
        );
      } finally {
        // Flip PATH so a naive re-lookup would pick evil first.
        process.env.PATH = `${evilDir}${path.delimiter}${prevPath ?? ''}`;
      }

      try {
        const result = await exec!.execute({
          command: 'mytool',
          cwd: tmpRoot,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('good-pin');
      } finally {
        if (prevPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = prevPath;
        }
      }
    });

    it('matches Windows allowlist names case-insensitively', () => {
      expect(commandNamesMatch('whoami', 'WHOAMI', 'win32')).toBe(true);
      expect(commandNamesMatch('whoami', 'WhoAmi', 'win32')).toBe(true);
      expect(commandNamesMatch('whoami', 'WHOAMI', 'darwin')).toBe(false);
      expect(commandNamesMatch('whoami', 'whoami', 'darwin')).toBe(true);
      if (process.platform !== 'win32') return;
      const resolved = resolveAllowedCommand(
        'WHOAMI',
        ['whoami'],
        process.env.PATH ?? '',
        tmpRoot
      );
      expect(resolved.toLowerCase()).toContain('whoami');
    });

    it('runs relative allowlisted executable with explicit cwd', async () => {
      if (process.platform === 'win32') return;
      const binDir = path.join(tmpRoot, 'rel-bin');
      fs.mkdirSync(binDir, { recursive: true });
      const toolPath = path.join(binDir, 'tool');
      fs.writeFileSync(toolPath, '#!/bin/sh\necho from-cwd\n', { mode: 0o755 });
      const realTool = fs.realpathSync(toolPath);

      const exec = createShellExecTool({
        allowedCommands: [realTool],
        allowedCwdRoots: [tmpRoot],
      });
      const result = await exec.execute({
        command: path.join('.', 'rel-bin', 'tool'),
        cwd: tmpRoot,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('from-cwd');
    });

    it('ignores caller PATH overlay when resolving and spawning', async () => {
      if (process.platform === 'win32') return;
      const decoyDir = path.join(tmpRoot, 'path-hijack');
      fs.mkdirSync(decoyDir, { recursive: true });
      const decoy = path.join(decoyDir, 'echo');
      fs.writeFileSync(decoy, '#!/bin/sh\necho HIJACKED\n', { mode: 0o755 });

      const exec = createShellExecTool({
        allowedCommands: ['echo'],
        allowedCwdRoots: [tmpRoot],
      });
      const result = await exec.execute({
        command: 'echo',
        args: ['trusted'],
        cwd: tmpRoot,
        env: { PATH: decoyDir },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('trusted');
    });
  });

  describe('command_exists filesystem lookup', () => {
    it('resolves via trusted PATH without spawning which/where', async () => {
      if (process.platform === 'win32') return;
      const binDir = path.join(tmpRoot, 'exists-bin');
      fs.mkdirSync(binDir, { recursive: true });
      const toolPath = path.join(binDir, 'exists-tool');
      fs.writeFileSync(toolPath, '#!/bin/sh\necho yes\n', { mode: 0o755 });

      const prevPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`;
      try {
        const tool = createCommandExistsTool();
        const hit = await tool.execute({ command: 'exists-tool' });
        expect(hit.exists).toBe(true);
        expect(hit.path).toBe(path.resolve(toolPath));
        const miss = await tool.execute({ command: 'definitely-missing-xyz' });
        expect(miss.exists).toBe(false);
      } finally {
        if (prevPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = prevPath;
        }
      }
    });

    it('does not re-resolve against a PATH overwritten after tool creation', async () => {
      if (process.platform === 'win32') return;
      const goodDir = path.join(tmpRoot, 'exists-good');
      const evilDir = path.join(tmpRoot, 'exists-evil');
      fs.mkdirSync(goodDir, { recursive: true });
      fs.mkdirSync(evilDir, { recursive: true });
      fs.writeFileSync(path.join(goodDir, 'probe'), '#!/bin/sh\necho good\n', {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(evilDir, 'probe'), '#!/bin/sh\necho evil\n', {
        mode: 0o755,
      });

      const prevPath = process.env.PATH;
      process.env.PATH = `${goodDir}${path.delimiter}${prevPath ?? ''}`;
      const tool = createCommandExistsTool();
      process.env.PATH = `${evilDir}${path.delimiter}${prevPath ?? ''}`;
      try {
        const hit = await tool.execute({ command: 'probe' });
        expect(hit.exists).toBe(true);
        expect(hit.path).toBe(path.resolve(goodDir, 'probe'));
      } finally {
        if (prevPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = prevPath;
        }
      }
    });
  });

  describe('cli safe allowlist', () => {
    it('uses Windows-native executables on win32', () => {
      const cmds = getCliSafeAllowedCommands('win32');
      expect(cmds).toEqual(['where', 'hostname', 'whoami', 'findstr', 'sort']);
      expect(cmds).not.toContain('echo');
      expect(cmds).not.toContain('ls');
    });

    it('keeps Unix-friendly names on non-Windows platforms', () => {
      expect(getCliSafeAllowedCommands('darwin')).toEqual([
        'ls',
        'pwd',
        'echo',
        'cat',
        'head',
        'wc',
        'which',
      ]);
      expect(getCliSafeAllowedCommands('linux')).toContain('echo');
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
      const pinnedRoot = resolvePathForJail(tmpRoot);
      expect(assertAllowedCwd(nested, [pinnedRoot])).toBe(resolvePathForJail(nested));
    });

    it('rejects symlink cwd that escapes the jail', () => {
      const link = path.join(tmpRoot, 'escape-link');
      try {
        fs.symlinkSync(outsideRoot, link);
      } catch {
        // Skip on platforms that cannot create symlinks in this environment.
        return;
      }
      const pinnedRoot = resolvePathForJail(tmpRoot);
      expect(() => assertAllowedCwd(link, [pinnedRoot])).toThrow(/cwd outside allowed roots/);
    });

    it('treats filesystem root as containing descendants', () => {
      expect(isPathInsideRoot('/tmp', '/')).toBe(true);
      expect(isPathInsideRoot('/', '/')).toBe(true);
      expect(assertAllowedCwd('/tmp', ['/'])).toBe(resolvePathForJail('/tmp'));
    });

    it('allows legitimate directories whose relative name starts with two dots', () => {
      const dotted = path.join(tmpRoot, '..cache');
      fs.mkdirSync(dotted, { recursive: true });
      const pinnedRoot = resolvePathForJail(tmpRoot);
      const pinnedDotted = resolvePathForJail(dotted);
      expect(isPathInsideRoot(pinnedDotted, pinnedRoot)).toBe(true);
      expect(assertAllowedCwd(dotted, [pinnedRoot])).toBe(pinnedDotted);
    });

    it('honors explicit empty allowedCwdRoots as fail-closed', async () => {
      const exec = createShellExecTool({
        allowedCommands: ['echo'],
        allowedCwdRoots: [],
      });
      await expect(
        exec.execute({ command: 'echo', args: ['x'], cwd: tmpRoot })
      ).rejects.toThrow(/no allowed cwd roots/);
    });

    it('pins allowed roots at policy resolve time against later retargeting', async () => {
      const mutableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-base-pin-'));
      const nested = path.join(mutableRoot, 'nested');
      fs.mkdirSync(nested, { recursive: true });
      const pinnedAtCreate = resolvePathForJail(mutableRoot);

      const exec = createShellExecTool({
        allowedCommands: ['echo'],
        allowedCwdRoots: [mutableRoot],
      });
      expect(resolveShellSecurityPolicy({ allowedCwdRoots: [mutableRoot] }).allowedCwdRoots).toEqual([
        pinnedAtCreate,
      ]);

      const ok = await exec.execute({
        command: 'echo',
        args: ['pinned'],
        cwd: nested,
      });
      expect(ok.exitCode).toBe(0);

      const moved = `${mutableRoot}.moved`;
      fs.renameSync(mutableRoot, moved);
      try {
        fs.symlinkSync(outsideRoot, mutableRoot);
      } catch {
        fs.renameSync(moved, mutableRoot);
        return;
      }

      try {
        // Retargeted root name now realpaths outside the pinned root → deny.
        await expect(
          exec.execute({
            command: 'echo',
            args: ['escape'],
            cwd: mutableRoot,
          })
        ).rejects.toThrow(/cwd outside allowed roots/);
        await expect(
          exec.execute({
            command: 'echo',
            args: ['escape2'],
            cwd: outsideRoot,
          })
        ).rejects.toThrow(/cwd outside allowed roots/);
      } finally {
        fs.rmSync(mutableRoot, { recursive: true, force: true });
        fs.rmSync(moved, { recursive: true, force: true });
      }
    });
  });

  describe('env scrubbing', () => {
    it('detects secret-like env keys', () => {
      expect(isSecretEnvKey('OPENAI_API_KEY')).toBe(true);
      expect(isSecretEnvKey('GH_TOKEN')).toBe(true);
      expect(isSecretEnvKey('DB_SECRET')).toBe(true);
      expect(isSecretEnvKey('PASSWORD')).toBe(true);
      expect(isSecretEnvKey('DB_PASSWORD')).toBe(true);
      expect(isSecretEnvKey('API_KEY')).toBe(true);
      expect(isSecretEnvKey('TOKEN')).toBe(true);
      expect(isSecretEnvKey('SECRET')).toBe(true);
      expect(isSecretEnvKey('AWS_SECRET_ACCESS_KEY')).toBe(true);
      expect(isSecretEnvKey('AWS_ACCESS_KEY_ID')).toBe(true);
      expect(isSecretEnvKey('DOCKER_AUTH_CONFIG')).toBe(true);
      expect(isSecretEnvKey('NPM_CONFIG__AUTH')).toBe(true);
      expect(isSecretEnvKey('CI_JOB_JWT')).toBe(true);
      expect(isSecretEnvKey('SSH_PRIVATE_KEY')).toBe(true);
      expect(isSecretEnvKey('DATABASE_URL')).toBe(true);
      expect(isSecretEnvKey('AZURE_STORAGE_CONNECTION_STRING')).toBe(true);
      expect(isSecretEnvKey('MY_CONNECTION_STRING')).toBe(true);
      expect(isSecretEnvKey('PATH')).toBe(false);
      expect(isSecretEnvKey('HOME')).toBe(false);
    });

    it('detects dangerous execution-hook env keys', () => {
      expect(isDangerousEnvKey('LD_PRELOAD')).toBe(true);
      expect(isDangerousEnvKey('NODE_OPTIONS')).toBe(true);
      expect(isDangerousEnvKey('DYLD_INSERT_LIBRARIES')).toBe(true);
      expect(isDangerousEnvKey('PYTHONPATH')).toBe(true);
      expect(isDangerousEnvKey('HOME')).toBe(false);
    });

    it('strips secret keys and dangerous hooks from child env', () => {
      const prev = process.env.TEST_HARNESS_API_KEY;
      const prevAws = process.env.AWS_SECRET_ACCESS_KEY;
      const prevDocker = process.env.DOCKER_AUTH_CONFIG;
      const prevDb = process.env.DATABASE_URL;
      process.env.TEST_HARNESS_API_KEY = 'super-secret';
      process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
      process.env.DOCKER_AUTH_CONFIG = 'docker-auth';
      process.env.DATABASE_URL = 'postgres://user:password@host/db';
      try {
        const env = buildChildEnv(
          {
            SAFE_FLAG: '1',
            OTHER_TOKEN: 'leak',
            API_KEY: 'unprefixed',
            TOKEN: 'bare-token',
            SECRET: 'bare-secret',
            NPM_CONFIG__AUTH: 'npm-auth',
            CI_JOB_JWT: 'ci-jwt',
            SSH_PRIVATE_KEY: 'ssh-key',
            AZURE_STORAGE_CONNECTION_STRING: 'azure-conn',
            LD_PRELOAD: '/tmp/evil.so',
            NODE_OPTIONS: '--require /tmp/evil.js',
            PATH: '/tmp/attacker',
          },
          true
        );
        expect(env.TEST_HARNESS_API_KEY).toBeUndefined();
        expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
        expect(env.DOCKER_AUTH_CONFIG).toBeUndefined();
        expect(env.NPM_CONFIG__AUTH).toBeUndefined();
        expect(env.CI_JOB_JWT).toBeUndefined();
        expect(env.SSH_PRIVATE_KEY).toBeUndefined();
        expect(env.DATABASE_URL).toBeUndefined();
        expect(env.AZURE_STORAGE_CONNECTION_STRING).toBeUndefined();
        expect(env.OTHER_TOKEN).toBeUndefined();
        expect(env.API_KEY).toBeUndefined();
        expect(env.TOKEN).toBeUndefined();
        expect(env.SECRET).toBeUndefined();
        expect(env.LD_PRELOAD).toBeUndefined();
        expect(env.NODE_OPTIONS).toBeUndefined();
        expect(env.SAFE_FLAG).toBe('1');
        expect(env.PATH).toBe(process.env.PATH);
      } finally {
        if (prev === undefined) {
          delete process.env.TEST_HARNESS_API_KEY;
        } else {
          process.env.TEST_HARNESS_API_KEY = prev;
        }
        if (prevAws === undefined) {
          delete process.env.AWS_SECRET_ACCESS_KEY;
        } else {
          process.env.AWS_SECRET_ACCESS_KEY = prevAws;
        }
        if (prevDocker === undefined) {
          delete process.env.DOCKER_AUTH_CONFIG;
        } else {
          process.env.DOCKER_AUTH_CONFIG = prevDocker;
        }
        if (prevDb === undefined) {
          delete process.env.DATABASE_URL;
        } else {
          process.env.DATABASE_URL = prevDb;
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
          env: { SHELL_SEC_TEST_TOKEN: 'also-secret', API_KEY: 'nope' },
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

  describe('PATH executable lookup', () => {
    it('skips non-executable PATH hits and finds a later runnable file', () => {
      const firstDir = path.join(tmpRoot, 'path-first');
      const secondDir = path.join(tmpRoot, 'path-second');
      fs.mkdirSync(firstDir, { recursive: true });
      fs.mkdirSync(secondDir, { recursive: true });
      const blocker = path.join(firstDir, 'mytool');
      const runnable = path.join(secondDir, 'mytool');
      fs.writeFileSync(blocker, '#!/bin/sh\necho blocked\n', { mode: 0o644 });
      fs.writeFileSync(runnable, '#!/bin/sh\necho ok\n', { mode: 0o755 });

      const resolved = resolveAllowedCommand('mytool', ['mytool'], `${firstDir}${path.delimiter}${secondDir}`);
      // Return the PATH hit path (not realpath) so symlink argv[0] is preserved.
      expect(resolved).toBe(path.resolve(runnable));
      expect(fs.realpathSync(resolved)).toBe(fs.realpathSync(runnable));
    });

    it('rejects path-qualified non-executable files and directories', () => {
      const nonExec = path.join(tmpRoot, 'not-exec');
      fs.writeFileSync(nonExec, '#!/bin/sh\necho nope\n', { mode: 0o644 });
      const asDir = path.join(tmpRoot, 'dir-cmd');
      fs.mkdirSync(asDir, { recursive: true });

      expect(() =>
        resolveAllowedCommand(nonExec, [nonExec], process.env.PATH ?? '', tmpRoot)
      ).toThrow(/command not found/);
      expect(() =>
        resolveAllowedCommand(asDir, [asDir], process.env.PATH ?? '', tmpRoot)
      ).toThrow(/command not found/);
      expect(isRunnableFile(nonExec)).toBe(false);
      expect(isRunnableFile(asDir)).toBe(false);
    });

    it('treats Windows .cmd/.bat as not directly runnable', () => {
      if (process.platform !== 'win32') {
        // Simulate the Windows branch contract via known extensions when not on win32:
        // isRunnableFile on Unix uses X_OK, so assert the policy helper via extension list
        // by creating files and documenting expected Windows behavior in unit terms.
        const cmdPath = path.join(tmpRoot, 'tool.cmd');
        const batPath = path.join(tmpRoot, 'tool.bat');
        const exePath = path.join(tmpRoot, 'tool.exe');
        fs.writeFileSync(cmdPath, '@echo off\n');
        fs.writeFileSync(batPath, '@echo off\n');
        fs.writeFileSync(exePath, '');
        // On non-Windows, executable bit decides; chmod them so platform-specific
        // assertion below is only meaningful on win32.
        return;
      }
      const cmdPath = path.join(tmpRoot, 'tool.cmd');
      const batPath = path.join(tmpRoot, 'tool.bat');
      const exePath = path.join(tmpRoot, 'tool.exe');
      const comPath = path.join(tmpRoot, 'tool.com');
      fs.writeFileSync(cmdPath, '@echo off\n');
      fs.writeFileSync(batPath, '@echo off\n');
      fs.writeFileSync(exePath, '');
      fs.writeFileSync(comPath, '');
      expect(isRunnableFile(cmdPath)).toBe(false);
      expect(isRunnableFile(batPath)).toBe(false);
      expect(isRunnableFile(exePath)).toBe(true);
      expect(isRunnableFile(comPath)).toBe(true);
    });
  });

  describe('allowlisted success path', () => {
    it('runs allowlisted command with safe cwd', async () => {
      if (process.platform === 'win32') {
        const tools = createShellTools({
          allowedCommands: ['whoami'],
          allowedCwdRoots: [tmpRoot],
          allowShellRun: false,
        });
        const exec = tools[0];
        const result = await exec.execute({
          command: 'whoami',
          cwd: tmpRoot,
        });
        expect(result.exitCode).toBe(0);
        expect(result.killed).toBe(false);
        return;
      }
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
