import {
  AgentSessionStatus,
  type AgentSessionStatus as AgentSessionStatusValue,
} from './agent-session-status';
import {
  createAgentSessionHostOwnership,
  isAgentSessionHostOwnership,
  type AgentSessionHostOwnership,
} from './agent-session-ownership';

export type AgentSessionActiveStatus = 'IDLE' | 'WAITING_INPUT' | 'WORKING';
export type AgentSessionFailureStage =
  'CLEANUP' | 'RESIZE' | 'RUNTIME' | 'START' | 'TERMINATE' | 'WRITE';

export interface AgentSessionStartRequestedEvent {
  readonly kind: 'START_REQUESTED';
  readonly occurredAt: number;
  readonly sequence: number;
  readonly status: 'STARTING';
}

export interface AgentSessionStatusReportedEvent {
  readonly kind: 'STATUS_REPORTED';
  readonly occurredAt: number;
  readonly runtimeSequence?: number;
  readonly sequence: number;
  readonly source: 'APPLICATION' | 'RUNTIME';
  readonly status: AgentSessionActiveStatus;
}

export interface AgentSessionStopRequestedEvent {
  readonly kind: 'STOP_REQUESTED';
  readonly occurredAt: number;
  readonly sequence: number;
  readonly status: AgentSessionStatusValue;
}

export interface AgentSessionRuntimeFailedEvent {
  readonly code: string;
  readonly fatal: boolean;
  readonly kind: 'RUNTIME_FAILED';
  readonly occurredAt: number;
  readonly runtimeSequence?: number;
  readonly sequence: number;
  readonly stage: AgentSessionFailureStage;
  readonly status: AgentSessionStatusValue;
}

export interface AgentSessionProcessExitedEvent {
  readonly exitCode: number;
  readonly kind: 'PROCESS_EXITED';
  readonly occurredAt: number;
  readonly reason: 'PROCESS_EXIT' | 'STOPPED';
  readonly runtimeSequence: number;
  readonly sequence: number;
  readonly signal?: number;
  readonly status: 'EXITED' | 'FAILED';
}

export type AgentSessionEvent =
  | AgentSessionProcessExitedEvent
  | AgentSessionRuntimeFailedEvent
  | AgentSessionStartRequestedEvent
  | AgentSessionStatusReportedEvent
  | AgentSessionStopRequestedEvent;

export interface AgentSession {
  readonly agentId: string;
  readonly createdAt: number;
  readonly endedAt: number | undefined;
  readonly history: readonly AgentSessionEvent[];
  readonly hostOwnership: AgentSessionHostOwnership | undefined;
  readonly id: string;
  readonly providerSessionId: string | undefined;
  readonly status: AgentSessionStatusValue;
  readonly taskId: string;
}

export interface CreateAgentSessionInput {
  readonly agentId: string;
  readonly createdAt: number;
  readonly id: string;
  readonly taskId: string;
}

export type RecordAgentSessionEventInput =
  | {
      readonly kind: 'STATUS_REPORTED';
      readonly occurredAt: number;
      readonly runtimeSequence?: number;
      readonly source: 'APPLICATION' | 'RUNTIME';
      readonly status: AgentSessionActiveStatus;
    }
  | {
      readonly kind: 'STOP_REQUESTED';
      readonly occurredAt: number;
    }
  | {
      readonly code: string;
      readonly fatal: boolean;
      readonly kind: 'RUNTIME_FAILED';
      readonly occurredAt: number;
      readonly runtimeSequence?: number;
      readonly stage: AgentSessionFailureStage;
    }
  | {
      readonly exitCode: number;
      readonly kind: 'PROCESS_EXITED';
      readonly occurredAt: number;
      readonly reason: 'PROCESS_EXIT' | 'STOPPED';
      readonly runtimeSequence: number;
      readonly signal?: number;
    };

export class InvalidAgentSessionStatusTransitionError extends Error {
  public readonly from: AgentSessionStatusValue;
  public readonly to: AgentSessionStatusValue;

  public constructor(from: AgentSessionStatusValue, to: AgentSessionStatusValue) {
    super(`Cannot transition an Agent Session from ${from} to ${to}.`);
    this.name = 'InvalidAgentSessionStatusTransitionError';
    this.from = from;
    this.to = to;
  }
}

const allowedStatusTransitions: Readonly<
  Record<AgentSessionStatusValue, readonly AgentSessionStatusValue[]>
