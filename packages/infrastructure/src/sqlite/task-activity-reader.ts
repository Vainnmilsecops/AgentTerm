import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type {
  TaskActivityItem,
  TaskActivityPageInput,
  TaskActivityReader,
  TaskActivityTimeline,
} from '@agentterm/application';

import { SqlitePersistenceError } from './errors';

const pageSize = 20;
const filters = new Set([
  'ALL',
  'SESSION',
  'ARTIFACT',
  'QUALITY_GATE',
  'REVIEW',
  'PHASE',
  'PULL_REQUEST',
]);

/** Metadata-only keyset read. SQLite pages before anything crosses into JS/IPC. */
export class SqliteTaskActivityReader implements TaskActivityReader {
  private readonly readPage: StatementSync;

  public constructor(database: DatabaseSync) {
    this.readPage = database.prepare(`
      WITH args AS (
        SELECT ? AS task_id, ? AS filter, ? AS cursor_time, ? AS cursor_id
      ), activity AS (
        SELECT 'SESSION' AS category,
          CASE e.kind
            WHEN 'START_REQUESTED' THEN 'SESSION_STARTED'
            WHEN 'STOP_REQUESTED' THEN 'SESSION_STOP_REQUESTED'
            WHEN 'PROCESS_EXITED' THEN 'SESSION_EXITED'
            ELSE 'SESSION_FAILED'
          END AS kind,
          'session:' || s.id || ':' || e.sequence AS id,
          e.occurred_at AS occurred_at,
          json_object(
            'agentId', s.agent_id, 'attempt', s.ordinal,
            'continuedFromSessionId', CASE WHEN s.provider_session_id IS NULL THEN NULL ELSE (
              SELECT previous.id FROM agent_sessions AS previous
              WHERE previous.task_id = s.task_id
                AND previous.agent_id = s.agent_id
                AND previous.provider_session_id = s.provider_session_id
                AND previous.ordinal < s.ordinal
              ORDER BY previous.ordinal DESC LIMIT 1
            ) END,
            'sessionId', s.id
          ) AS data
        FROM agent_session_events e JOIN agent_sessions s ON s.id = e.session_id
        WHERE s.task_id = (SELECT task_id FROM args)
          AND (e.kind IN ('START_REQUESTED', 'STOP_REQUESTED', 'PROCESS_EXITED')
            OR (e.kind = 'RUNTIME_FAILED' AND e.fatal = 1))
        UNION ALL
        SELECT 'ARTIFACT', 'ARTIFACT', 'artifact:' || id, created_at,
          json_object('artifactId', id, 'artifactKind', kind, 'phase', phase, 'sessionId', session_id)
        FROM execution_artifacts WHERE task_id = (SELECT task_id FROM args)
        UNION ALL
        SELECT 'QUALITY_GATE', 'QUALITY_GATE', 'quality-gate:' || id,
          COALESCE(finished_at, started_at),
          json_object('finishedAt', finished_at, 'gateKind', gate_kind, 'runId', id,
            'startedAt', started_at, 'status', status)
        FROM quality_gate_runs WHERE task_id = (SELECT task_id FROM args)
        UNION ALL
        SELECT 'REVIEW', 'REVIEW_REQUESTED', 'review:' || id || ':requested', requested_at,
          json_object('reviewId', id, 'status', 'PENDING')
        FROM task_reviews WHERE task_id = (SELECT task_id FROM args)
        UNION ALL
        SELECT 'REVIEW', 'REVIEW_DECIDED', 'review:' || id || ':decided', decided_at,
          json_object('reviewId', id, 'status', status)
        FROM task_reviews WHERE task_id = (SELECT task_id FROM args) AND decided_at IS NOT NULL
        UNION ALL
        SELECT 'PHASE', 'PHASE_TRANSITION', 'phase:' || id, created_at,
          json_object('fromPhase', from_phase, 'toPhase', to_phase, 'transitionId', id,
            'trigger', trigger_kind)
        FROM task_transition_audit WHERE task_id = (SELECT task_id FROM args)
        UNION ALL
        SELECT 'PULL_REQUEST', 'PULL_REQUEST_SNAPSHOT',
          'pull-request:' || repository_owner || '/' || repository_name || '#' || pull_request_number,
          COALESCE(last_synced_at, created_at),
          json_object('checks', check_state, 'draft', draft, 'number', pull_request_number,
            'observedAt', COALESCE(last_synced_at, created_at), 'reviewState', review_state,
            'status', status, 'url', url)
        FROM task_pull_requests WHERE task_id = (SELECT task_id FROM args)
      )
      SELECT id, kind, occurred_at, data FROM activity, args
      WHERE (args.filter = 'ALL' OR category = args.filter)
        AND (args.cursor_time IS NULL OR occurred_at < args.cursor_time
          OR (occurred_at = args.cursor_time AND id < args.cursor_id))
      ORDER BY occurred_at DESC, id DESC LIMIT ${pageSize + 1}
    `);
  }

