export const QualityGateKind = {
  BUILD: 'BUILD',
  LINT: 'LINT',
  TEST: 'TEST',
  TYPECHECK: 'TYPECHECK',
} as const;

export type QualityGateKind = (typeof QualityGateKind)[keyof typeof QualityGateKind];

export const QualityGateRunStatus = {
  FAILED: 'FAILED',
  INFRASTRUCTURE_FAILED: 'INFRASTRUCTURE_FAILED',
  LAUNCH_FAILED: 'LAUNCH_FAILED',
  PASSED: 'PASSED',
  RUNNING: 'RUNNING',
  TIMED_OUT: 'TIMED_OUT',
} as const;

export type QualityGateRunStatus = (typeof QualityGateRunStatus)[keyof typeof QualityGateRunStatus];

export type QualityGateFailureCategory = 'COMMAND' | 'INFRASTRUCTURE' | 'LAUNCH' | 'TIMEOUT';

export interface QualityGateCommand {
  readonly arguments: readonly string[];
  readonly executablePath: string;
}

export interface QualityGate {
  readonly command: QualityGateCommand;
  readonly id: string;
  readonly kind: QualityGateKind;
  readonly timeoutMs: number;
}

export interface QualityGateWorktree {
  readonly baseCommitId: string;
  readonly branchName: string;
  /** Attached HEAD observed immediately before this run was persisted and launched. */
  readonly headCommitIdAtStart: string;
  readonly pathIdentity: string;
  readonly worktreePath: string;
}

export interface QualityGateOutput {
  readonly reference: string;
  /** Bounded, redacted diagnostic output safe for persistence and display. */
  readonly text: string;
  readonly truncated: boolean;
}

export interface QualityGateRun {
  readonly durationMs: number | undefined;
  readonly exitCode: number | undefined;
  readonly failureCategory: QualityGateFailureCategory | undefined;
  readonly finishedAt: number | undefined;
  readonly gate: QualityGate;
  readonly id: string;
  readonly output: QualityGateOutput | undefined;
  readonly startedAt: number;
  readonly status: QualityGateRunStatus;
  readonly taskId: string;
  readonly worktree: QualityGateWorktree;
}

export interface StartQualityGateRunInput {
  readonly gate: QualityGate;
  readonly id: string;
  readonly startedAt: number;
  readonly taskId: string;
  readonly worktree: QualityGateWorktree;
}

interface QualityGateRunTerminalInput {
  readonly finishedAt: number;
  readonly output: QualityGateOutput;
}

export type CompleteQualityGateRunInput =
  | (QualityGateRunTerminalInput & { readonly exitCode: number; readonly kind: 'exited' })
  | (QualityGateRunTerminalInput & { readonly kind: 'timed-out' })
  | (QualityGateRunTerminalInput & { readonly kind: 'launch-failed' })
  | (QualityGateRunTerminalInput & { readonly kind: 'infrastructure-failed' });

export class InvalidQualityGateRunTransitionError extends Error {
  public readonly from: QualityGateRunStatus;

  public constructor(from: QualityGateRunStatus) {
    super(`Cannot complete a Quality Gate Run from ${from}.`);
    this.name = 'InvalidQualityGateRunTransitionError';
    this.from = from;
  }
}

export function createQualityGate(input: QualityGate): QualityGate {
  assertNonBlank(input.id, 'Quality Gate id');
  assertNoNul(input.id, 'Quality Gate id');
  assertEnumValue(input.kind, Object.values(QualityGateKind), 'Quality Gate kind');
  assertNonBlank(input.command.executablePath, 'Quality Gate executable path');
  assertNoNul(input.command.executablePath, 'Quality Gate executable path');
  if (!Array.isArray(input.command.arguments)) {
    throw new TypeError('Quality Gate arguments must be an array.');
  }
  for (const argument of input.command.arguments) {
    if (typeof argument !== 'string') {
      throw new TypeError('Quality Gate arguments must be strings.');
    }
    assertNoNul(argument, 'Quality Gate argument');
  }
  assertSafePositiveInteger(input.timeoutMs, 'Quality Gate timeout');

  return Object.freeze({
    command: Object.freeze({
      arguments: Object.freeze([...input.command.arguments]),
      executablePath: input.command.executablePath,
    }),
    id: input.id,
    kind: input.kind,
    timeoutMs: input.timeoutMs,
  });
}

