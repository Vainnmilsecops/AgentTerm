import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, rename, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManagedTaskContextStore } from './task-context-store';

async function fixture(
  run: (
    store: ManagedTaskContextStore,
    record: Awaited<ReturnType<ManagedTaskContextStore['put']>> & {
      taskId: string;
      sessionId: string;
      createdAt: number;
    },
    path: string,
  ) => Promise<void>,
  text = 'Xin chào 👋\n<script>not executed</script>',
) {
  const root = await mkdtemp(join(tmpdir(), 'agentterm-context-preview-'));
  try {
    const store = new ManagedTaskContextStore(join(root, 'private'));
    const record = {
      ...(await store.put('task', {
        name: 'ghi-chú.txt',
        mime: 'text/plain',
        bytes: Buffer.from(text),
      })),
      taskId: 'task',
      sessionId: 'session',
      createdAt: 1,
    };
    await run(
      store,
      record,
      join(root, 'private', createHash('sha256').update('task').digest('hex'), record.id),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
describe('verified saved context text', () => {
  it('rejects invalid UTF-8 even when size and digest match', async () => {
    await fixture(async (store, record, path) => {
      const bytes = Buffer.from([0xc3, 0x28]);
      await writeFile(path, bytes);
      await expect(
        store.readText({
          ...record,
          size: bytes.length,
          digest: createHash('sha256').update(bytes).digest('hex'),
        }),
      ).rejects.toThrow('CONTEXT_READ_FAILED');
    });
  });
  it('reads exact Unicode and markup literally after reopening the store', async () => {
    await fixture(async (store, record, path) => {
      const reopened = new ManagedTaskContextStore(dirname(dirname(path)));
      expect(await reopened.readText(record)).toBe('Xin chào 👋\n<script>not executed</script>');
      expect(await readFile(path, 'utf8')).toBe('Xin chào 👋\n<script>not executed</script>');
    });
  });
  it('rejects same-size tampering using the digest', async () => {
    await fixture(async (store, record, path) => {
      await writeFile(path, Buffer.alloc(record.size, 65));
      await expect(store.readText(record)).rejects.toThrow('CONTEXT_READ_FAILED');
    });
  });
  it('rejects missing files with a sanitized error', async () => {
    await fixture(async (store, record, path) => {
      await rename(path, `${path}.preserved`);
      await expect(store.readText(record)).rejects.toThrow('CONTEXT_READ_FAILED');
    });
  });
  it('rejects hard-linked content', async () => {
    await fixture(async (store, record, path) => {
      await link(path, `${path}.linked`);
      await expect(store.readText(record)).rejects.toThrow('CONTEXT_READ_FAILED');
    });
  });
  it('rejects a source directory replaced by a junction', async () => {
    await fixture(async (store, record, path) => {
      const dir = join(path, '..');
      await rename(dir, `${dir}-preserved`);
      await symlink(`${dir}-preserved`, dir, 'junction');
      await expect(store.readText(record)).rejects.toThrow('CONTEXT_READ_FAILED');
    });
  });
  it('accepts 64 KiB but refuses a larger snapshot without truncation', async () => {
    await fixture(
      async (store, record) => expect(await store.readText(record)).toHaveLength(65536),
      'a'.repeat(65536),
    );
    await fixture(async (store, record) => {
      await expect(store.readText(record)).rejects.toThrow();
    }, 'a'.repeat(65537));
  });
  it('rejects malicious identifiers and invalid metadata before reading', async () => {
    await fixture(async (store, record) => {
      for (const change of [
        { id: '../escape' },
        { size: NaN },
        { mime: 'image/png' },
        { digest: 'invalid' },
      ])
        await expect(store.readText({ ...record, ...change })).rejects.toThrow(
          'CONTEXT_READ_FAILED',
        );
    });
  });
});
