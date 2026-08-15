import type { McpReadOnlyViewDependencies } from '@agentterm/application';

import { buildReadOnlyHandlers } from './handlers/read-only';
import { McpServer } from './server';
import { runMcpStdioServer } from './stdio-loop';

export { buildReadOnlyHandlers } from './handlers/read-only';
export { McpServer } from './server';
export { runMcpStdioServer } from './stdio-loop';
export {
  MCP_JSON_RPC_ERRORS,
  MCP_TOOL_DEFINITIONS,
  type McpJsonRpcError,
  type McpJsonRpcId,
  type McpJsonRpcRequest,
  type McpJsonRpcResponse,
  type McpJsonRpcResponseError,
  type McpJsonRpcResponseSuccess,
  type McpToolDefinition,
} from './protocol';

export interface McpServerBootstrap {
  readonly authToken: string | undefined;
  readonly dependencies: McpReadOnlyViewDependencies;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

export async function bootstrapMcpServer(options: McpServerBootstrap): Promise<McpServer> {
  const handlers = buildReadOnlyHandlers(options.dependencies);
  const server = new McpServer({
    authToken: options.authToken,
    handlers,
  });
  await runMcpStdioServer({
    authToken: options.authToken,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.output === undefined ? {} : { output: options.output }),
    server,
  });
  return server;
}