export function startQualityGateRun(input: StartQualityGateRunInput): QualityGateRun {
  assertNonBlank(input.id, 'Quality Gate Run id');
  assertNoNul(input.id, 'Quality Gate Run id');
  assertNonBlank(input.taskId, 'Quality Gate Run Task id');
  assertNoNul(input.taskId, 'Quality Gate Run Task id');
  assertTimestamp(input.startedAt, 'Quality Gate Run start timestamp');
  const gate = createQualityGate(input.gate);
  const worktree = createWorktree(input.worktree);

  return freezeRun({
    durationMs: undefined,
    exitCode: undefined,
    failureCategory: undefined,
    finishedAt: undefined,
    gate,
    id: input.id,
    output: undefined,
    startedAt: input.startedAt,
    status: QualityGateRunStatus.RUNNING,
    taskId: input.taskId,
    worktree,
  });
}

export function completeQualityGateRun(
  run: QualityGateRun,
  input: CompleteQualityGateRunInput,
): QualityGateRun {
  if (run.status !== QualityGateRunStatus.RUNNING) {
    throw new InvalidQualityGateRunTransitionError(run.status);
  }
  assertTimestamp(input.finishedAt, 'Quality Gate Run finish timestamp');
  if (input.finishedAt < run.startedAt) {
    throw new TypeError('Quality Gate Run cannot finish before it starts.');
  }
  const output = createOutput(input.output);

  let status: Exclude<QualityGateRunStatus, 'RUNNING'>;
  let failureCategory: QualityGateFailureCategory | undefined;
  let exitCode: number | undefined;
  switch (input.kind) {
    case 'exited':
      assertInteger(input.exitCode, 'Quality Gate exit code');
      exitCode = input.exitCode;
      status = input.exitCode === 0 ? QualityGateRunStatus.PASSED : QualityGateRunStatus.FAILED;
      failureCategory = input.exitCode === 0 ? undefined : 'COMMAND';
      break;
    case 'timed-out':
      status = QualityGateRunStatus.TIMED_OUT;
      failureCategory = 'TIMEOUT';
      break;
    case 'launch-failed':
      status = QualityGateRunStatus.LAUNCH_FAILED;
      failureCategory = 'LAUNCH';
      break;
    case 'infrastructure-failed':
      status = QualityGateRunStatus.INFRASTRUCTURE_FAILED;
      failureCategory = 'INFRASTRUCTURE';
      break;
  }

  return freezeRun({
    ...run,
    durationMs: input.finishedAt - run.startedAt,
    exitCode,
    failureCategory,
    finishedAt: input.finishedAt,
    output,
    status,
  });
}

function createWorktree(input: QualityGateWorktree): QualityGateWorktree {
  assertNonBlank(input.pathIdentity, 'Quality Gate Worktree path identity');
  assertNonBlank(input.worktreePath, 'Quality Gate Worktree path');
  assertNonBlank(input.branchName, 'Quality Gate Worktree branch');
  assertNonBlank(input.baseCommitId, 'Quality Gate Worktree base commit id');
  assertNonBlank(input.headCommitIdAtStart, 'Quality Gate Worktree HEAD commit id');
  for (const value of [input.pathIdentity, input.worktreePath, input.branchName]) {
    assertNoNul(value, 'Quality Gate Worktree metadata');
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(input.baseCommitId)) {
    throw new TypeError('Quality Gate Worktree base commit id is invalid.');
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(input.headCommitIdAtStart)) {
    throw new TypeError('Quality Gate Worktree HEAD commit id is invalid.');
  }
  return Object.freeze({ ...input });
}

function createOutput(input: QualityGateOutput): QualityGateOutput {
  assertNonBlank(input.reference, 'Quality Gate output reference');
  assertNoNul(input.reference, 'Quality Gate output reference');
  if (typeof input.text !== 'string' || typeof input.truncated !== 'boolean') {
    throw new TypeError('Quality Gate output is invalid.');
  }
  return Object.freeze({ ...input });
}

function freezeRun(run: QualityGateRun): QualityGateRun {
  return Object.freeze(run);
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must not be blank.`);
  }
}

function assertNoNul(value: string, field: string): void {
  if (value.includes('\0')) {
    throw new TypeError(`${field} must not contain NUL.`);
  }
}

function assertSafePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer.`);
  }
}

function assertInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer.`);
  }
}

function assertEnumValue<T extends string>(
  value: string,
  values: readonly T[],
  field: string,
): asserts value is T {
  if (!values.includes(value as T)) {
    throw new TypeError(`${field} is invalid.`);
  }
}
