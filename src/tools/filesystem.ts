import * as fs from 'fs/promises';
import * as path from 'path';
import { defineTool } from '../core/tool-executor.js';
import {
  assertLexicalEntryContained,
  assertNotSensitivePaths,
  isPathInsideRoot,
  resolveWorkspacePath,
  resolveWorkspacePathAllowingTargetEscape,
  revalidateContained,
} from '../utils/path-safety.js';

// ============================================================================
// Filesystem Tools
// ============================================================================

/**
 * Read file contents
 */
export const readFileTool = defineTool<
  { path: string; encoding?: 'utf-8' | 'base64' },
  { path: string; content: string; size: number; encoding: string }
>({
  name: 'read_file',
  description:
    'Read the contents of a file within the workspace. Supports text files (utf-8) and binary files (base64). Paths outside the workspace root are rejected.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'The file path to read (absolute or relative to the workspace root). Must stay inside the workspace.',
      },
      encoding: {
        type: 'string',
        description: 'File encoding: "utf-8" for text, "base64" for binary (default: "utf-8")',
        enum: ['utf-8', 'base64'],
      },
    },
    required: ['path'],
  },
  execute: async ({ path: filePath, encoding = 'utf-8' }) => {
    const { root, lexicalPath } = await resolveWorkspacePath(filePath);
    const absolutePath = await revalidateContained(lexicalPath, root);
    const stats = await fs.stat(absolutePath);

    if (!stats.isFile()) {
      throw new Error(`Not a file: ${absolutePath}`);
    }

    // Limit file size to 1MB for text, 5MB for base64
    const maxSize = encoding === 'utf-8' ? 1024 * 1024 : 5 * 1024 * 1024;
    if (stats.size > maxSize) {
      throw new Error(`File too large: ${stats.size} bytes (max: ${maxSize})`);
    }

    const buffer = await fs.readFile(absolutePath);
    const content = encoding === 'base64' ? buffer.toString('base64') : buffer.toString('utf-8');

    return {
      path: absolutePath,
      content,
      size: stats.size,
      encoding,
    };
  },
});

/**
 * Write file contents
 */
export const writeFileTool = defineTool<
  { path: string; content: string; encoding?: 'utf-8' | 'base64'; createDirs?: boolean },
  { path: string; bytesWritten: number; created: boolean }
>({
  name: 'write_file',
  description:
    'Write content to a file within the workspace. Creates the file if it does not exist. Paths outside the workspace and sensitive basenames (.env, *.pem, id_rsa) are rejected.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The file path to write to (must stay inside the workspace)',
      },
      content: {
        type: 'string',
        description: 'The content to write',
      },
      encoding: {
        type: 'string',
        description: 'Content encoding: "utf-8" for text, "base64" for binary data (default: "utf-8")',
        enum: ['utf-8', 'base64'],
      },
      createDirs: {
        type: 'boolean',
        description: 'Create parent directories if they do not exist (default: true)',
      },
    },
    required: ['path', 'content'],
  },
  execute: async ({ path: filePath, content, encoding = 'utf-8', createDirs = true }) => {
    const { root, lexicalPath, realPath } = await resolveWorkspacePath(filePath);
    // Check requested basename too — a `.env` symlink to a normal name must still be refused.
    assertNotSensitivePaths(filePath, realPath);
    assertNotSensitivePaths(lexicalPath, realPath);

    const absolutePath = await revalidateContained(lexicalPath, root);

    // Check if file exists (follow for existence; write uses verified real path)
    let created = false;
    try {
      await fs.access(absolutePath);
    } catch {
      created = true;
    }

    // Create parent directories if needed (parent was validated via realpathExistingPrefix)
    if (createDirs) {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    }

    // Write file to the verified contained path
    const buffer = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf-8');
    await fs.writeFile(absolutePath, buffer);

    return {
      path: absolutePath,
      bytesWritten: buffer.length,
      created,
    };
  },
});

/**
 * List directory contents
 */
export const listDirectoryTool = defineTool<
  { path: string; recursive?: boolean; pattern?: string },
  { path: string; entries: Array<{ name: string; type: 'file' | 'directory'; size?: number }> }
>({
  name: 'list_directory',
  description:
    'List contents of a directory within the workspace. Can list files recursively and filter by pattern. Paths outside the workspace root are rejected.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The directory path to list (must stay inside the workspace)',
      },
      recursive: {
        type: 'boolean',
        description: 'List contents recursively (default: false)',
      },
      pattern: {
        type: 'string',
        description: 'Filter pattern (e.g., "*.ts", "*.json")',
      },
    },
    required: ['path'],
  },
  execute: async ({ path: dirPath, recursive = false, pattern }) => {
    const { root, lexicalPath } = await resolveWorkspacePath(dirPath);
    const absolutePath = await revalidateContained(lexicalPath, root);
    const entries: Array<{ name: string; type: 'file' | 'directory'; size?: number }> = [];

    async function listDir(currentPath: string, prefix = '') {
      const items = await fs.readdir(currentPath, { withFileTypes: true });

      for (const item of items) {
        const relativePath = prefix ? `${prefix}/${item.name}` : item.name;

        // Apply pattern filter if specified
        if (pattern) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
          if (!regex.test(item.name) && item.isFile()) {
            continue;
          }
        }

        if (item.isFile()) {
          const stats = await fs.stat(path.join(currentPath, item.name));
          entries.push({
            name: relativePath,
            type: 'file',
            size: stats.size,
          });
        } else if (item.isDirectory()) {
          entries.push({
            name: relativePath,
            type: 'directory',
          });

          if (recursive) {
            await listDir(path.join(currentPath, item.name), relativePath);
          }
        }
      }
    }

    await listDir(absolutePath);

    return {
      path: absolutePath,
      entries,
    };
  },
});

