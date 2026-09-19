import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import {
  TaskContextError,
  validateContextBatch,
  type TaskContextFile,
  type TaskContextStore,
  type TaskContextAttachment,
  type TaskContextExporter,
} from '@agentterm/application';

const types: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
};
function inspect(file: TaskContextFile): string {
  validateContextBatch([file]);
  if (
    typeof file.name !== 'string' ||
    file.name.length > 120 ||
    !/^[\p{L}\p{N} _().-]+$/u.test(file.name) ||
    file.name.startsWith('.') ||
    /[. ]$/u.test(file.name) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(file.name)
  )
    throw new TaskContextError('NAME');
  const ext = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  const mime = types[ext];
  if (
    !mime ||
    (file.mime !== '' && file.mime !== mime && !(ext === 'md' && file.mime === 'text/plain'))
  )
    throw new TaskContextError('TYPE');
  const data = Buffer.from(file.bytes);
  if (mime === 'image/png') {
    if (
      data.length < 45 ||
      data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      data.readUInt32BE(8) !== 13 ||
      data.toString('ascii', 12, 16) !== 'IHDR' ||
      data.readUInt32BE(16) < 1 ||
      data.readUInt32BE(20) < 1 ||
      data.subarray(-12).toString('hex') !== '0000000049454e44ae426082'
    )
      throw new TaskContextError('TYPE');
  } else if (mime === 'image/jpeg') {
    if (
      data.length < 4 ||
      data[0] !== 255 ||
      data[1] !== 216 ||
      data[2] !== 255 ||
      data.at(-2) !== 255 ||
      data.at(-1) !== 217
    )
      throw new TaskContextError('TYPE');
  } else if (mime === 'application/pdf') {
    if (
      !/^%PDF-1\.[0-7]|^%PDF-2\.0/u.test(data.subarray(0, 8).toString('ascii')) ||
      !/%%EOF\s*$/u.test(data.subarray(-1024).toString('ascii'))
    )
      throw new TaskContextError('TYPE');
  } else {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      throw new TaskContextError('TYPE');
    }
    for (const char of text) {
      const code = char.codePointAt(0)!;
      if (code < 32 && ![9, 10, 13].includes(code)) throw new TaskContextError('TYPE');
    }
    if (mime === 'application/json') {
      try {
        JSON.parse(text);
      } catch {
        throw new TaskContextError('TYPE');
      }
    }
  }
  return mime;
}

// Check every existing ancestor, not just the final component (Windows junctions
// are reported as symbolic links by lstat). The application owns this private root.
async function assertDirectory(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TaskContextError('SAVE_FAILED');
    if (current === parse(current).root) break;
    current = dirname(current);
  }
  if ((await realpath(path)).toLowerCase() !== resolve(path).toLowerCase())
    throw new TaskContextError('SAVE_FAILED');
}
async function ensureDirectory(path: string): Promise<void> {
  await assertDirectory(dirname(path));
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await assertDirectory(path);
}
export class ManagedTaskContextStore implements TaskContextStore, TaskContextExporter {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  async exportToWorktree(record: TaskContextAttachment, worktreePath: string): Promise<string> {
    try {
      const extensions: Readonly<Record<string, string>> = {
        'text/plain': 'txt',
        'text/markdown': 'md',
        'application/json': 'json',
      };
      const extension = extensions[record.mime];
      if (
        !extension ||
        record.size < 1 ||
        record.size > 65536 ||
        !/^[0-9a-f]{64}$/u.test(record.digest) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(record.id)
      )
        throw new TaskContextError('TYPE');
      const source = join(
        this.root,
        createHash('sha256').update(record.taskId).digest('hex'),
        record.id,
      );
      const bytes = await readVerifiedContext(source, record);
      inspect({ name: record.name, mime: record.mime, bytes });
      await assertDirectory(worktreePath);
      const targetRoot = join(worktreePath, 'agentterm-context');
      await ensureDirectory(targetRoot);
      const relativePath = `agentterm-context/${record.id}.${extension}`;
      const target = join(worktreePath, relativePath);
      let handle;
      try {
        handle = await open(target, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await readVerifiedContext(target, record);
        return relativePath;
      }
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await readVerifiedContext(target, record);
      return relativePath;
    } catch {
      throw new TaskContextError('SAVE_FAILED');
    }
  }
  async put(taskId: string, file: TaskContextFile) {
    validateContextBatch([file]);
    file = { name: file.name, mime: file.mime, bytes: Buffer.from(file.bytes) };
    const mime = inspect(file);
    await ensureDirectory(this.root);
    const taskRoot = join(this.root, createHash('sha256').update(taskId).digest('hex'));
    await ensureDirectory(taskRoot);
    if ((await readdir(taskRoot)).length >= 64) throw new TaskContextError('LIMIT');
    const id = randomUUID();
    const handle = await open(join(taskRoot, id), 'wx', 0o600);
    try {
      await handle.writeFile(file.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertDirectory(taskRoot);
    return Object.freeze({
      id,
      name: file.name,
      mime,
      size: file.bytes.byteLength,
      digest: createHash('sha256').update(file.bytes).digest('hex'),
    });
  }
}

async function readVerifiedContext(path: string, record: TaskContextAttachment): Promise<Buffer> {
  await assertDirectory(dirname(path));
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size !== record.size
  )
    throw new TaskContextError('SAVE_FAILED');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.nlink !== 1 ||
      !opened.isFile()
    )
      throw new TaskContextError('SAVE_FAILED');
    const buffer = Buffer.alloc(record.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (
      length !== record.size ||
      createHash('sha256').update(buffer.subarray(0, length)).digest('hex') !== record.digest
    )
      throw new TaskContextError('SAVE_FAILED');
    await assertDirectory(dirname(path));
    const after = await lstat(path);
    if (
      after.isSymbolicLink() ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.nlink !== 1
    )
      throw new TaskContextError('SAVE_FAILED');
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
