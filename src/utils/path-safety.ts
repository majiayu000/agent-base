import * as fs from 'fs/promises';
import * as path from 'path';

// ============================================================================
// Path Safety (workspace containment)
// ============================================================================

export interface ResolveWithinWorkspaceOptions {
  /** Override workspace root for this call. */
  workspaceRoot?: string;
  /**
   * Resolve existing path segments with realpath to catch symlink escapes.
   * Default: true.
   */
  useRealpath?: boolean;
}

export interface WorkspacePath {
  /** Realpath'd (when possible) workspace root used for containment. */
  root: string;
  /**
   * Lexical absolute path under the root (`path.resolve(root, input)`).
   * Does not follow the final symlink — use for unlink/rename of the
   * caller-named entry itself.
   */
  lexicalPath: string;
  /**
   * Canonical path after realpath of the longest existing prefix.
   * Use for containment checks and for I/O that should follow in-workspace
   * symlinks to their target.
   */
  realPath: string;
}

/** Module-level workspace root override (constructor/config equivalent). */
let configuredWorkspaceRoot: string | undefined;

/**
 * Configure the default workspace root used by filesystem tools.
 * Pass `undefined` to clear and fall back to AGENT_BASE_WORKSPACE_ROOT / cwd.
 */
export function setWorkspaceRoot(root: string | undefined): void {
  configuredWorkspaceRoot = root;
}

/**
 * Resolve the active workspace root.
 * Precedence: explicit override → module config → AGENT_BASE_WORKSPACE_ROOT → process.cwd().
 */
export function getWorkspaceRoot(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') {
    return path.resolve(explicit);
  }
  if (configuredWorkspaceRoot !== undefined && configuredWorkspaceRoot !== '') {
    return path.resolve(configuredWorkspaceRoot);
  }
  const fromEnv = process.env.AGENT_BASE_WORKSPACE_ROOT;
  if (fromEnv !== undefined && fromEnv !== '') {
    return path.resolve(fromEnv);
  }
  return path.resolve(process.cwd());
}

/**
 * Sensitive basenames that write/delete tools refuse by default.
 */
const SENSITIVE_BASENAME_PATTERNS: RegExp[] = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /^id_rsa$/i,
  /^id_ed25519$/i,
  /^id_ecdsa$/i,
  /\.pem$/i,
];

/**
 * Throw if the basename matches a sensitive secret pattern.
 */
export function assertNotSensitiveBasename(filePath: string): void {
  const base = path.basename(filePath);
  for (const pattern of SENSITIVE_BASENAME_PATTERNS) {
    if (pattern.test(base)) {
      throw new Error(
        `Refusing write/delete of sensitive path basename "${base}"`
      );
    }
  }
}

/**
 * Reject sensitive basenames on both the caller-requested path and the
 * resolved target. Needed when `.env` is a symlink to a normal filename —
 * realpath alone would hide the sensitive request basename.
 */
export function assertNotSensitivePaths(
  requestedPath: string,
  resolvedPath: string
): void {
  assertNotSensitiveBasename(requestedPath);
  assertNotSensitiveBasename(resolvedPath);
}

/**
 * True if `candidate` is the workspace root or a path inside it.
 */
export function isPathInsideRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = path.resolve(root);
  if (normalizedCandidate === normalizedRoot) {
    return true;
  }
  const rootPrefix = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  return normalizedCandidate.startsWith(rootPrefix);
}

/**
 * realpath the longest existing prefix of `absolutePath`, then re-join
 * any trailing segments that do not exist yet (needed for create/write).
 *
 * Dangling symlinks are special: POSIX `realpath` returns ENOENT when the
 * final component exists as a symlink but its target does not. Treating that
 * as a missing path would reconstruct a contained lexical path and let
 * write_file follow the link outside the workspace. Resolve via lstat/readlink
 * so the intended target participates in containment checks.
 */
