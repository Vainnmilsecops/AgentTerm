import {
  TaskPhase,
  completeQualityGateRun,
  startQualityGateRun,
  type QualityGateRun,
} from '@agentterm/domain';

import {
  EntityNotFoundError,
  QualityGateExecutionError,
  QualityGatePersistenceError,
  QualityGateProcessUnsettledError,
} from './errors';
import type {
  GitTaskWorktreeLifecycle,
  LocalProjectLocator,
  QualityGateCatalog,
  QualityGateProcessResult,
  QualityGateProcessRunner,
  QualityGateRunRepository,
  TaskRepository,
  TaskWorktreeRepository,
} from './ports';
import { inspectTaskWorktree, serializeTaskWorktreeOperation } from './task-worktree-use-cases';

const maximumPersistedOutputBytes = 256 * 1024;

export interface RunQualityGateInput {
  /** Complete environment for this configured command. It is never persisted. */
  readonly environment: Readonly<Record<string, string>>;
  readonly gateId: string;
  readonly runId: string;
  readonly taskId: string;
}

export interface RunQualityGateDependencies {
  readonly clock: () => number;
  readonly gates: QualityGateCatalog;
  readonly git: GitTaskWorktreeLifecycle;
  readonly localProjects: LocalProjectLocator;
  readonly maxOutputBytes: number;
  readonly processRunner: QualityGateProcessRunner;
  readonly runs: QualityGateRunRepository;
  readonly tasks: TaskRepository;
  readonly worktrees: TaskWorktreeRepository;
}

export async function runQualityGate(
  input: RunQualityGateInput,
  dependencies: RunQualityGateDependencies,
): Promise<QualityGateRun> {
  return serializeTaskWorktreeOperation(input.taskId, () =>
    runQualityGateExclusive(input, dependencies),
  );
}

async function runQualityGateExclusive(
  input: RunQualityGateInput,
  dependencies: RunQualityGateDependencies,
): Promise<QualityGateRun> {
  const task = await dependencies.tasks.findById(input.taskId);
  if (task === undefined) {
    throw new EntityNotFoundError('Task', input.taskId);
  }
  if (task.phase === TaskPhase.REVIEW || task.phase === TaskPhase.DONE) {
    throw new QualityGateExecutionError('TASK_PHASE_NOT_RUNNABLE', input.taskId);
  }
  const gate = await dependencies.gates.findById(input.gateId);
  if (gate === undefined || gate.id !== input.gateId) {
    throw new QualityGateExecutionError('GATE_NOT_FOUND', input.taskId);
  }
  assertSafeCommandMetadata(gate.command.arguments, input.taskId);
  const environment = snapshotEnvironment(input.environment, input.taskId);
  const redactValues = collectSensitiveEnvironmentValues(environment);
  if (
    !Number.isSafeInteger(dependencies.maxOutputBytes) ||
    dependencies.maxOutputBytes <= 0 ||
    dependencies.maxOutputBytes > maximumPersistedOutputBytes
  ) {
    throw new TypeError('Quality Gate output limit must be between 1 and 262144 bytes.');
  }

  const inspected = await inspectTaskWorktree(
    { taskId: input.taskId },
    dependencies.tasks,
    dependencies.localProjects,
    dependencies.worktrees,
    dependencies.git,
  );
  if (inspected.persistedState !== 'PRESENT' || inspected.actual.kind !== 'present') {
    throw new QualityGateExecutionError('WORKTREE_NOT_READY', input.taskId);
  }

  const actualWorktree = inspected.actual.worktree;
  const running = startQualityGateRun({
    gate,
    id: input.runId,
    startedAt: dependencies.clock(),
    taskId: task.id,
    worktree: {
      baseCommitId: actualWorktree.baseCommitId,
      branchName: actualWorktree.branchName,
      headCommitIdAtStart: inspected.actual.headCommitId,
      pathIdentity: actualWorktree.pathIdentity,
      worktreePath: actualWorktree.worktreePath,
    },
  });
  await dependencies.runs.insert(running);

  let processResult: QualityGateProcessResult;
  try {
    processResult = await dependencies.processRunner.run({
      arguments: gate.command.arguments,
      environment,
      executablePath: gate.command.executablePath,
      maxOutputBytes: dependencies.maxOutputBytes,
      redactValues,
      timeoutMs: gate.timeoutMs,
      workingDirectory: actualWorktree.worktreePath,
    });
  } catch (error) {
    throw new QualityGateProcessUnsettledError(
      running,
      'PROCESS_RESULT_UNAVAILABLE',
      { text: '', truncated: false },
      { cause: error },
    );
  }

  const sanitizedResult = sanitizeProcessResult(
    processResult,
    redactValues,
    dependencies.maxOutputBytes,
  );
  if (hasUnsettledProcess(sanitizedResult)) {
    throw new QualityGateProcessUnsettledError(running, 'TERMINATION_UNCONFIRMED', {
      text: sanitizedResult.output,
      truncated: sanitizedResult.truncated,
    });
  }
  const observedRun = completeFromProcessResult(
    running,
    sanitizedResult,
    Math.max(dependencies.clock(), running.startedAt),
  );
  try {
    await dependencies.runs.finalize(observedRun, 'RUNNING');
  } catch (error) {
    throw new QualityGatePersistenceError(observedRun, { cause: error });
  }
  return observedRun;
}

