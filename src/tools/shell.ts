import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
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
  /** Allowed executables for shell_exec (exact name or absolute path). Empty = deny all. */
  allowedCommands?: string[];
  /**
   * Resolved cwd must stay under one of these roots.
   * Omitted → default [process.cwd()]. Explicit [] stays empty (fail-closed).
   */
  allowedCwdRoots?: string[];
  /** Strip secret-like keys and dangerous execution hooks from child env. Default: true. */
  scrubEnv?: boolean;
}

/**
 * Strong file identity captured at pin time so an in-place binary replacement
 * (same pathname / realpath) cannot satisfy the allowlist after resolve.
 * Includes a content digest so same-length overwrites with restored mtime
 * cannot forge the metadata-only identity.
 */
export interface PinnedFileIdentity {
  /** Filesystem device id from `stat.dev`. */
  dev: number;
  /** Inode from `stat.ino`. */
  ino: number;
  /** Byte size from `stat.size`. */
  size: number;
  /** Modification time in milliseconds from `stat.mtimeMs`. */
  mtimeMs: number;
  /** SHA-256 hex digest of file contents (unforgeable without rewriting bytes). */
  sha256: string;
}

/**
 * Allowlist entry pinned at policy resolve time.
 *
 * Path-qualified entries bind both the authorized invocation basename (BusyBox
 * multicall applet name) and the canonical target. Bare names also capture the
 * trusted-PATH spawn path so later PATH changes cannot authorize a different binary.
 * Both forms also pin file identity (dev/ino/size/mtime + content SHA-256) to
 * reject in-place replacements that preserve the pathname.
 */
export interface AllowedCommandPin {
  /** Authorized invocation basename (e.g. `ls`, not `sh` on a shared BusyBox). */
  name: string;
  /** realpath-pinned binary target. */
  canonicalPath: string;
  /**
   * Absolute PATH lookup path captured for bare-name entries.
   * Absent for path-qualified pins (those authorize any runnable path whose
   * basename + canonical target match).
   */
  pinnedSpawnPath?: string;
  /** File identity of the authorized binary at pin time (absent when unresolvable). */
  identity?: PinnedFileIdentity;
}

export interface ResolvedShellSecurityPolicy {
  allowShellRun: boolean;
  /**
   * Allowlist captured at policy resolve time. Path-qualified entries are
   * realpath-pinned with their authorized basename; bare names are resolved
   * against the trusted PATH once. Do not re-resolve pins on match.
   */
  allowedCommands: AllowedCommandPin[];
  /**
   * Canonical (realpath-pinned) cwd roots captured at policy resolve time.
   * Do not re-resolve these on each invocation — that reopens TOCTOU if a root
   * is later replaced with a symlink to an outside directory.
   */
  allowedCwdRoots: string[];
  scrubEnv: boolean;
}

/**
 * Matches credential-like env keys: exact unprefixed names, common suffixes,
 * mid-key SECRET / PASSWORD / ACCESS_KEY, auth/JWT/private-key forms
 * (e.g. DOCKER_AUTH_CONFIG, CI_JOB_JWT, SSH_PRIVATE_KEY, NPM_CONFIG__AUTH),
 * and connection URL / connection-string forms (DATABASE_URL,
 * AZURE_STORAGE_CONNECTION_STRING).
 */
const SECRET_ENV_KEY =
  /^(API_KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|CONNECTION_STRING)$|(_API_KEY|_TOKEN|_SECRET|_AUTH|_JWT|_CONNECTION_STRING|_DATABASE_URL)|SECRET|PASSWORD|ACCESS_KEY|PRIVATE_KEY|AUTH_CONFIG|CONNECTION_STRING|DATABASE_URL|(^|_)JWT(_|$)|CREDENTIAL/i;

/** Env keys that can load/execute attacker-controlled code in child processes. */
const DANGEROUS_ENV_KEYS = new Set(
  [
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'LD_LOCAL_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'DYLD_FORCE_FLAT_NAMESPACE',
    'DYLD_VERSIONED_FRAMEWORK_PATH',
    'DYLD_VERSIONED_LIBRARY_PATH',
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_EXTRA_CA_CERTS',
    'PYTHONPATH',
    'PYTHONSTARTUP',
    'PYTHONHOME',
    'PERL5OPT',
    'PERL5LIB',
    'RUBYOPT',
    'RUBYLIB',
    'BASH_ENV',
    'ENV',
    'SHELLOPTS',
    'PS4',
    'SSLKEYLOGFILE',
    'GIT_EXTERNAL_DIFF',
    'GIT_EXEC_PATH',
    'IFS',
  ].map((k) => k.toUpperCase())
);