  public async listPage(input: TaskActivityPageInput): Promise<TaskActivityTimeline> {
    if (
      typeof input.taskId !== 'string' ||
      input.taskId.trim() === '' ||
      !filters.has(input.filter)
    ) {
      throw new TypeError('Invalid Task activity request.');
    }
    if (
      input.cursor !== undefined &&
      (!Number.isSafeInteger(input.cursor.occurredAt) ||
        input.cursor.occurredAt < 0 ||
        typeof input.cursor.id !== 'string' ||
        input.cursor.id.length === 0 ||
        input.cursor.id.length > 1024)
    ) {
      throw new TypeError('Invalid Task activity cursor.');
    }
    const rows = this.readPage.all(
      input.taskId,
      input.filter,
      input.cursor?.occurredAt ?? null,
      input.cursor?.id ?? null,
    );
    const items = Object.freeze(rows.slice(0, pageSize).map(mapActivityRow));
    const last = items.at(-1);
    return Object.freeze({
      taskId: input.taskId,
      items,
      nextCursor:
        rows.length > pageSize && last !== undefined
          ? Object.freeze({ occurredAt: last.occurredAt, id: last.id })
          : undefined,
    });
  }
}

function mapActivityRow(row: Record<string, unknown>): TaskActivityItem {
  try {
    const kind = text(row.kind);
    const id = text(row.id);
    const occurredAt = integer(row.occurred_at);
    const data = JSON.parse(text(row.data)) as Record<string, unknown>;
    const base = { id, kind, occurredAt };
    switch (kind) {
      case 'SESSION_STARTED':
      case 'SESSION_STOP_REQUESTED':
      case 'SESSION_EXITED':
      case 'SESSION_FAILED':
        return Object.freeze({
          ...base,
          kind,
          agentId: text(data.agentId),
          attempt: integer(data.attempt),
          continuedFromSessionId: nullableText(data.continuedFromSessionId),
          sessionId: text(data.sessionId),
        });
      case 'ARTIFACT':
        return Object.freeze({
          ...base,
          kind,
          artifactId: text(data.artifactId),
          artifactKind: text(data.artifactKind) as Extract<
            TaskActivityItem,
            { kind: 'ARTIFACT' }
          >['artifactKind'],
          phase: text(data.phase) as Extract<TaskActivityItem, { kind: 'ARTIFACT' }>['phase'],
          sessionId: nullableText(data.sessionId),
        });
      case 'QUALITY_GATE':
        return Object.freeze({
          ...base,
          kind,
          finishedAt: nullableInteger(data.finishedAt),
          gateKind: text(data.gateKind) as Extract<
            TaskActivityItem,
            { kind: 'QUALITY_GATE' }
          >['gateKind'],
          runId: text(data.runId),
          startedAt: integer(data.startedAt),
          status: text(data.status) as Extract<
            TaskActivityItem,
            { kind: 'QUALITY_GATE' }
          >['status'],
        });
      case 'REVIEW_REQUESTED':
      case 'REVIEW_DECIDED':
        return Object.freeze({
          ...base,
          kind,
          reviewId: text(data.reviewId),
          status: text(data.status) as Extract<
            TaskActivityItem,
            { kind: 'REVIEW_DECIDED' }
          >['status'],
        });
      case 'PHASE_TRANSITION':
        return Object.freeze({
          ...base,
          kind,
          fromPhase: text(data.fromPhase) as Extract<
            TaskActivityItem,
            { kind: 'PHASE_TRANSITION' }
          >['fromPhase'],
          toPhase: text(data.toPhase) as Extract<
            TaskActivityItem,
            { kind: 'PHASE_TRANSITION' }
          >['toPhase'],
          transitionId: text(data.transitionId),
          trigger: text(data.trigger) as Extract<
            TaskActivityItem,
            { kind: 'PHASE_TRANSITION' }
          >['trigger'],
        });
      case 'PULL_REQUEST_SNAPSHOT':
        return Object.freeze({
          ...base,
          kind,
          checks: text(data.checks) as Extract<
            TaskActivityItem,
            { kind: 'PULL_REQUEST_SNAPSHOT' }
          >['checks'],
          draft: integer(data.draft) === 1,
          number: integer(data.number),
          observedAt: integer(data.observedAt),
          reviewState: text(data.reviewState) as Extract<
            TaskActivityItem,
            { kind: 'PULL_REQUEST_SNAPSHOT' }
          >['reviewState'],
          status: text(data.status) as Extract<
            TaskActivityItem,
            { kind: 'PULL_REQUEST_SNAPSHOT' }
          >['status'],
          url: text(data.url),
        });
      default:
        throw new TypeError('Unknown Task activity kind.');
    }
  } catch (error) {
    throw new SqlitePersistenceError('Task activity row is invalid.', { cause: error });
  }
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('Invalid text value.');
  return value;
}

function nullableText(value: unknown): string | undefined {
  return value === null ? undefined : text(value);
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError('Invalid integer value.');
  return value;
}

function nullableInteger(value: unknown): number | undefined {
  return value === null ? undefined : integer(value);
}
