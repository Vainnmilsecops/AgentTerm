# ADR-001 — Monorepo Structure

- Status: Accepted
- Date: 2026-08-10

## Decision

Use a pnpm workspace with application surfaces under `apps/` and reusable architecture modules under `packages/`. Keep the workspace orchestration native to pnpm; do not add Turbo or Nx yet.

The dependency direction is `Presentation -> Application -> Domain`. Infrastructure implements outer-system adapters and may depend inward on Application, Domain, and Shared. Domain has no framework or platform dependencies.

## Rationale

Pnpm provides one lockfile, workspace linking, topological script execution, and explicit package manifests without introducing another orchestration layer. Separate apps let the Electron desktop shell and Next.js marketing site evolve independently. Separate packages make module interfaces and dependency direction visible.

## Consequences

- Cross-package dependencies use `workspace:*` and are checked by a lightweight Vitest architecture test.
- Shared remains empty until a genuine primitive has multiple consumers.
- Build caching and task graph tooling are deferred until repository scale demonstrates a need.
