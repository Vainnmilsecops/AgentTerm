import { McpServer } from './server';
import {
  MCP_JSON_RPC_ERRORS,
  type McpJsonRpcRequest,
  type McpJsonRpcResponse,
} from './protocol';

export interface McpStdioServerOptions {
  readonly authToken: string | undefined;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly server: McpServer;
}

export async function runMcpStdioServer(options: McpStdioServerOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  await pumpJsonRpc(input, output, options.server, options.authToken);
}

async function pumpJsonRpc(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  server: McpServer,
  authToken: string | undefined,
): Promise<void> {
  const decoder = new LineDecoder();
  for await (const line of readLines(input)) {
    decoder.push(line);
    while (decoder.hasMessage()) {
      const raw = decoder.consume();
      const response = await handleRaw(raw, server, authToken);
      if (response !== undefined) {
        writeResponse(output, response);
      }
    }
  }
}

async function handleRaw(
  raw: string,
  server: McpServer,
  authToken: string | undefined,
): Promise<McpJsonRpcResponse | undefined> {
  if (raw.trim().length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      error: {
        code: MCP_JSON_RPC_ERRORS.PARSE_ERROR,
        data: error instanceof Error ? error.message : String(error),
        message: 'JSON-RPC payload could not be parsed.',
      },
      id: 0,
      jsonrpc: '2.0',
    };
  }
  if (!isJsonRpcRequest(parsed)) {
    return {
      error: {
        code: MCP_JSON_RPC_ERRORS.INVALID_PARAMS,
        message: 'JSON-RPC payload is not a valid Request object.',
      },
      id: 0,
      jsonrpc: '2.0',
    };
  }
  const dispatch = await server.dispatch(parsed, { token: authToken });
  return dispatch.response;
}

function writeResponse(output: NodeJS.WritableStream, response: McpJsonRpcResponse): void {
  const payload = JSON.stringify(response);
  output.write(`${payload}\n`);
}

function isJsonRpcRequest(value: unknown): value is McpJsonRpcRequest {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.jsonrpc === '2.0' &&
    typeof record.method === 'string' &&
    (typeof record.id === 'number' || typeof record.id === 'string')
  );
}

async function* readLines(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      yield buffer.slice(0, newlineIndex).replace(/\r$/u, '');
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  if (buffer.length > 0) {
    yield buffer.replace(/\r$/u, '');
  }
}

class LineDecoder {
  private buffer = '';

  public push(line: string): void {
    this.buffer = this.buffer.length === 0 ? line : `${this.buffer}\n${line}`;
  }

  public hasMessage(): boolean {
    return this.buffer.includes('\n');
  }

  public consume(): string {
    const newlineIndex = this.buffer.indexOf('\n');
    const head = this.buffer.slice(0, newlineIndex);
    this.buffer = this.buffer.slice(newlineIndex + 1);
    return head;
  }
}