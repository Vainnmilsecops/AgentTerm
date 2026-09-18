import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ManagedTaskContextStore } from './task-context-store';

async function fixture(run: (root: string, store: ManagedTaskContextStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'agentterm-context-'));
  try {
    await run(root, new ManagedTaskContextStore(join(root, 'managed')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
describe('managed task context store', () => {
  it('writes the validated snapshot even if the caller changes its input buffer', async () => {
    await fixture(async (root, store) => {
      const bytes = new Uint8Array([65]);
      const pending = store.put('task', { name: 'a.txt', mime: 'text/plain', bytes });
      bytes[0] = 0;
      const record = await pending;
      const taskDir = createHash('sha256').update('task').digest('hex');
      expect(await readFile(join(root, 'managed', taskDir, record.id))).toEqual(Buffer.from([65]));
    });
  });
  it.each([
    {
      name: 'pixel.png',
      mime: 'image/png',
      bytes: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
    },
    { name: 'note.json', mime: 'application/json', bytes: Buffer.from('{"ok":true}') },
    { name: 'note.md', mime: '', bytes: Buffer.from('# Note') },
  ])('accepts supported content $name', async (file) => {
    await fixture(async (_root, store) => {
      expect((await store.put('task', file)).size).toBe(file.bytes.length);
    });
  });
  it.each([
    { name: 'empty.txt', mime: 'text/plain', bytes: new Uint8Array() },
    { name: 'large.txt', mime: 'text/plain', bytes: new Uint8Array(8 * 1024 * 1024 + 1) },
    { name: 'fake.pdf', mime: 'application/pdf', bytes: Buffer.from('plain text') },
    { name: 'fake.jpg', mime: 'image/jpeg', bytes: Buffer.from('plain text') },
    { name: 'bad.json', mime: 'application/json', bytes: Buffer.from('{') },
    { name: 'binary.txt', mime: 'text/plain', bytes: new Uint8Array([0, 255]) },
  ])('rejects invalid content $name', async (file) => {
    await fixture(async (_root, store) => {
      await expect(store.put('task', file)).rejects.toThrow();
    });
  });
  it('copies Unicode text to generated task-scoped names with an exact digest', async () => {
    await fixture(async (root, store) => {
      const bytes = new TextEncoder().encode('Xin chào 👋');
      const record = await store.put('task', { name: 'ghi-chú.txt', mime: 'text/plain', bytes });
      const taskDir = createHash('sha256').update('task').digest('hex');
      expect(await readFile(join(root, 'managed', taskDir, record.id))).toEqual(Buffer.from(bytes));
      expect(record.digest).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(JSON.stringify(record)).not.toContain(root);
    });
  });
  it.each(['../secret.txt', 'CON.txt', 'x.txt:stream', 'x.exe', 'x\\a.txt'])(
    'rejects hostile name %s',
    async (name) => {
      await fixture(async (_root, store) => {
        await expect(
          store.put('task', { name, mime: 'text/plain', bytes: new TextEncoder().encode('safe') }),
        ).rejects.toThrow();
      });
    },
  );
  it('rejects a text payload pretending to be an image', async () => {
    await fixture(async (_root, store) => {
      await expect(
        store.put('task', {
          name: 'fake.png',
          mime: 'image/png',
          bytes: new TextEncoder().encode('not an image'),
        }),
      ).rejects.toThrow('TYPE');
    });
  });
  it('refuses a managed-root junction without writing outside', async () => {
    await fixture(async (root, store) => {
      const outside = await mkdtemp(join(tmpdir(), 'agentterm-context-outside-'));
      try {
        await symlink(outside, join(root, 'managed'), 'junction');
        await expect(
          store.put('task', { name: 'a.txt', mime: 'text/plain', bytes: new Uint8Array([65]) }),
        ).rejects.toThrow();
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
