export type McpJsonRpcId = number | string;

export interface McpJsonRpcNotification {
  readonly id?: never;
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export type McpJsonRpcMessage = McpJsonRpcRequest | McpJsonRpcNotification;

export const MCP_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

/** Only fixed, transport-owned validation messages may cross the protocol boundary. */
export class McpInvalidParamsError extends Error {
  public constructor(message = 'Invalid MCP tool parameters.') {
    super(message);
    this.name = 'McpInvalidParamsError';
  }
}

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
  readonly id: McpJsonRpcId | null;
  readonly jsonrpc: '2.0';
}

export type McpJsonRpcResponse = McpJsonRpcResponseSuccess | McpJsonRpcResponseError;

export interface McpJsonRpcError {
  readonly code: number;
  readonly data?: unknown;
  readonly message: string;
}

export const MCP_JSON_RPC_ERRORS = Object.freeze({
  AUTHENTICATION_REQUIRED: -32001,
  INVALID_PARAMS: -32602,
  INVALID_REQUEST: -32600,
  INTERNAL_ERROR: -32603,
  METHOD_NOT_FOUND: -32601,
  NOT_INITIALIZED: -32002,
  PARSE_ERROR: -32700,
});

export interface McpToolDefinition {
  readonly annotations?: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: boolean;
  };
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
        limit: Object.freeze({ maximum: 200, minimum: 1, type: 'integer' }),
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
        limit: Object.freeze({ maximum: 800, minimum: 1, type: 'integer' }),
        projectId: Object.freeze({ type: 'string', minLength: 1, maxLength: 256 }),
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
        taskId: Object.freeze({ type: 'string', minLength: 1, maxLength: 256 }),
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
        maximumLines: Object.freeze({ maximum: 800, minimum: 1, type: 'integer' }),
        sessionId: Object.freeze({ type: 'string', minLength: 1, maxLength: 256 }),
      }),
      required: Object.freeze(['sessionId']),
      type: 'object',
    }),
    name: 'read-pane-content',
  },
]);
