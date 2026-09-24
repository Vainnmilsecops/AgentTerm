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

The projection uses existing repository ports and needs no migration. It loads full metadata history only for the selected Task, so very large Task histories may eventually need paged repository reads. Older entries remain visible in the timeline even when existing inspector detail sections show only their latest bounded records. An exact retry/resume action label requires durable attempt-origin metadata in a separate future change.
