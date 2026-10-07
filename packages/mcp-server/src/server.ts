import {
  MCP_JSON_RPC_ERRORS,
  MCP_PROTOCOL_VERSIONS,
  McpInvalidParamsError,
  type McpJsonRpcId,
  type McpJsonRpcMessage,
  type McpJsonRpcResponse,
  type McpToolDefinition,
} from './protocol';

export interface McpToolHandler {
  readonly definition: McpToolDefinition;
  invoke(params: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface McpServerOptions {
  readonly authToken: string | undefined;
  readonly handlers: Readonly<Record<string, McpToolHandler>>;
  readonly log?: (message: string) => void;
}

export interface McpDispatchResult {
  readonly response: McpJsonRpcResponse | undefined;
}

/** One instance owns one stdio connection and its protocol lifecycle. */
export class McpServer {
  private readonly authToken: string | undefined;
  private readonly handlers: ReadonlyMap<string, McpToolHandler>;
  private readonly log: (message: string) => void;
  private state: 'NEW' | 'INITIALIZING' | 'READY' = 'NEW';

  public constructor(options: McpServerOptions) {
    this.authToken = options.authToken;
    this.handlers = new Map(Object.entries(options.handlers));
    this.log = options.log ?? (() => undefined);
  }

  public listTools(): readonly McpToolDefinition[] {
    return [...this.handlers.values()].map((handler) => handler.definition);
  }

  public async dispatch(
    request: McpJsonRpcMessage,
    authentication: { readonly token: string | undefined },
  ): Promise<McpDispatchResult> {
    if (!this.isAuthorized(authentication)) {
      return request.id === undefined
        ? { response: undefined }
        : failure(
            request.id,
            MCP_JSON_RPC_ERRORS.AUTHENTICATION_REQUIRED,
            'A valid MCP token is required.',
          );
    }

    // Notifications never receive responses and can never invoke a tool.
    if (request.id === undefined) {
      if (request.method === 'notifications/initialized' && this.state === 'INITIALIZING') {
        this.state = 'READY';
      }
      return { response: undefined };
    }
    const id = request.id;
    const params = request.params ?? {};
    if (!isRecord(params))
      return failure(id, MCP_JSON_RPC_ERRORS.INVALID_PARAMS, 'Parameters must be an object.');
    if (request.method === 'ping') return success(id, {});
    if (request.method === 'initialize') {
      if (this.state !== 'NEW')
        return failure(
          id,
          MCP_JSON_RPC_ERRORS.INVALID_REQUEST,
          'This connection is already initialized.',
        );
      if (
        typeof params.protocolVersion !== 'string' ||
        params.protocolVersion.length === 0 ||
        !isRecord(params.capabilities) ||
        !isRecord(params.clientInfo) ||
        typeof params.clientInfo.name !== 'string' ||
        params.clientInfo.name.trim().length === 0 ||
        typeof params.clientInfo.version !== 'string' ||
        params.clientInfo.version.trim().length === 0
      ) {
        return failure(
          id,
          MCP_JSON_RPC_ERRORS.INVALID_PARAMS,
          'Initialization requires protocolVersion, capabilities and clientInfo.',
        );
      }
      this.state = 'INITIALIZING';
      return success(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(params.protocolVersion)
          ? params.protocolVersion
          : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agentterm', version: '0.0.0' },
      });
    }
    if (request.method === 'tools/list' || request.method === 'tools/call') {
      if (this.state !== 'READY')
        return failure(
          id,
          MCP_JSON_RPC_ERRORS.NOT_INITIALIZED,
          'Initialize the MCP connection before using tools.',
        );
      if (request.method === 'tools/list') {
        if (params.cursor !== undefined)
          return failure(
            id,
            MCP_JSON_RPC_ERRORS.INVALID_PARAMS,
            'This tool list has no pagination cursor.',
          );
        return success(id, { tools: this.listTools() });
      }
      if (typeof params.name !== 'string' || !this.handlers.has(params.name)) {
        return failure(id, MCP_JSON_RPC_ERRORS.INVALID_PARAMS, 'Unknown MCP tool.');
      }
      if (params.arguments !== undefined && !isRecord(params.arguments)) {
        return failure(id, MCP_JSON_RPC_ERRORS.INVALID_PARAMS, 'Tool arguments must be an object.');
      }
      const handler = this.handlers.get(params.name);
      if (handler === undefined)
        return failure(id, MCP_JSON_RPC_ERRORS.INVALID_PARAMS, 'Unknown MCP tool.');
      try {
        const result = await handler.invoke(params.arguments ?? {});
        return success(id, {
          content: [{ type: 'text', text: JSON.stringify(result ?? null) }],
          isError: false,
        });
      } catch (error) {
        this.log('mcp-server: tool invocation failed');
        return success(id, {
          content: [
            {
              type: 'text',
              text:
                error instanceof McpInvalidParamsError
                  ? error.message
                  : 'Unable to read AgentTerm data. Retry or check the desktop application.',
            },
          ],
          isError: true,
        });
      }
    }

    // Keep existing direct-method callers working; only registered tools are callable.
    const handler = this.handlers.get(request.method);
    if (handler === undefined) {
      this.log('mcp-server: method not found');
      return failure(
        id,
        MCP_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        'Method is not exposed by the AgentTerm MCP server.',
      );
    }
    try {
      return success(id, await handler.invoke(params));
    } catch (error) {
      this.log('mcp-server: tool invocation failed');
      return failure(
        id,
        error instanceof McpInvalidParamsError
          ? MCP_JSON_RPC_ERRORS.INVALID_PARAMS
          : MCP_JSON_RPC_ERRORS.INTERNAL_ERROR,
        error instanceof McpInvalidParamsError ? error.message : 'MCP tool invocation failed.',
      );
    }
  }

  private isAuthorized(authentication: { readonly token: string | undefined }): boolean {
    return (
      typeof this.authToken === 'string' &&
      this.authToken.length > 0 &&
      typeof authentication.token === 'string' &&
      constantTimeEquals(authentication.token, this.authToken)
    );
  }
}

function success(id: McpJsonRpcId, result: unknown): McpDispatchResult {
  return { response: { id, jsonrpc: '2.0', result } };
}

function failure(id: McpJsonRpcId, code: number, message: string): McpDispatchResult {
  return { response: { error: { code, message }, id, jsonrpc: '2.0' } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1)
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}