/** Capture durable file identity used to detect in-place binary replacement. */
export function captureFileIdentity(filePath: string): PinnedFileIdentity | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
    const sha256 = createHash('sha256')
      .update(fs.readFileSync(filePath))
      .digest('hex');
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256,
    };
  } catch {
    return undefined;
  }
}

/** True when the live file still matches the identity pinned at policy resolve. */
export function fileIdentityMatches(
  filePath: string,
  expected: PinnedFileIdentity | undefined
): boolean {
  if (!expected) return false;
  const live = captureFileIdentity(filePath);
  if (!live) return false;
  return (
    live.dev === expected.dev &&
    live.ino === expected.ino &&
    live.size === expected.size &&
    live.mtimeMs === expected.mtimeMs &&
    live.sha256 === expected.sha256
  );
}

/** Compare allowlist/invocation names; Windows is case-insensitive. */
export function commandNamesMatch(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

/**
 * Pin a single allowlist entry against the trusted PATH / filesystem.
 * Path entries bind basename + canonical target; bare names capture spawn path.
 * Both also pin file identity so in-place replacements are rejected later.
 */
export function pinAllowedCommand(
  entry: string,
  trustedPathEnv: string = process.env.PATH ?? ''
): AllowedCommandPin {
  if (commandHasPathSeparator(entry)) {
    const absolute = path.resolve(entry);
    const canonicalPath = tryRealpath(absolute);
    return {
      name: path.basename(absolute),
      canonicalPath,
      identity: captureFileIdentity(canonicalPath),
    };
  }
  const found = lookupExecutableOnTrustedPath(entry, trustedPathEnv);
  if (!found) {
    // Unresolvable at policy time: keep a never-matching pin (fail-closed).
    return {
      name: entry,
      canonicalPath: '',
      pinnedSpawnPath: '',
    };
  }
  const canonicalPath = tryRealpath(found);
  return {
    name: entry,
    canonicalPath,
    pinnedSpawnPath: found,
    identity: captureFileIdentity(canonicalPath),
  };
}

function isAllowedCommandPin(
  value: string | AllowedCommandPin
): value is AllowedCommandPin {
  return typeof value === 'object' && value !== null && 'canonicalPath' in value;
}

/**
 * Normalize raw string allowlists or already-pinned entries for matching.
 */
export function normalizeAllowedCommands(
  allowedCommands: Array<string | AllowedCommandPin>,
  trustedPathEnv: string = process.env.PATH ?? ''
): AllowedCommandPin[] {
  return allowedCommands.map((entry) =>
    isAllowedCommandPin(entry) ? entry : pinAllowedCommand(entry, trustedPathEnv)
  );
}

export function resolveShellSecurityPolicy(
  policy: ShellSecurityPolicy = {}
): ResolvedShellSecurityPolicy {
  const rawCommands = policy.allowedCommands ?? [];
  return {
    allowShellRun: policy.allowShellRun ?? false,
    // Pin path-qualified entries (basename + canonical) and bare names (PATH
    // spawn path) at resolve time so later symlink/PATH changes cannot widen auth.
    allowedCommands: normalizeAllowedCommands(rawCommands, process.env.PATH ?? ''),
    // Only default when the property is omitted; explicit [] must remain fail-closed.
    // Pin each root via realpath at resolve time so later root retargeting cannot
    // widen the jail (TOCTOU).
    allowedCwdRoots:
      policy.allowedCwdRoots === undefined
        ? [resolvePathForJail(process.cwd())]
        : policy.allowedCwdRoots.map((root) => resolvePathForJail(root)),
    scrubEnv: policy.scrubEnv ?? true,
  };
}

/**
 * Platform-specific safe argv allowlist for the interactive CLI.
 * Unix names such as `echo`/`ls` are cmd builtins on Windows and do not resolve
 * as spawnable executables; use real System32 tools there instead.
 * Omit general-purpose interpreters (node/npm/bun) and VCS tools (git).
 */
export function getCliSafeAllowedCommands(
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform === 'win32') {
    return ['where', 'hostname', 'whoami', 'findstr', 'sort'];
  }
  return ['ls', 'pwd', 'echo', 'cat', 'head', 'wc', 'which'];
}

