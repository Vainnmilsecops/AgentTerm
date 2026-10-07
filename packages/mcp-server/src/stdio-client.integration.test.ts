import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

it('negotiates and reads a Task through a built server process over real stdio pipes', async () => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/stdio-host.mjs', import.meta.url))],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 8_000,
    },
  );
  const exit = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  const responses = lines[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const send = (message: unknown): void => {
    child.stdin.write(JSON.stringify(message) + '\n');
  };
  const receive = async () => {
    const line = await responses.next();
    if (line.done) throw new Error('MCP server closed before responding: ' + stderr);
    return JSON.parse(line.value);
  };
  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stdio-client', version: '1' },
      },
    });
    expect(await receive()).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listed = await receive();
    expect(listed.id).toBe(2);
    expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      'get-task',
      'list-projects',
      'list-tasks',
      'read-pane-content',
    ]);
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get-task', arguments: { taskId: 'task-1' } },
    });
    const called = await receive();
    expect(called.id).toBe(3);
    expect(called.result.isError).toBe(false);
    expect(JSON.parse(called.result.content[0].text)).toMatchObject({
      id: 'task-1',
      title: 'Kiểm thử MCP 🚀',
      phase: 'BACKLOG',
    });
    child.stdin.end();
    const [code] = await exit;
    expect(code).toBe(0);
    expect(stderr).toBe('');
  } finally {
    lines.close();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
  }
}, 10_000);
