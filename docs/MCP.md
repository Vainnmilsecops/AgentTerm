# Read-only MCP package

`@agentterm/mcp-server` exposes the existing Application read views through MCP
stdio. This is a library/host contract, not a shipped `agentterm mcp-serve` command
or a ready-to-paste external client configuration.

## Host ownership and authorization

The host calls `bootstrapMcpServer({ authToken, dependencies, input, output })`
with explicitly authorized read dependencies and a nonempty local grant. The
bootstrap promise runs until input ends or a stream fails. Omitting streams uses
`process.stdin` and `process.stdout`; stdout must contain only JSON-RPC messages.
Do not reuse the same server instance across independent connections.

The existing desktop composition obtains its grant from Settings. A future
standalone host must establish its own explicit authorization and ownership
contract. A token placed in a request or `clientInfo` does not authorize anything;
no network listener or credential exchange exists here. Do not log the grant,
client payloads, or returned pane content.

## Client exchange

Send one UTF-8 JSON object per line. Initialize and wait for its response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-11-25",
    "capabilities": {},
    "clientInfo": { "name": "example-client", "version": "1" }
  }
}
```

The response advertises `tools: { listChanged: false }`, server name `agentterm`,
and a negotiated version. A client requesting an unsupported version must accept
the offered version or disconnect. Supported versions are listed in ADR-022.

Then notify readiness (no response), discover tools, and call one:

```json
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get-task","arguments":{"taskId":"existing-task-id"}}}
```

Tool names are hyphenated, not the underscored names of the original agtx tools:

- `list-projects`: optional integer `limit` from 1 to 200.
- `list-tasks`: optional `projectId` and integer `limit` from 1 to 800.
- `get-task`: required `taskId`.
- `read-pane-content`: required `sessionId`; optional integer `maximumLines`
  from 1 to 800. This reads the existing bounded live snapshot, not output replay.

Identifiers must be nonblank strings of at most 256 characters. Extra tool
arguments are rejected. `tools/list` has no pagination cursor. `ping` returns an
empty result; notifications never invoke a tool.

Successful tool results contain `content: [{ type: "text", text: "<JSON view>" }]`
and `isError: false`. Handler/argument failures return `isError: true` with a
sanitized text explanation. Invalid envelopes, unsupported methods, unauthorized
requests, and malformed `tools/call` parameters produce JSON-RPC errors instead.
Authenticated legacy direct calls such as `method: "get-task"` remain available
without initialization and return the original JSON result shape.

## Transport bounds and verification

Each input line is limited to 1 MiB, counted in bytes. Oversized or invalid UTF-8
messages receive a sanitized error; the next complete frame can still be read.
CRLF and split UTF-8 code points are supported. A complete final JSON message at
clean EOF is also accepted for legacy callers. Output writes are serialized and
awaited; output failure rejects the host loop rather than silently losing replies.

Build the package before running its tests, including the built-host real-pipe test:

```powershell
pnpm --filter @agentterm/mcp-server build
pnpm exec vitest run packages/mcp-server/src --maxWorkers=2
```

There are no MCP write tools or standalone registration command yet. See
[ADR-022](decisions/ADR-022-mcp-protocol-interoperability.md) for the scope and the
next host/authorization prerequisite.
