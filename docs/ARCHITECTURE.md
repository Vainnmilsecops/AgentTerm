# AgentTerm Architecture

AgentTerm uses a TypeScript monorepo with two application surfaces and inward-pointing package dependencies.

```text
apps/
├── desktop/          Electron main process and React presentation
└── website/          Next.js landing and documentation site

packages/
├── domain/           Business rules with no framework/platform dependencies
├── application/      Use cases, ports, and orchestration; depends on domain
├── infrastructure/   External-system adapters; depends inward
├── shared/           Proven cross-cutting primitives only
└── config/           Shared tooling/config support when justified
```

## Dependency Direction

```text
Desktop Presentation ──> Application ──> Domain
                              ^
                              │ implements owned ports
Infrastructure ───────────────┘

Website Presentation (independent until it needs an application use case)
```

Infrastructure may depend on Application, Domain, and Shared. Domain must not import React, Electron, Next.js, Node process/filesystem APIs, Git, PTY, SQLite, or agent-provider code. Presentation invokes Application behavior instead of calling Infrastructure directly.

Package manifests encode the current allowed graph, and `tests/architecture/workspace-boundaries.test.ts` rejects undeclared AgentTerm dependency directions. This is intentionally lighter than adopting a monorepo or dependency-analysis framework.

## Current Scope

This foundation contains runnable desktop/website shells, a pure Domain model for Project and the primary Task lifecycle, and Application use cases backed by repository ports. Session/runtime lifecycles, infrastructure adapters, terminal rendering, persistence, logging pipelines, installers, and product UI are not implemented yet.