/** True if env key looks like a credential / secret. */
export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY.test(key);
}

/** True if env key can inject code / alter loader behavior. */
export function isDangerousEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (DANGEROUS_ENV_KEYS.has(upper)) return true;
  if (upper.startsWith('LD_') || upper.startsWith('DYLD_')) return true;
  return false;
}

function commandHasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

/**
 * True when any path component is exactly `..` (parent traversal).
 * Names that merely contain adjacent dots (e.g. `my..tool`) are allowed.
 */
export function commandHasParentTraversal(command: string): boolean {
  return command.split(/[/\\]+/).some((segment) => segment === '..');
}

/**
 * Resolve a path for jail checks: realpath existing ancestors so symlink escapes are caught.
 */
export function resolvePathForJail(input: string): string {
  const absolute = path.resolve(input);
  let current = absolute;
  const missing: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  try {
    const real = fs.realpathSync(current);
    return missing.length > 0 ? path.join(real, ...missing) : real;
  } catch {
    return absolute;
  }
}

/**
 * True if `child` is `parent` or a descendant (handles filesystem root `/` correctly).
 * Distinguishes parent traversal (`..` / `../x`) from legitimate names like `..cache`.
 */
export function isPathInsideRoot(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) return false;
  return true;
}

function tryRealpath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * True if the path is a regular file that can actually be executed.
 * Non-executable regular files return false so PATH lookup continues.
 */
export function isRunnableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === 'win32') {
    const ext = path.extname(filePath).toLowerCase();
    // Only formats Node can spawn with shell:false. .cmd/.bat require a shell
    // (cmd.exe) and must not be treated as directly runnable here.
    // https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows
    const directSpawnExts = ['.exe', '.com'];
    return directSpawnExts.includes(ext);
  }
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a bare command name using the parent process PATH (never the caller overlay).
 * Returns the PATH lookup path (not realpath) so symlink-backed multicall binaries
 * (BusyBox-style) keep the requested name as argv[0] when spawned.
 */
export function lookupExecutableOnTrustedPath(
  name: string,
  pathEnv: string = process.env.PATH ?? ''
): string | null {
  const dirs = pathEnv.split(path.delimiter);
  // Empty suffix first so callers can pass `tool.exe` as a bare name; .cmd/.bat
  // are omitted because isRunnableFile rejects them (spawn uses shell:false).
  const extensions =
    process.platform === 'win32' ? ['', '.exe', '.com'] : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      if (isRunnableFile(candidate)) {
        return path.resolve(candidate);
      }
    }
  }
  return null;
}

/**
 * Resolve the executable that will be spawned, authorize it against pinned
 * allowlist identity (authorized basename + canonical target), and return the
 * invocation path to pass to spawn (preserving argv[0] for symlink multicalls).
 *
 * Path-qualified commands (containing `/` or `\`) are resolved against `cwd`
 * (the validated shell working directory), not the Node process cwd.
 *
 * Bare-name pins use the spawn path captured at policy resolve time and do not
 * re-lookup PATH. Path pins require both basename and canonical target to match
 * so BusyBox-style multicall symlinks cannot authorize sibling applets.
 */