> = {
  [AgentSessionStatus.EXITED]: [],
  [AgentSessionStatus.FAILED]: [],
  [AgentSessionStatus.IDLE]: [
    AgentSessionStatus.WORKING,
    AgentSessionStatus.WAITING_INPUT,
    AgentSessionStatus.EXITED,
    AgentSessionStatus.FAILED,
  ],
  [AgentSessionStatus.STARTING]: [
    AgentSessionStatus.WORKING,
    AgentSessionStatus.EXITED,
    AgentSessionStatus.FAILED,
  ],
  [AgentSessionStatus.WAITING_INPUT]: [
    AgentSessionStatus.WORKING,
    AgentSessionStatus.IDLE,
    AgentSessionStatus.EXITED,
    AgentSessionStatus.FAILED,
  ],
  [AgentSessionStatus.WORKING]: [
    AgentSessionStatus.IDLE,
    AgentSessionStatus.WAITING_INPUT,
    AgentSessionStatus.EXITED,
    AgentSessionStatus.FAILED,
  ],
};

export function createAgentSession(input: CreateAgentSessionInput): AgentSession {
  assertNonBlank(input.id, 'Agent Session id');
  assertNonBlank(input.taskId, 'Agent Session Task id');
  assertNonBlank(input.agentId, 'Agent Session agent id');
  assertTimestamp(input.createdAt, 'Agent Session creation timestamp');

  const initialEvent: AgentSessionStartRequestedEvent = Object.freeze({
    kind: 'START_REQUESTED',
    occurredAt: input.createdAt,
    sequence: 1,
    status: AgentSessionStatus.STARTING,
  });

  return freezeSession({
    agentId: input.agentId,
    createdAt: input.createdAt,
    endedAt: undefined,
    history: [initialEvent],
    hostOwnership: undefined,
    id: input.id,
    providerSessionId: undefined,
    status: AgentSessionStatus.STARTING,
    taskId: input.taskId,
  });
}

export function recordAgentSessionEvent(
  session: AgentSession,
  input: RecordAgentSessionEventInput,
): AgentSession {
  const lastEvent = session.history.at(-1);
  if (lastEvent === undefined) {
    throw new TypeError('Agent Session history must not be empty.');
  }
  assertTimestamp(input.occurredAt, 'Agent Session event timestamp');
  if (input.occurredAt < lastEvent.occurredAt) {
    throw new TypeError('Agent Session event timestamp must not precede its history.');
  }

  if (input.kind === 'STOP_REQUESTED') {
    assertLive(session.status, session.status);
    if (session.history.some((event) => event.kind === 'STOP_REQUESTED')) {
      return session;
    }
    return appendEvent(session, {
      kind: input.kind,
      occurredAt: input.occurredAt,
      sequence: session.history.length + 1,
      status: session.status,
    });
  }

  if (input.kind === 'STATUS_REPORTED') {
    assertRuntimeSequence(input.runtimeSequence);
    assertTransition(session.status, input.status);
    return appendEvent(session, {
      kind: input.kind,
      occurredAt: input.occurredAt,
      ...(input.runtimeSequence === undefined ? {} : { runtimeSequence: input.runtimeSequence }),
      sequence: session.history.length + 1,
      source: input.source,
      status: input.status,
    });
  }

  if (input.kind === 'RUNTIME_FAILED') {
    assertFailureCode(input.code);
    assertRuntimeSequence(input.runtimeSequence);
    if (session.status === AgentSessionStatus.EXITED) {
      throw new InvalidAgentSessionStatusTransitionError(
        session.status,
        input.fatal ? AgentSessionStatus.FAILED : session.status,
      );
    }
    if (session.status !== AgentSessionStatus.FAILED) {
      assertLive(session.status, input.fatal ? AgentSessionStatus.FAILED : session.status);
    }
    const status = input.fatal ? AgentSessionStatus.FAILED : session.status;
    return appendEvent(
      session,
      {
        code: input.code,
        fatal: input.fatal,
        kind: input.kind,
        occurredAt: input.occurredAt,
        ...(input.runtimeSequence === undefined ? {} : { runtimeSequence: input.runtimeSequence }),
        sequence: session.history.length + 1,
        stage: input.stage,
        status,
      },
      input.fatal && session.status !== AgentSessionStatus.FAILED ? input.occurredAt : undefined,
    );
  }

  assertSafeInteger(input.exitCode, 'Agent Session exit code');
  assertSafePositiveInteger(input.runtimeSequence, 'Agent Session runtime sequence');
  if (input.signal !== undefined) {
    assertSafeInteger(input.signal, 'Agent Session exit signal');
  }

  if (session.status !== AgentSessionStatus.FAILED) {
    assertTransition(session.status, AgentSessionStatus.EXITED);
  }
  const status =
    session.status === AgentSessionStatus.FAILED
      ? AgentSessionStatus.FAILED
      : AgentSessionStatus.EXITED;
  return appendEvent(
    session,
    {
      exitCode: input.exitCode,
      kind: input.kind,
      occurredAt: input.occurredAt,
      reason: input.reason,
      runtimeSequence: input.runtimeSequence,
      sequence: session.history.length + 1,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      status,
    },
    status === AgentSessionStatus.EXITED ? input.occurredAt : undefined,
  );
}

