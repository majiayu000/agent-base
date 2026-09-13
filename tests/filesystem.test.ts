import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  getWorkspaceRoot,
  isPathInsideRoot,
  resolveWithinWorkspace,
  setWorkspaceRoot,
} from '../src/utils/path-safety.js';
import {
  deleteTool,
  fileInfoTool,
  listDirectoryTool,
  readFileTool,
  writeFileTool,
} from '../src/tools/filesystem.js';

describe('resolveWithinWorkspace', () => {
  let workspace: string;
  let realWorkspace: string;
  const prevEnv = process.env.AGENT_BASE_WORKSPACE_ROOT;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-base-ws-'));
    realWorkspace = await fs.realpath(workspace);
    setWorkspaceRoot(workspace);
    delete process.env.AGENT_BASE_WORKSPACE_ROOT;
    await fs.writeFile(path.join(workspace, 'ok.txt'), 'hello');
    await fs.mkdir(path.join(workspace, 'subdir'));
    await fs.writeFile(path.join(workspace, 'subdir', 'nested.txt'), 'nested');
  });

  afterEach(async () => {
    setWorkspaceRoot(undefined);
    if (prevEnv === undefined) {
      delete process.env.AGENT_BASE_WORKSPACE_ROOT;
    } else {
      process.env.AGENT_BASE_WORKSPACE_ROOT = prevEnv;
    }
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('allows relative paths inside the workspace', async () => {
    const resolved = await resolveWithinWorkspace('ok.txt');
    expect(resolved).toBe(path.join(realWorkspace, 'ok.txt'));
  });

  it('allows absolute paths that stay inside the workspace', async () => {
    const resolved = await resolveWithinWorkspace(path.join(workspace, 'subdir', 'nested.txt'));
    expect(resolved).toBe(path.join(realWorkspace, 'subdir', 'nested.txt'));
  });

  it('rejects ../ escapes outside the workspace', async () => {
    await expect(resolveWithinWorkspace('../outside.txt')).rejects.toThrow(/escapes workspace/i);
    await expect(resolveWithinWorkspace('subdir/../../outside.txt')).rejects.toThrow(
      /escapes workspace/i
    );
  });

  it('rejects absolute paths outside the workspace', async () => {
    await expect(resolveWithinWorkspace('/etc/passwd')).rejects.toThrow(/escapes workspace/i);
    await expect(resolveWithinWorkspace(path.join(os.tmpdir(), 'other-file'))).rejects.toThrow(
      /escapes workspace/i
    );
  });

  it('rejects symlink escapes when the link target is outside the root', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-base-out-'));
    try {
      await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'secret');
      await fs.symlink(outsideDir, path.join(workspace, 'escape-link'));

      await expect(resolveWithinWorkspace('escape-link/secret.txt')).rejects.toThrow(
        /escapes workspace/i
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('resolves non-existent paths under an existing parent (create case)', async () => {
    const resolved = await resolveWithinWorkspace('subdir/new-file.txt');
    expect(resolved).toBe(path.join(realWorkspace, 'subdir', 'new-file.txt'));
  });

  it('honors AGENT_BASE_WORKSPACE_ROOT when module config is cleared', async () => {
    setWorkspaceRoot(undefined);
    process.env.AGENT_BASE_WORKSPACE_ROOT = workspace;
    expect(getWorkspaceRoot()).toBe(path.resolve(workspace));
    const resolved = await resolveWithinWorkspace('ok.txt');
    expect(resolved).toBe(path.join(realWorkspace, 'ok.txt'));
  });

  it('isPathInsideRoot treats root itself as inside', () => {
    expect(isPathInsideRoot(workspace, workspace)).toBe(true);
    expect(isPathInsideRoot(path.join(workspace, 'a'), workspace)).toBe(true);
    expect(isPathInsideRoot(path.dirname(workspace), workspace)).toBe(false);
  });
});

describe('filesystem tools workspace guards', () => {
  let workspace: string;
  let realWorkspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-base-fs-'));
    realWorkspace = await fs.realpath(workspace);
    setWorkspaceRoot(workspace);
    await fs.writeFile(path.join(workspace, 'readme.txt'), 'content');
  });

  afterEach(async () => {
    setWorkspaceRoot(undefined);
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('read_file succeeds for in-root relative path', async () => {
    const result = await readFileTool.execute({ path: 'readme.txt' });
    expect(result.content).toBe('content');
    expect(result.path).toBe(path.join(realWorkspace, 'readme.txt'));
  });

  it('write_file + read_file round-trip on in-root temp path', async () => {
    const written = await writeFileTool.execute({
      path: 'tmp/smoke.txt',
      content: 'smoke-ok',
    });
    expect(written.created).toBe(true);
    const read = await readFileTool.execute({ path: 'tmp/smoke.txt' });
    expect(read.content).toBe('smoke-ok');
  });

  it('read_file rejects ../ escape', async () => {
    await expect(readFileTool.execute({ path: '../readme.txt' })).rejects.toThrow(
      /escapes workspace/i
    );
  });

  it('write_file rejects absolute outside-root path', async () => {
    await expect(
      writeFileTool.execute({
        path: path.join(os.tmpdir(), 'agent-base-escape.txt'),
        content: 'nope',
      })
    ).rejects.toThrow(/escapes workspace/i);
  });

  it('list_directory and file_info reject escapes', async () => {
    await expect(listDirectoryTool.execute({ path: '..' })).rejects.toThrow(/escapes workspace/i);
    await expect(fileInfoTool.execute({ path: '/etc' })).rejects.toThrow(/escapes workspace/i);
  });

  it('list_directory works for workspace root', async () => {
    const result = await listDirectoryTool.execute({ path: '.' });
    expect(result.entries.some((e) => e.name === 'readme.txt')).toBe(true);
  });

  it('delete_path rejects escapes and sensitive basenames', async () => {
    await expect(deleteTool.execute({ path: '../readme.txt' })).rejects.toThrow(
      /escapes workspace/i
    );
    await expect(deleteTool.execute({ path: '.env' })).rejects.toThrow(/sensitive/i);
    await expect(writeFileTool.execute({ path: 'id_rsa', content: 'x' })).rejects.toThrow(
      /sensitive/i
    );
    await expect(writeFileTool.execute({ path: 'cert.pem', content: 'x' })).rejects.toThrow(
      /sensitive/i
    );
  });

  it('delete_path removes in-root files', async () => {
    await writeFileTool.execute({ path: 'todelete.txt', content: 'bye' });
    const result = await deleteTool.execute({ path: 'todelete.txt' });
    expect(result.deleted).toBe(true);
    const info = await fileInfoTool.execute({ path: 'todelete.txt' });
    expect(info.exists).toBe(false);
  });

  it('delete_path unlinks an in-workspace symlink without deleting its target', async () => {
    const target = path.join(workspace, 'keep-me.txt');
    await fs.writeFile(target, 'preserve');
    await fs.symlink(target, path.join(workspace, 'link-to-keep.txt'));

    const result = await deleteTool.execute({ path: 'link-to-keep.txt' });
    expect(result.deleted).toBe(true);

    await expect(fs.lstat(path.join(workspace, 'link-to-keep.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(target, 'utf-8')).toBe('preserve');
  });

  it('write_file rejects .env even when it is a symlink to a normal basename', async () => {
    const target = path.join(workspace, 'innocent.txt');
    await fs.writeFile(target, 'before');
    await fs.symlink(target, path.join(workspace, '.env'));

    await expect(
      writeFileTool.execute({ path: '.env', content: 'exfiltrated' })
    ).rejects.toThrow(/sensitive/i);

    expect(await fs.readFile(target, 'utf-8')).toBe('before');
  });

  it('delete_path rejects .env even when it is a symlink to a normal basename', async () => {
    const target = path.join(workspace, 'innocent-del.txt');
    await fs.writeFile(target, 'before');
    await fs.symlink(target, path.join(workspace, '.env'));

    await expect(deleteTool.execute({ path: '.env' })).rejects.toThrow(/sensitive/i);
    expect(await fs.readFile(target, 'utf-8')).toBe('before');
  });
});