export function resolveAllowedCommand(
  command: string,
  allowedCommands: Array<string | AllowedCommandPin>,
  trustedPathEnv: string = process.env.PATH ?? '',
  cwd: string = process.cwd()
): string {
  if (!command || !command.trim()) {
    throw new Error('shell_exec denied: empty command');
  }
  if (commandHasParentTraversal(command)) {
    throw new Error(
      `shell_exec denied: command path traversal not allowed: ${command}`
    );
  }
  if (allowedCommands.length === 0) {
    throw new Error(
      'shell_exec denied: no commands allowlisted (pass allowedCommands via createShellTools)'
    );
  }

  const pins = normalizeAllowedCommands(allowedCommands, trustedPathEnv);

  if (commandHasPathSeparator(command)) {
    const absolute = path.resolve(cwd, command);
    // Require a directly runnable file; existing non-executables / directories
    // must be rejected here (not deferred to a raw spawn EACCES/EISDIR).
    if (!isRunnableFile(absolute)) {
      throw new Error(`shell_exec denied: command not found: ${command}`);
    }
    const canonicalPath = tryRealpath(absolute);
    const invName = path.basename(absolute);
    // Path-qualified commands only match path-style pins (no pinnedSpawnPath).
    // Basename-only / bare pins must not authorize path-qualified invocations.
    const matched = pins.some(
      (pin) =>
        pin.pinnedSpawnPath === undefined &&
        pin.canonicalPath === canonicalPath &&
        commandNamesMatch(pin.name, invName) &&
        fileIdentityMatches(canonicalPath, pin.identity)
    );
    if (!matched) {
      throw new Error(`shell_exec denied: command not allowlisted: ${command}`);
    }
    return absolute;
  }

  // Bare name: use the PATH identity pinned at policy resolve — do not re-lookup.
  const pin = pins.find(
    (entry) =>
      entry.pinnedSpawnPath !== undefined &&
      commandNamesMatch(entry.name, command)
  );
  if (!pin || !pin.pinnedSpawnPath) {
    throw new Error(`shell_exec denied: command not allowlisted: ${command}`);
  }
  if (!isRunnableFile(pin.pinnedSpawnPath)) {
    throw new Error(
      `shell_exec denied: command not found on trusted PATH: ${command}`
    );
  }
  const canonicalPath = tryRealpath(pin.pinnedSpawnPath);
  if (canonicalPath !== pin.canonicalPath) {
    // Symlink at the pinned spawn path was retargeted after policy resolve.
    throw new Error(`shell_exec denied: command not allowlisted: ${command}`);
  }
  // In-place binary replacement keeps the same pathname / realpath; reject it.
  if (!fileIdentityMatches(canonicalPath, pin.identity)) {
    throw new Error(`shell_exec denied: command not allowlisted: ${command}`);
  }
  return pin.pinnedSpawnPath;
}

/**
 * Ensure command is on the allowlist after trusted-PATH resolution.
 */
export function assertAllowedCommand(
  command: string,
  allowedCommands: Array<string | AllowedCommandPin>,
  cwd: string = process.cwd()
): void {
  resolveAllowedCommand(command, allowedCommands, process.env.PATH ?? '', cwd);
}

/**
 * Resolve cwd and require it to stay under an allowed root.
 *
 * `allowedCwdRoots` must already be pinned (see resolveShellSecurityPolicy);
 * roots are compared as-is and are not re-realpathed on each call.
 */
export function assertAllowedCwd(
  cwd: string | undefined,
  allowedCwdRoots: string[]
): string {
  if (allowedCwdRoots.length === 0) {
    throw new Error('shell denied: no allowed cwd roots configured');
  }
  const resolved = resolvePathForJail(cwd ?? process.cwd());
  const allowed = allowedCwdRoots.some((root) =>
    isPathInsideRoot(resolved, root)
  );
  if (!allowed) {
    throw new Error(`shell denied: cwd outside allowed roots: ${resolved}`);
  }
  return resolved;
}

/**
 * True when `key` is the process PATH variable for this platform.
 * win32 env is case-insensitive (Node may surface `Path`); Unix PATH is exact.
 */
function isPathEnvKey(key: string): boolean {
  return process.platform === 'win32' ? /^PATH$/i.test(key) : key === 'PATH';
}

/**
 * Read the trusted PATH from an env object.
 * On win32, match case-insensitively; on Unix, only the exact `PATH` key.
 * Using case-fold matching on Unix lets a decoy `path`/`Path` env var win
 * when it appears before `PATH` in Object.entries iteration order.
 */
function readTrustedPath(env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform === 'win32') {
    for (const [key, value] of Object.entries(env)) {
      if (isPathEnvKey(key) && typeof value === 'string') {
        return value;
      }
    }
    return undefined;
  }
  const value = env.PATH;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Remove every case-variant PATH key so Windows cannot honor attacker overlays
 * and Unix child envs stay free of PATH-shaped decoy keys from overlays.
 */
