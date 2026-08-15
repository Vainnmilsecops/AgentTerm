# ADR-007 — Trusted Quality Gate Configuration Consumer

- Status: Accepted
- Date: 2026-08-15

## Decision

Introduce one narrow renderer-driven workflow that consumes a trusted Quality Gate
configuration JSON file. The renderer triggers a native file picker through the
Electron main process, the main process returns a single safe path to the renderer, and
the renderer invokes the existing `importQualityGateConfig` Application use case through
a new dedicated IPC channel. The reverse direction (`Export to file…`) reuses the
existing `saveQualityGateConfig` IPC channel after the main process picks the destination.
No new trust boundary is introduced: the trust-root validator already lives in
`QualityGateConfigurator`, and the renderer remains incapable of reading or writing
arbitrary filesystem paths.

## Alternatives Considered

- A renderer-owned file input that types or pastes a path directly would leak the native
  filesystem to the renderer, bypass the trusted-root validator, and break the existing
  IPC contract; rejected.
- Auto-importing a configuration file from a fixed location on startup would couple
  Application composition to operator-managed disk state and remove the explicit user
  action that the Quality Gate IPC currently requires; rejected.
- A separate trusted-process binary for configuration import would duplicate the
  Application composition that already owns `QualityGateConfigurator` and add an
  out-of-band signing/transport story; rejected.

## Security and Runtime Tradeoffs

- The renderer still owns no native filesystem, Git, database, process, PTY, or
  environment capability. The only new IPC channels are `selectQualityGateConfigPath`
  (returns `{ path: string | undefined; result: 'SELECTED' | 'CANCELLED' }`) and
  `importQualityGateConfig` (returns the existing `ImportQualityGateConfigResult`),
  both validated in main and bound to the current top-level window.
- `QualityGateConfigurator` is the sole IPC load/save caller. It always invokes
  `selectQualityGateConfigPath` before any path reaches `importQualityGateConfig` or
  `saveQualityGateConfig`; an empty result is treated as a user cancellation, not an
  error, and the renderer never holds a path it did not ask for.
- Trust-root checks remain in `QualityGateConfigurator`. A configuration file outside the
  configured trust root is rejected at the validator, surfaced through the existing
  `QualityGateConfiguratorFailure` union, and never reaches the catalog.
- Palette commands `gate:config:import` and `gate:config:export` share the existing
  Quality Gate visibility rules: they appear only when the selected Task can run gates
  and the workspace is idle. A Task that cannot run gates cannot import or export a
  configuration either.
- The trust-root hint that names `AT_DESKTOP_GATE_CONFIG_ROOT` is rendered as static
  text; no environment value is ever read in the renderer, and the existing
  main-process launch path is the only place that resolves it.

## Consequences

- `QualityGateConfigurator` is now the renderer-side entry point for trusted
  configuration import/export; `QualityGateConfiguration` stays a smaller
  register/unregister surface that does not own file selection.
- The production composition still ships with an empty gate catalog until an operator
  seeds the first trusted configuration file; nothing in this slice auto-loads a file on
  startup.
- Two new Application ports are exposed: `QualityGateConfigurator.load/save` (already
  existed) are now actually consumed end to end, and a new `QualityGateConfigurator.load`
  caller (`importQualityGateConfig`) decomposes the result into per-gate
  `registerQualityGate` calls so that catalog rejections are surfaced explicitly.
- Future additions must not introduce renderer-typed paths or new filesystem channels.
  If a richer authoring flow is needed, it must go through the same picker-driven
  Application port.