async function realpathExistingPrefix(absolutePath: string): Promise<string> {
  const segments: string[] = [];
  let current = absolutePath;

  while (true) {
    try {
      const real = await fs.realpath(current);
      return segments.length === 0 ? real : path.join(real, ...segments);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }

      // Dangling (or otherwise unresolvable) symlink: follow the link text
      // instead of pretending the entry is missing.
      try {
        const lst = await fs.lstat(current);
        if (lst.isSymbolicLink()) {
          const linkTarget = await fs.readlink(current);
          // Relative link text is relative to the directory containing the
          // link inode. When that parent was reached via another symlink
          // (e.g. alias -> deep/real, link -> ../new.txt), dirname(current)
          // is still lexical (alias/) and would resolve to the wrong place.
          // Canonicalize the parent first.
          const parentDir = path.dirname(current);
          let parentCanonical: string;
          try {
            parentCanonical = await fs.realpath(parentDir);
          } catch (parentError) {
            const parentCode = (parentError as NodeJS.ErrnoException).code;
            if (parentCode !== 'ENOENT') {
              throw parentError;
            }
            parentCanonical = await realpathExistingPrefix(parentDir);
          }
          const resolvedTarget = path.resolve(parentCanonical, linkTarget);
          current =
            segments.length === 0
              ? resolvedTarget
              : path.join(resolvedTarget, ...segments);
          segments.length = 0;
          continue;
        }
      } catch (lstatError) {
        // Only continue parent-walk when the entry is also missing for lstat.
        // Other lstat failures (EACCES, etc.) must surface.
        const lstatCode = (lstatError as NodeJS.ErrnoException).code;
        if (lstatCode !== 'ENOENT') {
          throw lstatError;
        }
      }

      const parent = path.dirname(current);
      if (parent === current) {
        // Nothing on this volume exists — fall back to lexical path
        return absolutePath;
      }
      segments.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Ensure the directory entry named by `lexicalPath` itself lives under
 * `root` (via the canonical parent), not merely that its realpath target does.
 * Required before unlink/rm of the lexical entry so an absolute outside-workspace
 * symlink to an in-workspace file cannot be deleted.
 */
export async function assertLexicalEntryContained(
  lexicalPath: string,
  root: string
): Promise<void> {
  // The workspace root itself is a valid contained entry; its parent lives
  // outside the root by definition, so skip the parent check for that case.
  if (path.resolve(lexicalPath) === path.resolve(root)) {
    return;
  }

  const parent = path.dirname(lexicalPath);
  const parentReal = await realpathExistingPrefix(parent);
  if (!isPathInsideRoot(parentReal, root)) {
    throw new Error(
      `Path escapes workspace root (${root}): ${lexicalPath}`
    );
  }
  const entryUnderParent = path.join(parentReal, path.basename(lexicalPath));
  if (!isPathInsideRoot(entryUnderParent, root)) {
    throw new Error(
      `Path escapes workspace root (${root}): ${lexicalPath}`
    );
  }
}

async function resolveRoot(
  options: ResolveWithinWorkspaceOptions,
  useRealpath: boolean
): Promise<string> {
  let root = getWorkspaceRoot(options.workspaceRoot);

  if (useRealpath) {
    try {
      root = await fs.realpath(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
      // Root may not exist yet beneath a symlinked ancestor (e.g. new dir
      // under macOS /tmp -> /private/tmp). Canonicalize the longest existing
      // prefix and reattach the missing suffix so candidate realpaths compare
      // against the same root form.
      root = await realpathExistingPrefix(root);
    }
  }

  return root;
}

/**
 * Resolve `inputPath` against the workspace root and reject escapes.
 * Returns both the lexical path (for symlink-preserving ops) and the
 * realpath'd path (for containment / follow-target I/O).
 */
export async function resolveWorkspacePath(
  inputPath: string,
  options: ResolveWithinWorkspaceOptions = {}
): Promise<WorkspacePath> {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new Error('Path must be a non-empty string');
  }

  const useRealpath = options.useRealpath !== false;
  const root = await resolveRoot(options, useRealpath);

  // path.resolve ignores prior args once an absolute segment appears, so
  // absolute caller paths are checked as-is against the root.
  const lexicalPath = path.resolve(root, inputPath);

  // Containment is decided on the realpath'd location. Do not require the
  // lexical string to share the root prefix — on macOS `/var/...` and
  // `/private/var/...` name the same directory, and absolute caller paths may
  // use either form.
  const realPath = useRealpath
    ? await realpathExistingPrefix(lexicalPath)
    : lexicalPath;

  if (!isPathInsideRoot(realPath, root)) {
    throw new Error(
      `Path escapes workspace root (${root}): ${inputPath}`
    );
  }

  return { root, lexicalPath, realPath };
}

/**
 * Like {@link resolveWorkspacePath}, but does not reject when the canonical
 * target escapes the workspace. Used by delete_path so an in-workspace
 * symlink pointing outside can still be unlinked after lexical-entry checks.
 */
export async function resolveWorkspacePathAllowingTargetEscape(
  inputPath: string,
  options: ResolveWithinWorkspaceOptions = {}
): Promise<WorkspacePath> {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new Error('Path must be a non-empty string');
  }

  const useRealpath = options.useRealpath !== false;
  const root = await resolveRoot(options, useRealpath);
  const lexicalPath = path.resolve(root, inputPath);

  let realPath = lexicalPath;
  if (useRealpath) {
    try {
      realPath = await realpathExistingPrefix(lexicalPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Cyclic symlinks raise ELOOP while following targets. Callers that
      // only need the contained lexical entry (inspect/unlink the link)
      // can still proceed with lexicalPath.
      if (code !== 'ELOOP') {
        throw error;
      }
    }
  }

  return { root, lexicalPath, realPath };
}

/**
 * Resolve `inputPath` against the workspace root and reject escapes.
 *
 * Absolute inputs and `../` segments are allowed only when the final
 * (optionally realpath'd) location remains under the workspace root.
 *
 * Returns the canonical (realpath'd) path. Prefer {@link resolveWorkspacePath}
 * when the lexical entry name must be preserved (e.g. unlink a symlink).
 */
export async function resolveWithinWorkspace(
  inputPath: string,
  options: ResolveWithinWorkspaceOptions = {}
): Promise<string> {
  const resolved = await resolveWorkspacePath(inputPath, options);
  return resolved.realPath;
}

/**
 * Re-validate that `lexicalPath` is still contained under `root`.
 * Call immediately before filesystem access to shrink the check/use window
 * (portable Node/Bun APIs do not expose openat for full descriptor binding).
 */
export async function revalidateContained(
  lexicalPath: string,
  root: string
): Promise<string> {
  const realPath = await realpathExistingPrefix(lexicalPath);
  if (!isPathInsideRoot(realPath, root)) {
    throw new Error(
      `Path escapes workspace root (${root}): ${lexicalPath}`
    );
  }
  return realPath;
}