function stripPathKeys(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (/^PATH$/i.test(key)) {
      delete env[key];
    }
  }
}

/**
 * Build child env from process.env + overlay, scrubbing secrets and dangerous hooks.
 * Caller-supplied PATH (any casing) is ignored; the parent process PATH is always used.
 * On Unix, only the exact parent `PATH` key is trusted (not `path`/`Path` decoys).
 */
export function buildChildEnv(
  overlay: Record<string, string> = {},
  scrub = true
): NodeJS.ProcessEnv {
  // Capture trusted PATH before overlay merge (exact on Unix; case-fold on win32).
  const trustedPath = readTrustedPath(process.env);
  const merged: NodeJS.ProcessEnv = { ...process.env, ...overlay };
  // Strip Path/path/PATH from parent + overlay, then pin the trusted value only.
  // Otherwise Windows child lookup can honor a retained case-variant attacker key.
  stripPathKeys(merged);
  if (trustedPath !== undefined) {
    merged.PATH = trustedPath;
  }

  if (!scrub) {
    return merged;
  }

  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    if (/^PATH$/i.test(key)) continue;
    if (isSecretEnvKey(key)) continue;
    if (isDangerousEnvKey(key)) continue;
    scrubbed[key] = value;
  }
  if (trustedPath !== undefined) {
    scrubbed.PATH = trustedPath;
  }
  return scrubbed;
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
          description: 'The command to execute (e.g., "ls", "git")',
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
          description:
            'Additional environment variables (secrets and dangerous loader hooks are scrubbed; PATH overlay ignored)',
        },
      },
      required: ['command'],
    },
    execute: async ({ command, args = [], cwd, timeout = 60000, env = {} }) => {
      // Validate cwd first so path-qualified commands resolve against the jail, not process.cwd().
      const safeCwd = assertAllowedCwd(cwd, resolved.allowedCwdRoots);
      const resolvedCommand = resolveAllowedCommand(
        command,
        resolved.allowedCommands,
        process.env.PATH ?? '',
        safeCwd
      );
      const childEnv = buildChildEnv(env, resolved.scrubEnv);

      return runArgvProcess(resolvedCommand, args, {
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
 * Create a command_exists tool that uses filesystem PATH lookup only.
 * Never spawns `which`/`where`, so writable PATH entries cannot hijack the helper.
 */
export function createCommandExistsTool(
  policy: ShellSecurityPolicy = {}
): Tool<{ command: string }, { command: string; exists: boolean; path?: string }> {
  // Capture trusted PATH at tool creation so later PATH overlays cannot widen lookup.
  // Policy is accepted for factory consistency with the other shell tools.
  void policy;
  const trustedPathEnv = process.env.PATH ?? '';

  return defineTool({
    name: 'command_exists',
    description:
      'Check if a command is available on the trusted process PATH using filesystem lookup (no which/where spawn).',
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
      if (!command || !command.trim() || commandHasParentTraversal(command)) {
        return { command, exists: false };
      }
      if (commandHasPathSeparator(command)) {
        const absolute = path.resolve(command);
        if (isRunnableFile(absolute)) {
          return { command, exists: true, path: absolute };
        }
        return { command, exists: false };
      }
      const found = lookupExecutableOnTrustedPath(command, trustedPathEnv);
      if (found) {
        return { command, exists: true, path: found };
      }
      return { command, exists: false };
    },
  });
}

/**
 * Check if a command exists (filesystem lookup; no which/where spawn).
 */
export const commandExistsTool = createCommandExistsTool();

/**
 * Build shell tools under an explicit security policy (opt-in allowlists).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createShellTools(policy: ShellSecurityPolicy = {}): Tool<any, any>[] {
  return [
    createShellExecTool(policy),
    createShellRunTool(policy),
    createCommandExistsTool(policy),
  ];
}

/**
 * Default shell tools — fail-closed (empty command allowlist; shell_run denied).
 * These convenience exports are not usable without replacing them via
 * createShellTools({ allowedCommands, allowedCwdRoots }). Prefer that factory
 * (and build your own tool list instead of allTools) for production agents.
 */
export const shellExecTool = createShellExecTool();
export const shellRunTool = createShellRunTool();
export const shellTools = createShellTools();
