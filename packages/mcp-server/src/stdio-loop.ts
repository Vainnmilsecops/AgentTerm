import { McpServer } from './server';
import { MCP_JSON_RPC_ERRORS, type McpJsonRpcMessage, type McpJsonRpcResponse } from './protocol';

export const MAX_MCP_MESSAGE_BYTES = 1_048_576;

export interface McpStdioServerOptions {
  /** Explicit local transport grant. Never read a token from a JSON-RPC payload. */
  readonly authToken: string | undefined;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly server: McpServer;
}

export async function runMcpStdioServer(options: McpStdioServerOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  for await (const frame of readFrames(input)) {
    const response =
      frame.kind === 'message'
        ? await handleRaw(frame.raw, options.server, options.authToken)
        : {
            error: {
              code:
                frame.kind === 'oversized'
                  ? MCP_JSON_RPC_ERRORS.INVALID_REQUEST
                  : MCP_JSON_RPC_ERRORS.PARSE_ERROR,
              message:
                frame.kind === 'oversized'
                  ? 'MCP message exceeds the 1 MiB limit.'
                  : 'MCP message must be valid UTF-8.',
            },
            id: null,
            jsonrpc: '2.0' as const,
          };
    if (response !== undefined) await writeResponse(output, response);
  }
}

async function handleRaw(
  raw: string,
  server: McpServer,
  authToken: string | undefined,
): Promise<McpJsonRpcResponse | undefined> {
  if (raw.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      error: {
        code: MCP_JSON_RPC_ERRORS.PARSE_ERROR,
        message: 'JSON-RPC payload could not be parsed.',
      },
      id: null,
      jsonrpc: '2.0',
    };
  }
  if (!isJsonRpcMessage(parsed)) {
    return {
      error: {
        code: MCP_JSON_RPC_ERRORS.INVALID_REQUEST,
        message: 'JSON-RPC payload is not a valid message.',
      },
      id: null,
      jsonrpc: '2.0',
    };
  }
  return (await server.dispatch(parsed, { token: authToken })).response;
}

async function writeResponse(
  output: NodeJS.WritableStream,
  response: McpJsonRpcResponse,
): Promise<void> {
  const payload = JSON.stringify(response) + '\n';
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      output.removeListener('error', onError);
      reject(error);
    };
    output.once('error', onError);
    try {
      output.write(payload, (error?: Error | null) => {
        // Node emits the error event after the write callback. Keep its listener
        // until then so a failed output cannot become an unhandled stream error.
        if (error) {
          reject(error);
          return;
        }
        output.removeListener('error', onError);
        resolve();
      });
    } catch (error) {
      output.removeListener('error', onError);
      reject(error);
    }
  });
}

function isJsonRpcMessage(value: unknown): value is McpJsonRpcMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.jsonrpc === '2.0' &&
    typeof record.method === 'string' &&
    (record.id === undefined ||
      typeof record.id === 'string' ||
      (typeof record.id === 'number' && Number.isSafeInteger(record.id))) &&
    (record.params === undefined ||
      (record.params !== null &&
        typeof record.params === 'object' &&
        !Array.isArray(record.params)))
  );
}

type Frame =
  | { readonly kind: 'message'; readonly raw: string }
  | { readonly kind: 'oversized' | 'invalid-utf8' };

/** Frame bytes before decoding so a split UTF-8 code point is never replaced. */
async function* readFrames(stream: NodeJS.ReadableStream): AsyncIterable<Frame> {
  const buffer = Buffer.allocUnsafe(MAX_MCP_MESSAGE_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0;
  let discarding = false;
  const finish = (): Frame => {
    if (discarding) return { kind: 'oversized' };
    try {
      return { kind: 'message', raw: decoder.decode(buffer.subarray(0, length)) };
    } catch {
      return { kind: 'invalid-utf8' };
    }
  };
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline === -1 ? bytes.length : newline;
      const segmentLength = end - offset;
      if (!discarding) {
        if (length + segmentLength > MAX_MCP_MESSAGE_BYTES) {
          discarding = true;
          length = 0;
        } else {
          bytes.copy(buffer, length, offset, end);
          length += segmentLength;
        }
      }
      if (newline === -1) break;
      yield finish();
      length = 0;
      discarding = false;
      offset = end + 1;
    }
  }
  // Retain compatibility with a complete final JSON message at clean EOF.
  if (length > 0 || discarding) yield finish();
}
