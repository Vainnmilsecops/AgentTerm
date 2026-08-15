export type McpJsonRpcId = number | string;

export interface McpJsonRpcRequest {
  readonly id: McpJsonRpcId;
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface McpJsonRpcResponseSuccess {
  readonly id: McpJsonRpcId;
  readonly jsonrpc: '2.0';
  readonly result: unknown;
}

export interface McpJsonRpcResponseError {
  readonly error: McpJsonRpcError;
  readonly id: McpJsonRpcId;
  readonly jsonrpc: '2.0';
}

export type McpJsonRpcResponse =
  | McpJsonRpcResponseSuccess
  | McpJsonRpcResponseError;

export interface McpJsonRpcError {
  readonly code: number;
  readonly data?: unknown;
  readonly message: string;
}

export const MCP_JSON_RPC_ERRORS = Object.freeze({
  AUTHENTICATION_REQUIRED: -32001,
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
  PARSE_ERROR: -32700,
});

export interface McpToolDefinition {
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly name: string;
}

export const MCP_TOOL_DEFINITIONS: readonly McpToolDefinition[] = Object.freeze([
  {
    description: 'List the locally discovered Projects visible to the MCP client.',
    inputSchema: Object.freeze({
      additionalProperties: false,
      properties: Object.freeze({
        limit: Object.freeze({ maximum: 200, minimum: 1, type: 'number' }),
      }),
      type: 'object',
    }),
    name: 'list-projects',
  },
  {
    description: 'List Tasks known to AgentTerm, optionally scoped by Project.',
    inputSchema: Object.freeze({
      additionalProperties: false,
      properties: Object.freeze({
        limit: Object.freeze({ maximum: 800, minimum: 1, type: 'number' }),
        projectId: Object.freeze({ type: 'string' }),
      }),
      type: 'object',
    }),
    name: 'list-tasks',
  },
  {
    description: 'Read a single Task with its latest review and recent Agent Sessions.',
    inputSchema: Object.freeze({
      additionalProperties: false,
      properties: Object.freeze({
        taskId: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['taskId']),
      type: 'object',
    }),
    name: 'get-task',
  },
  {
    description: 'Read the bounded output buffer for a single Agent Session pane.',
    inputSchema: Object.freeze({
      additionalProperties: false,
      properties: Object.freeze({
        maximumLines: Object.freeze({ maximum: 800, minimum: 1, type: 'number' }),
        sessionId: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['sessionId']),
      type: 'object',
    }),
    name: 'read-pane-content',
  },
]);