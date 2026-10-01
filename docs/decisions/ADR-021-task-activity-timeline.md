# ADR-021: Read-only Task activity timeline

Status: Accepted

## Context

The Task inspector exposes recent sessions, artifacts, quality-gate runs, reviews, and PR state in separate sections. The full saved history is difficult to follow across retries and phase changes. AgentTerm already owns those records; a second activity table would duplicate evidence and create reconciliation problems.

## Decision

- Application loads one Task's existing session, artifact, quality-gate, review, phase-transition, and PR records and projects metadata-only timeline entries. No timeline records are written.
- The read path checks the Task exists and rejects cross-Task history before projecting entries. It returns deterministic newest-first entries; the renderer loads them only when the selected Task's timeline is opened, progressively reveals them, and filters by type.
- Session attempts and terminal events are separate from Task phase transitions. A repeated persisted provider-session identity may be shown as a continued provider conversation, but the UI does not infer that every later attempt was a retry or resume.
- PR rows are mutable latest snapshots, not an event log. The UI labels them as snapshots and uses the last successful local sync time when available.
- Artifact content, quality-gate output, review notes, provider-session IDs, commands, and worktree paths do not enter the timeline projection. Existing evidence sections remain the detail surfaces.

## Consequences

The initial projection used existing repository ports and needed no migration. Older entries remain visible in the timeline even when existing inspector detail sections show only their latest bounded records. An exact retry/resume action label requires durable attempt-origin metadata in a separate future change.

## Pagination follow-up

The desktop now reads 20 metadata-only events per request through a SQLite-backed Application port, ordered by `(occurredAt DESC, id DESC)` with a Task-scoped keyset cursor. Filters run before paging, so an empty first page means no matching history rather than no match among the first 20 events. The renderer shows the loaded count, supports retrying a failed older page, and discards responses after Task/filter/overview changes. This adds no table, migration, or activity write. The original full-history projection remains available to non-desktop callers but is no longer on the desktop timeline read path.

Keyset paging prevents duplicate immutable events when new history arrives. Quality-gate, review, and PR entries are mutable snapshots, however; if one changes timestamp between page requests, a refresh is needed for an exact current view. Pagination does not create a database snapshot across user clicks.
