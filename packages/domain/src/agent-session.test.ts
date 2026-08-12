import { describe, expect, it } from 'vitest';

import {
  createAgentSession,
  InvalidAgentSessionStatusTransitionError,
  recordAgentSessionEvent,
  type AgentSession,
  type AgentSessionStatus as AgentSessionStatusValue,
} from './index';

const createdAt = 1_800_000_000_000;
const Status = {
  EXITED: 'EXITED',
  FAILED: 'FAILED',
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  WAITING_INPUT: 'WAITING_INPUT',
  WORKING: 'WORKING',
} as const;

function createStartingSession(): AgentSession {
  return createAgentSession({
    agentId: 'codex',
    createdAt,
    id: 'session-1',
    taskId: 'task-1',
  });
}

function reportStatus(
  session: AgentSession,
  status: 'IDLE' | 'WAITING_INPUT' | 'WORKING',
  occurredAt = createdAt + session.history.length,
): AgentSession {
  return recordAgentSessionEvent(session, {
    kind: 'STATUS_REPORTED',
    occurredAt,
    source: 'APPLICATION',
    status,
  });
}

describe('AgentSession', () => {
  it('creates an immutable STARTING session with the first history event', () => {
    const session = createStartingSession();

    expect(session).toEqual({
      agentId: 'codex',
      createdAt,
      endedAt: undefined,
      history: [
        {
          kind: 'START_REQUESTED',
          occurredAt: createdAt,
          sequence: 1,
          status: Status.STARTING,
        },
      ],
      id: 'session-1',
      status: Status.STARTING,
      taskId: 'task-1',
    });
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.history)).toBe(true);
    expect(Object.isFrozen(session.history[0])).toBe(true);
  });

  it.each([
    ['id', { id: '  ' }],
    ['task id', { taskId: '\t' }],
    ['agent id', { agentId: '' }],
  ])('rejects a blank %s', (_field, override) => {
    expect(() =>
      createAgentSession({
        agentId: 'codex',
        createdAt,
        id: 'session-1',
        taskId: 'task-1',
        ...override,
      }),
    ).toThrow(TypeError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'rejects invalid creation timestamp %s',
    (invalidTimestamp) => {
      expect(() =>
        createAgentSession({
          agentId: 'codex',
          createdAt: invalidTimestamp,
          id: 'session-1',
          taskId: 'task-1',
        }),
      ).toThrow(TypeError);
    },
  );

  it('supports the required active status transitions and appends ordered history', () => {
    const starting = createStartingSession();
    const working = reportStatus(starting, Status.WORKING);
    const idle = reportStatus(working, Status.IDLE);
    const waiting = reportStatus(idle, Status.WAITING_INPUT);
    const resumed = reportStatus(waiting, Status.WORKING);

    expect(resumed.status).toBe(Status.WORKING);
    expect(resumed.history.map(({ sequence, status }) => ({ sequence, status }))).toEqual([
      { sequence: 1, status: 'STARTING' },
      { sequence: 2, status: 'WORKING' },
      { sequence: 3, status: 'IDLE' },
      { sequence: 4, status: 'WAITING_INPUT' },
      { sequence: 5, status: 'WORKING' },
    ]);
    expect(starting.status).toBe(Status.STARTING);
    expect(starting.history).toHaveLength(1);
  });

  it.each([
    [Status.STARTING, Status.IDLE],
    [Status.STARTING, Status.WAITING_INPUT],
    [Status.WORKING, Status.WORKING],
    [Status.IDLE, Status.IDLE],
    [Status.WAITING_INPUT, Status.WAITING_INPUT],
  ] as const)('rejects %s -> %s', (from, to) => {
    let session = createStartingSession();
    if (from === Status.WORKING) {
      session = reportStatus(session, Status.WORKING);
    } else if (from === Status.IDLE) {
      session = reportStatus(reportStatus(session, Status.WORKING), Status.IDLE);
    } else if (from === Status.WAITING_INPUT) {
      session = reportStatus(reportStatus(session, Status.WORKING), Status.WAITING_INPUT);
    }

    expect(() => reportStatus(session, to as 'IDLE' | 'WAITING_INPUT' | 'WORKING')).toThrow(
      new InvalidAgentSessionStatusTransitionError(from, to),
    );
  });

  it.each([Status.STARTING, Status.WORKING, Status.IDLE, Status.WAITING_INPUT] as const)(
    'records process exit from live status %s without implying Task completion',
    (from) => {
      const session = reachStatus(from);
      const exited = recordAgentSessionEvent(session, {
        exitCode: 23,
        kind: 'PROCESS_EXITED',
        occurredAt: createdAt + 10,
        reason: 'PROCESS_EXIT',
        runtimeSequence: 7,
        signal: 15,
      });

      expect(exited.status).toBe(Status.EXITED);
      expect(exited.endedAt).toBe(createdAt + 10);
      expect(exited.history.at(-1)).toEqual({
        exitCode: 23,
        kind: 'PROCESS_EXITED',
        occurredAt: createdAt + 10,
        reason: 'PROCESS_EXIT',
        runtimeSequence: 7,
        sequence: session.history.length + 1,
        signal: 15,
        status: Status.EXITED,
      });
    },
  );

  it.each([Status.STARTING, Status.WORKING, Status.IDLE, Status.WAITING_INPUT] as const)(
    'records fatal failure from live status %s',
    (from) => {
      const session = reachStatus(from);
      const failed = recordAgentSessionEvent(session, {
        code: 'RUNTIME_FAILURE',
        fatal: true,
        kind: 'RUNTIME_FAILED',
        occurredAt: createdAt + 10,
        runtimeSequence: 8,
        stage: 'RUNTIME',
      });

      expect(failed.status).toBe(Status.FAILED);
      expect(failed.endedAt).toBe(createdAt + 10);
    },
  );

  it('keeps a nonfatal runtime operation failure in the active status', () => {
    const working = reportStatus(createStartingSession(), Status.WORKING);
    const result = recordAgentSessionEvent(working, {
      code: 'RUNTIME_FAILURE',
      fatal: false,
      kind: 'RUNTIME_FAILED',
      occurredAt: createdAt + 2,
      runtimeSequence: 4,
      stage: 'TERMINATE',
    });

    expect(result.status).toBe(Status.WORKING);
    expect(result.endedAt).toBeUndefined();
    expect(result.history).toHaveLength(3);
  });

  it('preserves FAILED status while appending later process-exit evidence', () => {
    const failed = recordAgentSessionEvent(createStartingSession(), {
      code: 'RUNTIME_FAILURE',
      fatal: true,
      kind: 'RUNTIME_FAILED',
      occurredAt: createdAt + 1,
      runtimeSequence: 2,
      stage: 'START',
    });
    const exitedEvidence = recordAgentSessionEvent(failed, {
      exitCode: -1,
      kind: 'PROCESS_EXITED',
      occurredAt: createdAt + 2,
      reason: 'PROCESS_EXIT',
      runtimeSequence: 3,
    });

    expect(exitedEvidence.status).toBe(Status.FAILED);
    expect(exitedEvidence.endedAt).toBe(createdAt + 1);
    expect(exitedEvidence.history.at(-1)).toMatchObject({
      kind: 'PROCESS_EXITED',
      status: Status.FAILED,
    });
  });

  it('preserves FAILED status while appending later cleanup-failure evidence', () => {
    const failed = recordAgentSessionEvent(createStartingSession(), {
      code: 'RUNTIME_FAILURE',
      fatal: true,
      kind: 'RUNTIME_FAILED',
      occurredAt: createdAt + 1,
      runtimeSequence: 2,
      stage: 'RUNTIME',
    });
    const cleanupEvidence = recordAgentSessionEvent(failed, {
      code: 'RUNTIME_FAILURE',
      fatal: true,
      kind: 'RUNTIME_FAILED',
      occurredAt: createdAt + 2,
      runtimeSequence: 3,
      stage: 'CLEANUP',
    });

    expect(cleanupEvidence.status).toBe(Status.FAILED);
    expect(cleanupEvidence.endedAt).toBe(createdAt + 1);
    expect(cleanupEvidence.history.at(-1)).toMatchObject({
      kind: 'RUNTIME_FAILED',
      stage: 'CLEANUP',
      status: Status.FAILED,
    });
  });

  it('records one idempotent stop request without declaring exit', () => {
    const working = reportStatus(createStartingSession(), Status.WORKING);
    const requested = recordAgentSessionEvent(working, {
      kind: 'STOP_REQUESTED',
      occurredAt: createdAt + 2,
    });
    const duplicate = recordAgentSessionEvent(requested, {
      kind: 'STOP_REQUESTED',
      occurredAt: createdAt + 3,
    });

    expect(requested.status).toBe(Status.WORKING);
    expect(requested.history.at(-1)?.kind).toBe('STOP_REQUESTED');
    expect(duplicate).toBe(requested);
  });

  it.each([Status.EXITED, Status.FAILED] as const)(
    'rejects status changes and stop requests after terminal status %s',
    (terminalStatus) => {
      const terminal = reachTerminalStatus(terminalStatus);

      expect(() => reportStatus(terminal, Status.WORKING)).toThrow(
        InvalidAgentSessionStatusTransitionError,
      );
      expect(() =>
        recordAgentSessionEvent(terminal, {
          kind: 'STOP_REQUESTED',
          occurredAt: createdAt + 20,
        }),
      ).toThrow(InvalidAgentSessionStatusTransitionError);
    },
  );

  it('rejects an event timestamp before the prior history event', () => {
    const working = reportStatus(createStartingSession(), Status.WORKING, createdAt + 5);

    expect(() => reportStatus(working, Status.IDLE, createdAt + 4)).toThrow(TypeError);
  });

  it.each([
    { code: '', fatal: true, kind: 'RUNTIME_FAILED', stage: 'START' },
    { code: 'SAFE', fatal: true, kind: 'RUNTIME_FAILED', runtimeSequence: 0, stage: 'START' },
    { exitCode: 1.5, kind: 'PROCESS_EXITED', reason: 'PROCESS_EXIT', runtimeSequence: 1 },
  ] as const)('rejects invalid structured evidence %#', (invalidEvent) => {
    expect(() =>
      recordAgentSessionEvent(createStartingSession(), {
        occurredAt: createdAt + 1,
        ...invalidEvent,
      } as never),
    ).toThrow(TypeError);
  });
});

function reachStatus(status: AgentSessionStatusValue): AgentSession {
  const starting = createStartingSession();
  if (status === Status.STARTING) {
    return starting;
  }

  const working = reportStatus(starting, Status.WORKING);
  if (status === Status.WORKING) {
    return working;
  }

  if (status === Status.IDLE) {
    return reportStatus(working, Status.IDLE);
  }

  if (status === Status.WAITING_INPUT) {
    return reportStatus(working, Status.WAITING_INPUT);
  }

  throw new TypeError(`Cannot reach ${status} as a live test status.`);
}

function reachTerminalStatus(status: 'EXITED' | 'FAILED'): AgentSession {
  if (status === Status.EXITED) {
    return recordAgentSessionEvent(createStartingSession(), {
      exitCode: 0,
      kind: 'PROCESS_EXITED',
      occurredAt: createdAt + 1,
      reason: 'PROCESS_EXIT',
      runtimeSequence: 2,
    });
  }

  return recordAgentSessionEvent(createStartingSession(), {
    code: 'RUNTIME_FAILURE',
    fatal: true,
    kind: 'RUNTIME_FAILED',
    occurredAt: createdAt + 1,
    runtimeSequence: 2,
    stage: 'RUNTIME',
  });
}
