# ADR-022: Read-only MCP protocol interoperability

Status: Accepted

## Context

The ADR-009 read-only MCP server exposes four Application views, but its direct
JSON-RPC methods do not implement the MCP lifecycle or tool discovery/calling
contract. The old stdio decoder also buffers a complete line a second time, so a
client waiting for a response before its next request can stall. Chunk-local
UTF-8 decoding can corrupt Vietnamese characters and emoji.

## Decision

- One server instance owns one connection. Implement `initialize`,
  `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. Tool access
  through standard methods requires initialization. Echo a supported protocol
  version; otherwise offer `2025-11-25`. Also support `2025-06-18`, `2025-03-26`,
  and `2024-11-05` for this bounded read-only surface.
- Discovery advertises only registered handlers, with read-only annotations.
  Tool results use MCP text content containing the existing JSON views. Preserve
  authenticated direct-method calls for existing integrations; they do not
  require the new handshake.
- Authorization remains an explicit, nonempty host-provided local grant on every
  request. The grant is not a JSON-RPC argument, client capability, or network
  authentication mechanism. Notifications neither receive responses nor execute
  tools; unauthorized notifications cannot advance the connection lifecycle.
- Frame newline-delimited bytes before strict UTF-8 decoding. Bound each input
  message to 1 MiB, discard an oversized frame until its next boundary, and then
  resume reading. Preserve a complete final JSON message at clean EOF for legacy
  callers. Await each output write before reading the next request.
- Validate tool arguments against the published limits. Protocol errors and tool
  errors are distinct; unexpected backend errors and raw client data never enter
  transport error messages or logs.
- Keep this policy in `@agentterm/mcp-server`. Application read views and Domain
  transitions are unchanged. No SDK dependency, database migration, write tool,
  HTTP listener, or provider-specific branch is introduced.

## Consequences

The package can now serve a standard initialize/discover/call exchange over
stdio. Regression tests exercise the lifecycle, authorization, schema bounds,
Unicode, framing, output failures, and a built host over real Node process pipes.
The real-pipe client is a JSON-RPC test client, not an MCP SDK/client certification.

A dedicated user-facing stdio launch/registration command is still deferred; the
desktop's existing composition is not a standalone CLI host. That host must define
an explicit local authorization and data/process ownership contract before adding
write tools such as create/move/send. Request cancellation and network transports
remain outside this slice.

## References

- [agtx MCP server](https://github.com/fynnfluegge/agtx#mcp-server)
- [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
