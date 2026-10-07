import { once } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { McpServer, runMcpStdioServer } from './index';

function makeServer() {
  return new McpServer({
    authToken: 'test-grant',
    handlers: {
      'get-task': {
        definition: {
          name: 'get-task',
          description: 'Read a task',
          inputSchema: { type: 'object' },
        },
        async invoke(params) {
          return { title: params.title };
        },
      },
    },
  });
}

async function exchange(chunks: readonly (Buffer | string)[]) {
  let output = '';
  const writable = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  await runMcpStdioServer({
    server: makeServer(),
    authToken: 'test-grant',
    input: Readable.from(chunks),
    output: writable,
  });
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('MCP stdio transport', () => {
  it('rejects an oversized frame once and recovers at the next message boundary', async () => {
    const responses = await exchange([
      Buffer.alloc(1_048_576, 32),
      'x\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
    ]);
    expect(responses).toEqual([
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'MCP message exceeds the 1 MiB limit.' },
      },
      { jsonrpc: '2.0', id: 1, result: {} },
    ]);
  });

  it('rejects invalid UTF-8 without returning partially decoded tool data', async () => {
    const responses = await exchange([
      Buffer.concat([
        Buffer.from('{"jsonrpc":"2.0","id":1,"method":"get-task","params":{"title":"'),
        Buffer.from([0xff]),
        Buffer.from('"}}\n'),
      ]),
    ]);
    expect(responses).toMatchObject([{ id: null, error: { code: -32700 } }]);
  });

  it('waits for output writes to finish and surfaces output failures', async () => {
    const callbacks: (() => void)[] = [];
    let signalWrite: () => void = () => undefined;
    const writeStarted = new Promise<void>((resolve) => {
      signalWrite = resolve;
    });
    const output = new Writable({
      write(_chunk, _encoding, done) {
        callbacks.push(done);
        signalWrite();
      },
    });
    const input = new PassThrough();
    const running = runMcpStdioServer({
      server: makeServer(),
      authToken: 'test-grant',
      input,
      output,
    });
    let finished = false;
    void running.then(() => {
      finished = true;
    });
    input.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    try {
      await writeStarted;
      // Let EOF processing settle: the loop must still await the held write.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      expect(callbacks).toHaveLength(1);
    } finally {
      callbacks[0]?.();
      await running;
      output.destroy();
    }

    const broken = new Writable({
      write(_chunk, _encoding, done) {
        done(new Error('output unavailable'));
      },
    });
    await expect(
      runMcpStdioServer({
        server: makeServer(),
        authToken: 'test-grant',
        input: Readable.from(['{"jsonrpc":"2.0","id":1,"method":"ping"}\n']),
        output: broken,
      }),
    ).rejects.toThrow('output unavailable');
  });
  it('answers a single newline-delimited request while stdin remains open', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const running = runMcpStdioServer({
      server: makeServer(),
      authToken: 'test-grant',
      input,
      output,
    });
    try {
      const response = once(output, 'data');
      input.write(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'get-task', params: { title: 'ready' } }) +
          '\n',
      );
      const [chunk] = await response;
      expect(JSON.parse(chunk.toString())).toMatchObject({ id: 1, result: { title: 'ready' } });
    } finally {
      input.end();
      await running;
      output.destroy();
    }
  });

  it('preserves split Vietnamese UTF-8 bytes and the final request at EOF', async () => {
    const message = Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'unicode',
        method: 'get-task',
        params: { title: 'Tiếng Việt 🚀' },
      }) + '\n',
    );
    const split = message.indexOf(Buffer.from('ế')) + 1;
    const responses = await exchange([
      message.subarray(0, split),
      message.subarray(split),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'get-task', params: { title: 'last' } }),
    ]);
    expect(responses).toEqual([
      { jsonrpc: '2.0', id: 'unicode', result: { title: 'Tiếng Việt 🚀' } },
      { jsonrpc: '2.0', id: 2, result: { title: 'last' } },
    ]);
  });

  it('runs a standard initialize/list/call exchange and never responds to notifications', async () => {
    const messages = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'client', version: '1' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get-task', arguments: { title: 'Xin chào' } },
      },
      {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 42, reason: 'not active' },
      },
    ];
    const responses = await exchange([
      messages.map((message) => JSON.stringify(message)).join('\r\n') + '\r\n',
    ]);
    expect(responses.map((response) => response.id)).toEqual([1, 2, 3]);
    expect(responses[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'get-task',
    ]);
    expect(JSON.parse(responses[2].result.content[0].text)).toEqual({ title: 'Xin chào' });
  });

  it('rejects malformed requests without echoing raw payloads and keeps reading', async () => {
    const responses = await exchange([
      '{"SECRET_TOKEN":\n',
      '{"jsonrpc":"2.0","id":true,"method":"get-task"}\n',
      '{"jsonrpc":"2.0","id":3,"method":"ping"}\n',
    ]);
    expect(responses.map((response) => [response.id, response.error?.code ?? 'success'])).toEqual([
      [null, -32700],
      [null, -32600],
      [3, 'success'],
    ]);
    expect(JSON.stringify(responses)).not.toContain('SECRET_TOKEN');
  });
});