function appendEvent(
  session: AgentSession,
  event: AgentSessionEvent,
  endedAt = session.endedAt,
): AgentSession {
  const frozenEvent = Object.freeze({ ...event }) as AgentSessionEvent;
  return freezeSession({
    ...session,
    endedAt,
    history: [...session.history, frozenEvent],
    status: frozenEvent.status,
  });
}

export function attachHostOwnership(
  session: AgentSession,
  ownership: AgentSessionHostOwnership,
): AgentSession {
  if (session.hostOwnership !== undefined) {
    return session;
  }
  return freezeSession({
    ...session,
    hostOwnership: createAgentSessionHostOwnership(ownership),
  });
}

export function clearHostOwnership(session: AgentSession): AgentSession {
  if (session.hostOwnership === undefined) {
    return session;
  }
  return freezeSession({
    ...session,
    hostOwnership: undefined,
  });
}

export function setProviderSessionId(
  session: AgentSession,
  providerSessionId: string,
): AgentSession {
  if (session.providerSessionId === providerSessionId) {
    return session;
  }
  return freezeSession({
    ...session,
    providerSessionId,
  });
}

export function hydrateAgentSession(value: unknown): AgentSession {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('Agent Session record must be an object.');
  }
  const candidate = value as Partial<AgentSession> & { hostOwnership?: unknown };
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.taskId !== 'string' ||
    typeof candidate.agentId !== 'string' ||
    typeof candidate.createdAt !== 'number' ||
    typeof candidate.status !== 'string' ||
    !Array.isArray(candidate.history)
  ) {
    throw new TypeError('Agent Session record is missing required fields.');
  }
  const hostOwnership =
    candidate.hostOwnership === undefined || candidate.hostOwnership === null
      ? undefined
      : isAgentSessionHostOwnership(candidate.hostOwnership)
        ? createAgentSessionHostOwnership(candidate.hostOwnership)
        : (() => {
            throw new TypeError('Agent Session hostOwnership has an invalid shape.');
          })();
  return freezeSession({
    agentId: candidate.agentId,
    createdAt: candidate.createdAt,
    endedAt: typeof candidate.endedAt === 'number' ? candidate.endedAt : undefined,
    history: candidate.history as AgentSessionEvent[],
    hostOwnership,
    id: candidate.id,
    providerSessionId:
      typeof candidate.providerSessionId === 'string' ? candidate.providerSessionId : undefined,
    status: candidate.status as AgentSessionStatusValue,
    taskId: candidate.taskId,
  });
}

function freezeSession(session: AgentSession): AgentSession {
  return Object.freeze({ ...session, history: Object.freeze([...session.history]) });
}

function assertTransition(from: AgentSessionStatusValue, to: AgentSessionStatusValue): void {
  if (!allowedStatusTransitions[from].includes(to)) {
    throw new InvalidAgentSessionStatusTransitionError(from, to);
  }
}

function assertLive(from: AgentSessionStatusValue, attemptedStatus: AgentSessionStatusValue): void {
  if (from === AgentSessionStatus.EXITED || from === AgentSessionStatus.FAILED) {
    throw new InvalidAgentSessionStatusTransitionError(from, attemptedStatus);
  }
}

function assertFailureCode(code: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) {
    throw new TypeError('Agent Session failure code must be a stable sanitized code.');
  }
}

function assertRuntimeSequence(sequence: number | undefined): void {
  if (sequence !== undefined) {
    assertSafePositiveInteger(sequence, 'Agent Session runtime sequence');
  }
}

function assertTimestamp(timestamp: number, field: string): void {
  assertSafeInteger(timestamp, field);
  if (timestamp < 0) {
    throw new TypeError(`${field} must not be negative.`);
  }
}

function assertSafePositiveInteger(value: number, field: string): void {
  assertSafeInteger(value, field);
  if (value <= 0) {
    throw new TypeError(`${field} must be positive.`);
  }
}

function assertSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer.`);
  }
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must not be blank.`);
  }
}