function hasUnsettledProcess(result: QualityGateProcessResult): boolean {
  return (
    (result.kind === 'timed-out' && result.terminationFailed) ||
    (result.kind === 'infrastructure-error' && result.reason === 'TERMINATION_FAILED')
  );
}

function sanitizeProcessResult(
  result: QualityGateProcessResult,
  redactValues: readonly string[],
  maximumBytes: number,
): QualityGateProcessResult {
  if (result.kind === 'launch-error') {
    return result;
  }

  let output = result.output;
  for (const value of [...new Set(redactValues)].sort(
    (left, right) => right.length - left.length,
  )) {
    output = output.split(value).join('[REDACTED]');
  }
  const bounded = boundUtf8(output, maximumBytes);
  return Object.freeze({
    ...result,
    output: bounded.text,
    truncated: result.truncated || bounded.truncated,
  });
}

function boundUtf8(
  value: string,
  maximumBytes: number,
): {
  readonly text: string;
  readonly truncated: boolean;
} {
  let bytes = 0;
  let text = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    const characterBytes =
      codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + characterBytes > maximumBytes) {
      return { text, truncated: true };
    }
    text += character;
    bytes += characterBytes;
  }
  return { text, truncated: false };
}

export async function listQualityGateRuns(
  taskId: string,
  tasks: TaskRepository,
  runs: QualityGateRunRepository,
): Promise<readonly QualityGateRun[]> {
  if ((await tasks.findById(taskId)) === undefined) {
    throw new EntityNotFoundError('Task', taskId);
  }
  return runs.listByTaskId(taskId);
}

function completeFromProcessResult(
  running: QualityGateRun,
  result: QualityGateProcessResult,
  finishedAt: number,
): QualityGateRun {
  const output = Object.freeze({
    reference: `quality-gate-output:${running.id}`,
    text: result.output,
    truncated: result.truncated,
  });
  switch (result.kind) {
    case 'exited':
      return completeQualityGateRun(running, {
        exitCode: result.exitCode,
        finishedAt,
        kind: 'exited',
        output,
      });
    case 'timed-out':
      return completeQualityGateRun(running, {
        finishedAt,
        kind: result.terminationFailed ? 'infrastructure-failed' : 'timed-out',
        output,
      });
    case 'launch-error':
      return completeQualityGateRun(running, {
        finishedAt,
        kind: 'launch-failed',
        output,
      });
    case 'infrastructure-error':
      return completeQualityGateRun(running, {
        finishedAt,
        kind: 'infrastructure-failed',
        output,
      });
  }
}

function collectSensitiveEnvironmentValues(
  environment: Readonly<Record<string, string>>,
): readonly string[] {
  const sensitiveName = /(?:AUTH|CREDENTIAL|PASSWORD|SECRET|TOKEN|(?:^|_)KEY(?:_|$))/iu;
  return Object.freeze(
    Object.entries(environment)
      .filter(([name, value]) => sensitiveName.test(name) && value.length > 0)
      .map(([, value]) => value),
  );
}

function snapshotEnvironment(
  environment: Readonly<Record<string, string>>,
  taskId: string,
): Readonly<Record<string, string>> {
  try {
    if (
      environment === null ||
      typeof environment !== 'object' ||
      Array.isArray(environment) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(environment))
    ) {
      throw new TypeError('invalid environment');
    }
    const copy: Record<string, string> = {};
    const normalizedNames = new Set<string>();
    for (const name of Reflect.ownKeys(environment)) {
      if (typeof name !== 'string') {
        throw new TypeError('invalid environment');
      }
      const descriptor = Object.getOwnPropertyDescriptor(environment, name);
      const normalizedName = name.toLocaleUpperCase('en-US');
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor) ||
        typeof descriptor.value !== 'string' ||
        name.length === 0 ||
        name === '__proto__' ||
        name.includes('=') ||
        name.includes('\0') ||
        descriptor.value.includes('\0') ||
        normalizedNames.has(normalizedName)
      ) {
        throw new TypeError('invalid environment');
      }
      normalizedNames.add(normalizedName);
      copy[name] = descriptor.value;
    }
    return Object.freeze(copy);
  } catch {
    throw new QualityGateExecutionError('INVALID_ENVIRONMENT', taskId);
  }
}

function assertSafeCommandMetadata(argumentsList: readonly string[], taskId: string): void {
  const sensitiveFlag =
    /(?:^|[-_])(?:api[-_]?key|auth|credential|password|private[-_]?key|secret|token)(?:$|[=_-])/iu;
  const sensitiveValue = /(?:authorization\s*:|bearer\s+|basic\s+)[^\s]/iu;
  if (
    argumentsList.some((argument) => sensitiveFlag.test(argument) || sensitiveValue.test(argument))
  ) {
    throw new QualityGateExecutionError('UNSAFE_COMMAND_METADATA', taskId);
  }
}
