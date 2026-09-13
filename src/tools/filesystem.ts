import * as fs from 'fs/promises';
import * as path from 'path';
import { defineTool } from '../core/tool-executor.js';
import { throwIfAborted } from '../utils/abort.js';

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
  description: 'Read the contents of a file. Supports text files (utf-8) and binary files (base64).',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The file path to read (absolute or relative to working directory)',
      },
      encoding: {
        type: 'string',
        description: 'File encoding: "utf-8" for text, "base64" for binary (default: "utf-8")',
        enum: ['utf-8', 'base64'],
      },
    },
    required: ['path'],
  },
  execute: async ({ path: filePath, encoding = 'utf-8' }, signal) => {
    throwIfAborted(signal);
    const absolutePath = path.resolve(filePath);
    const stats = await fs.stat(absolutePath);

    if (!stats.isFile()) {
      throw new Error(`Not a file: ${absolutePath}`);
    }

    // Limit file size to 1MB for text, 5MB for base64
    const maxSize = encoding === 'utf-8' ? 1024 * 1024 : 5 * 1024 * 1024;
    if (stats.size > maxSize) {
      throw new Error(`File too large: ${stats.size} bytes (max: ${maxSize})`);
    }

    throwIfAborted(signal);
    const buffer = await fs.readFile(absolutePath, { signal });
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
  description: 'Write content to a file. Creates the file if it does not exist.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The file path to write to',
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
  execute: async ({ path: filePath, content, encoding = 'utf-8', createDirs = true }, signal) => {
    throwIfAborted(signal);
    const absolutePath = path.resolve(filePath);

    // Check if file exists
    let created = false;
    try {
      await fs.access(absolutePath);
    } catch {
      created = true;
    }

    throwIfAborted(signal);

    // Create parent directories if needed
    if (createDirs) {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    }

    throwIfAborted(signal);

    // Write file
    const buffer = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf-8');
    await fs.writeFile(absolutePath, buffer, { signal });

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
  description: 'List contents of a directory. Can list files recursively and filter by pattern.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The directory path to list',
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
  execute: async ({ path: dirPath, recursive = false, pattern }, signal) => {
    throwIfAborted(signal);
    const absolutePath = path.resolve(dirPath);
    const entries: Array<{ name: string; type: 'file' | 'directory'; size?: number }> = [];

    async function listDir(currentPath: string, prefix = '') {
      throwIfAborted(signal);
      const items = await fs.readdir(currentPath, { withFileTypes: true });

      for (const item of items) {
        throwIfAborted(signal);
        const relativePath = prefix ? `${prefix}/${item.name}` : item.name;

        // Apply pattern filter if specified
        if (pattern) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
          if (!regex.test(item.name) && item.isFile()) {
            continue;
          }
        }

        if (item.isFile()) {
          throwIfAborted(signal);
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
  description: 'Get detailed information about a file or directory.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The file or directory path',
      },
    },
    required: ['path'],
  },
  execute: async ({ path: filePath }, signal) => {
    throwIfAborted(signal);
    const absolutePath = path.resolve(filePath);

    try {
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
          path: absolutePath,
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
  description: 'Delete a file or directory. Use recursive=true for non-empty directories.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The file or directory path to delete',
      },
      recursive: {
        type: 'boolean',
        description: 'Delete directories recursively (default: false)',
      },
    },
    required: ['path'],
  },
  execute: async ({ path: targetPath, recursive = false }, signal) => {
    throwIfAborted(signal);
    const absolutePath = path.resolve(targetPath);

    /**
     * Walk the tree and delete entry-by-entry so abort can interrupt between
     * children. A single `fs.rm({ recursive })` cannot observe cancellation.
     */
    async function deleteRecursive(currentPath: string): Promise<void> {
      throwIfAborted(signal);
      const items = await fs.readdir(currentPath, { withFileTypes: true });

      for (const item of items) {
        throwIfAborted(signal);
        const childPath = path.join(currentPath, item.name);
        if (item.isDirectory()) {
          await deleteRecursive(childPath);
        } else {
          await fs.unlink(childPath);
        }
      }

      throwIfAborted(signal);
      await fs.rmdir(currentPath);
    }

    try {
      const stats = await fs.stat(absolutePath);

      throwIfAborted(signal);

      if (stats.isDirectory()) {
        if (recursive) {
          await deleteRecursive(absolutePath);
        } else {
          await fs.rmdir(absolutePath);
        }
      } else {
        await fs.unlink(absolutePath);
      }

      return { path: absolutePath, deleted: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { path: absolutePath, deleted: false };
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