/**
 * Get file/directory info
 */
export const fileInfoTool = defineTool<
  { path: string },
  {
    path: string;
    exists: boolean;
    type?: 'file' | 'directory' | 'symlink' | 'other';
    size?: number;
    created?: string;
    modified?: string;
    permissions?: string;
  }
>({
  name: 'file_info',
  description:
    'Get detailed information about a file or directory within the workspace. Paths outside the workspace root are rejected.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The file or directory path (must stay inside the workspace)',
      },
    },
    required: ['path'],
  },
  execute: async ({ path: filePath }) => {
    // Soft-resolve so contained symlink entries can be inspected even when
    // their targets escape the workspace or form a cycle. Target containment
    // is required only when following a non-symlink entry.
    const { root, lexicalPath, realPath } =
      await resolveWorkspacePathAllowingTargetEscape(filePath);
    // Require the lexical entry itself to live under the workspace before
    // lstat — otherwise an absolute outside-workspace symlink to an
    // in-workspace target would leak outside-path metadata. The workspace
    // root itself is allowed (assertLexicalEntryContained special-cases it).
    await assertLexicalEntryContained(lexicalPath, root);

    try {
      // Prefer lstat so callers can see symlink identity at the lexical path
      // without following outside/cyclic targets.
      const lstats = await fs.lstat(lexicalPath);
      if (lstats.isSymbolicLink()) {
        return {
          path: lexicalPath,
          exists: true,
          type: 'symlink',
          size: lstats.size,
          created: lstats.birthtime.toISOString(),
          modified: lstats.mtime.toISOString(),
          permissions: (lstats.mode & 0o777).toString(8),
        };
      }

      if (!isPathInsideRoot(realPath, root)) {
        throw new Error(`Path escapes workspace root (${root}): ${filePath}`);
      }
      const absolutePath = await revalidateContained(lexicalPath, root);
      const stats = await fs.stat(absolutePath);

      let type: 'file' | 'directory' | 'symlink' | 'other';
      if (stats.isFile()) type = 'file';
      else if (stats.isDirectory()) type = 'directory';
      else if (stats.isSymbolicLink()) type = 'symlink';
      else type = 'other';

      return {
        path: absolutePath,
        exists: true,
        type,
        size: stats.size,
        created: stats.birthtime.toISOString(),
        modified: stats.mtime.toISOString(),
        permissions: (stats.mode & 0o777).toString(8),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          path: lexicalPath,
          exists: false,
        };
      }
      throw error;
    }
  },
});

/**
 * Delete file or directory
 */
export const deleteTool = defineTool<
  { path: string; recursive?: boolean },
  { path: string; deleted: boolean }
>({
  name: 'delete_path',
  description:
    'Delete a file or directory within the workspace. Use recursive=true for non-empty directories. Paths outside the workspace and sensitive basenames (.env, *.pem, id_rsa) are rejected. In-workspace symlinks are unlinked (the link is removed; the target is left intact).',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The file or directory path to delete (must stay inside the workspace)',
      },
      recursive: {
        type: 'boolean',
        description: 'Delete directories recursively (default: false)',
      },
    },
    required: ['path'],
  },
  execute: async ({ path: targetPath, recursive = false }) => {
    // Soft-resolve so an in-workspace symlink whose target escapes can still
    // be unlinked. Lexical-entry containment is required before any mutation;
    // target containment is required only for non-symlink entries.
    const { root, lexicalPath, realPath } =
      await resolveWorkspacePathAllowingTargetEscape(targetPath);
    assertNotSensitivePaths(targetPath, lexicalPath);
    await assertLexicalEntryContained(lexicalPath, root);

    try {
      const stats = await fs.lstat(lexicalPath);

      if (stats.isSymbolicLink()) {
        await fs.unlink(lexicalPath);
        return { path: lexicalPath, deleted: true };
      }

      if (!isPathInsideRoot(realPath, root)) {
        throw new Error(`Path escapes workspace root (${root}): ${targetPath}`);
      }
      assertNotSensitivePaths(targetPath, realPath);
      await revalidateContained(lexicalPath, root);

      if (stats.isFile()) {
        await fs.unlink(lexicalPath);
      } else if (stats.isDirectory()) {
        await fs.rm(lexicalPath, { recursive });
      } else {
        await fs.unlink(lexicalPath);
      }

      return { path: lexicalPath, deleted: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { path: lexicalPath, deleted: false };
      }
      throw error;
    }
  },
});

/**
 * All filesystem tools
 */
export const filesystemTools = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  fileInfoTool,
  deleteTool,
];
