import {
  MCP_JSON_RPC_ERRORS,
  MCP_TOOL_DEFINITIONS,
  type McpJsonRpcError,
  type McpJsonRpcRequest,
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

export class McpServer {
  private readonly authToken: string | undefined;
  private readonly handlers: Readonly<Record<string, McpToolHandler>>;
  private readonly log: (message: string) => void;

  public constructor(options: McpServerOptions) {
    this.authToken = options.authToken;
    this.handlers = options.handlers;
    this.log = options.log ?? (() => undefined);
  }

  public listTools(): readonly McpToolDefinition[] {
    return MCP_TOOL_DEFINITIONS;
  }

  public async dispatch(
    request: McpJsonRpcRequest,
    authentication: { readonly token: string | undefined },
  ): Promise<McpDispatchResult> {
    const handler = this.handlers[request.method];
    if (handler === undefined) {
      this.log(`mcp-server: method not found ${request.method}`);
      return {
        response: {
          error: {
            code: MCP_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
            message: `Method ${request.method} is not exposed by the AgentTerm MCP server.`,
          },
          id: request.id,
          jsonrpc: '2.0',
        },
      };
    }
    if (!this.isAuthorized(authentication)) {
      return {
        response: {
          error: authFailure(),
          id: request.id,
          jsonrpc: '2.0',
        },
      };
    }
    try {
      const params = request.params ?? {};
      const result = await handler.invoke(params);
      return {
        response: {
          id: request.id,
          jsonrpc: '2.0',
          result,
        },
      };
    } catch (error) {
      return {
        response: {
          error: {
            code: MCP_JSON_RPC_ERRORS.INVALID_PARAMS,
            data: error instanceof Error ? error.message : String(error),
            message: 'MCP tool invocation failed.',
          },
          id: request.id,
          jsonrpc: '2.0',
        },
      };
    }
  }

  private isAuthorized(authentication: {
    readonly token: string | undefined;
  }): boolean {
    if (this.authToken === undefined) {
      return false;
    }
    return (
      typeof authentication.token === 'string' &&
      constantTimeEquals(authentication.token, this.authToken)
    );
  }
}

function authFailure(): McpJsonRpcError {
  return {
    code: MCP_JSON_RPC_ERRORS.AUTHENTICATION_REQUIRED,
    message: 'A valid MCP token is required.',
  };
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}