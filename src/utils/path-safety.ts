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
 * Resolve `inputPath` against the workspace root and reject escapes.
 *
 * Absolute inputs and `../` segments are allowed only when the final
 * (optionally realpath'd) location remains under the workspace root.
 */
export async function resolveWithinWorkspace(
  inputPath: string,
  options: ResolveWithinWorkspaceOptions = {}
): Promise<string> {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new Error('Path must be a non-empty string');
  }

  const useRealpath = options.useRealpath !== false;
  let root = getWorkspaceRoot(options.workspaceRoot);

  if (useRealpath) {
    try {
      root = await fs.realpath(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
      // Root may not exist yet; keep lexical resolve
    }
  }

  // path.resolve ignores prior args once an absolute segment appears, so
  // absolute caller paths are checked as-is against the root.
  const absolutePath = path.resolve(root, inputPath);
  const candidate = useRealpath
    ? await realpathExistingPrefix(absolutePath)
    : absolutePath;

  if (!isPathInsideRoot(candidate, root)) {
    throw new Error(
      `Path escapes workspace root (${root}): ${inputPath}`
    );
  }

  return candidate;
}
