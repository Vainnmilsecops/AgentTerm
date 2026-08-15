import { realpath, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { release } from 'node:os';
import { isAbsolute } from 'node:path';

import { PtyRuntimeError } from '@agentterm/application';
import type {
  AgentSessionHostOwnership,
  PtyHandle,
  PtyLaunchSpec,
  PtyRuntime,
  PtyRuntimeEvent,
  PtyRuntimeEventSink,
  PtyRuntimeFailureReason,
  PtyRuntimeOperation,
  PtyTerminalSize,
} from '@agentterm/application';

import {
  spawnWindowsConPtyHost,
  type HostedPtyExitEvent,
  type HostedPtyProcess,
} from './windows-conpty-host-client';

const CONPTY_MINIMUM_WINDOWS_BUILD = 18_309;
const CONPTY_MAXIMUM_DIMENSION = 32_767;
const NODE_PTY_RUNTIME_FAILURE_SIGNAL = -1;

type BackendExitEvent = HostedPtyExitEvent;

interface BackendSubscription {
  dispose(): void;
}

interface NormalizedBackendExitEvent {
  readonly exitCode: number;
  readonly signal?: number;
}

type PendingBackendEvent =
  | {
      readonly data: string;
      readonly kind: 'output';
    }
  | {
      readonly event: BackendExitEvent;
      readonly kind: 'exit';
    };

interface ValidatedLaunchSpec {
  readonly arguments: string[];
  readonly environment: Record<string, string>;
  readonly executablePath: string;
  readonly initialSize: PtyTerminalSize;
  readonly workingDirectory: string;
}

class PtyEventDispatcher {
  private sequence = 0;
  private terminalEventEmitted = false;

  public constructor(private readonly sink: PtyRuntimeEventSink) {}

  public started(): void {
    this.publish({ kind: 'started', sequence: this.nextSequence() });
  }

  public output(data: string): void {
    if (this.terminalEventEmitted) {
      return;
    }

    this.publish({ data, kind: 'output', sequence: this.nextSequence() });
  }

  public failed(operation: PtyRuntimeOperation, reason: PtyRuntimeFailureReason): void {
    if (this.terminalEventEmitted) {
      return;
    }

    this.publish({ kind: 'failed', operation, reason, sequence: this.nextSequence() });
  }

  public exited(event: NormalizedBackendExitEvent): void {
    if (this.terminalEventEmitted) {
      return;
    }

    const sequence = this.nextSequence();
    const runtimeEvent: PtyRuntimeEvent =
      event.signal === undefined
        ? { exitCode: event.exitCode, kind: 'exited', sequence }
        : { exitCode: event.exitCode, kind: 'exited', sequence, signal: event.signal };

    this.terminalEventEmitted = true;
    this.publish(runtimeEvent);
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private publish(event: PtyRuntimeEvent): void {
    try {
      this.sink(event);
    } catch {
      // Application event handling must not escape into native PTY callbacks or leak the process.
    }
  }
}

class ManagedConPtyHandle implements PtyHandle {
  private announced = false;
  private readonly completion: Promise<void>;
  private complete: (() => void) | undefined;
  private dataSubscription: BackendSubscription | undefined;
  private exitQueued = false;
  private exitSubscription: BackendSubscription | undefined;
  private readonly pendingEvents: PendingBackendEvent[] = [];
  private state: 'exited' | 'running' | 'starting' | 'terminating' | 'termination-failed' =
    'starting';
  private subscriptionsDisposed = false;
  private terminationAttempt: Promise<void> | undefined;

  private constructor(
    private readonly pty: HostedPtyProcess,
    private readonly events: PtyEventDispatcher,
  ) {
    this.completion = new Promise((resolve) => {
      this.complete = resolve;
    });
  }

  public static create(pty: HostedPtyProcess, events: PtyEventDispatcher): ManagedConPtyHandle {
    const handle = new ManagedConPtyHandle(pty, events);

    try {
      handle.dataSubscription = pty.onData((data) => handle.receiveData(data));
      handle.exitSubscription = pty.onExit((event) => handle.receiveExit(event));
      handle.announceStarted();
      return handle;
    } catch {
      handle.cleanupFailedSetup();
      throw new PtyRuntimeError('spawn', 'RUNTIME_FAILURE');
    }
  }

  public async write(input: string): Promise<void> {
    this.assertRunning('write');

    if (typeof input !== 'string') {
      this.fail('write', 'INVALID_INPUT');
    }

    try {
      await this.pty.write(input);
    } catch {
      this.fail('write', 'RUNTIME_FAILURE');
    }
  }

  public async resize(size: PtyTerminalSize): Promise<void> {
    this.assertRunning('resize');

    if (!isValidTerminalSize(size)) {
      this.fail('resize', 'INVALID_TERMINAL_SIZE');
    }

    try {
      await this.pty.resize(size.columns, size.rows);
    } catch {
      this.fail('resize', 'RUNTIME_FAILURE');
    }
  }

  public terminate(): Promise<void> {
    if (this.state === 'exited') {
      return Promise.resolve();
    }

    if (this.terminationAttempt !== undefined) {
      return this.terminationAttempt;
    }

    this.state = 'terminating';
    const attempt = this.killAndWaitForExit();
    this.terminationAttempt = attempt;

    void attempt.catch(() => {
      if (this.state === 'termination-failed' && this.terminationAttempt === attempt) {
        this.terminationAttempt = undefined;
      }
    });

    return attempt;
  }

  public dispose(): Promise<void> {
    return this.terminate();
  }

  private announceStarted(): void {
    this.announced = true;
    this.events.started();
    this.state = 'running';

    const pendingEvents = this.pendingEvents.splice(0);
    for (const event of pendingEvents) {
      if (event.kind === 'output') {
        this.events.output(event.data);
      } else {
        this.finalizeExit(event.event);
        break;
      }
    }
  }

  private assertRunning(operation: 'resize' | 'write'): void {
    if (this.state !== 'running') {
      throw new PtyRuntimeError(operation, 'NOT_RUNNING');
    }
  }

  private cleanupFailedSetup(): void {
    this.state = 'exited';
    this.disposeSubscriptions();

    try {
      void Promise.resolve(this.pty.kill()).catch(() => undefined);
    } catch {
      // The sanitized spawn failure remains the only externally visible setup error.
    }

    this.complete?.();
    this.complete = undefined;
  }

  private disposeSubscriptions(): boolean {
    if (this.subscriptionsDisposed) {
      return false;
    }

    this.subscriptionsDisposed = true;
    const subscriptions = [this.dataSubscription, this.exitSubscription];
    this.dataSubscription = undefined;
    this.exitSubscription = undefined;
    let failed = false;

    for (const subscription of subscriptions) {
      try {
        subscription?.dispose();
      } catch {
        failed = true;
      }
    }

    return failed;
  }

  private fail(
    operation: 'resize' | 'write',
    reason: 'INVALID_INPUT' | 'INVALID_TERMINAL_SIZE' | 'RUNTIME_FAILURE',
  ): never {
    this.events.failed(operation, reason);
    throw new PtyRuntimeError(operation, reason);
  }

  private finalizeExit(event: BackendExitEvent): void {
    if (this.state === 'exited') {
      return;
    }

    const nativeFailureMarker = event.signal === NODE_PTY_RUNTIME_FAILURE_SIGNAL;
    const malformedExitEvidence =
      !Number.isSafeInteger(event.exitCode) ||
      (event.signal !== undefined && !Number.isSafeInteger(event.signal));
    const runtimeFailed =
      this.state === 'running' && (nativeFailureMarker || malformedExitEvidence);
    const failureOperation = this.failureOperation();
    const normalizedExit: NormalizedBackendExitEvent =
      nativeFailureMarker || malformedExitEvidence
        ? { exitCode: -1 }
        : event.signal === undefined
          ? { exitCode: event.exitCode as number }
          : { exitCode: event.exitCode as number, signal: event.signal };
    this.state = 'exited';
    const cleanupFailed = this.disposeSubscriptions();
    if (runtimeFailed) {
      this.events.failed(failureOperation, 'RUNTIME_FAILURE');
    }
    if (cleanupFailed) {
      this.events.failed('cleanup', 'RUNTIME_FAILURE');
    }
    this.events.exited(normalizedExit);
    this.complete?.();
    this.complete = undefined;
  }

  private failureOperation(): 'runtime' | 'spawn' {
    try {
      return Number.isSafeInteger(this.pty.pid) && this.pty.pid > 0 ? 'runtime' : 'spawn';
    } catch {
      return 'runtime';
    }
  }

  private async killAndWaitForExit(): Promise<void> {
    try {
      await this.pty.kill();
    } catch {
      if (this.state === 'exited') {
        return;
      }
      this.state = 'termination-failed';
      this.events.failed('terminate', 'RUNTIME_FAILURE');
      throw new PtyRuntimeError('terminate', 'RUNTIME_FAILURE');
    }

    await this.completion;
  }

  private receiveData(data: string): void {
    if (this.state === 'exited' || this.exitQueued) {
      return;
    }

    if (!this.announced) {
      this.pendingEvents.push({ data, kind: 'output' });
      return;
    }

    this.events.output(data);
  }

  private receiveExit(event: BackendExitEvent): void {
    if (this.state === 'exited' || this.exitQueued) {
      return;
    }

    this.exitQueued = true;
    if (!this.announced) {
      this.pendingEvents.push({ event, kind: 'exit' });
      return;
    }

    this.finalizeExit(event);
  }
}

export class WindowsConPtyRuntime implements PtyRuntime {
  public async open(spec: PtyLaunchSpec, sink: PtyRuntimeEventSink): Promise<PtyHandle> {
    const events = new PtyEventDispatcher(sink);

    try {
      assertConPtyAvailable();
      const launch = await validateLaunchSpec(spec);
      const pty = spawnWindowsConPtyHost({
        arguments: launch.arguments,
        environment: launch.environment,
        executablePath: launch.executablePath,
        initialColumns: launch.initialSize.columns,
        initialRows: launch.initialSize.rows,
        workingDirectory: launch.workingDirectory,
      });

      return ManagedConPtyHandle.create(pty, events);
    } catch (error) {
      const runtimeError =
        error instanceof PtyRuntimeError ? error : new PtyRuntimeError('spawn', 'RUNTIME_FAILURE');

      events.failed('spawn', runtimeError.reason);
      throw runtimeError;
    }
  }

  public async reattach(
    ownership: AgentSessionHostOwnership,
    initialSize: PtyTerminalSize,
    sink: PtyRuntimeEventSink,
  ): Promise<PtyHandle> {
    const events = new PtyEventDispatcher(sink);

    try {
      assertConPtyAvailable();
      assertOwnershipShape(ownership);
      assertValidTerminalSize(initialSize);
    } catch (error) {
      const runtimeError =
        error instanceof PtyRuntimeError ? error : new PtyRuntimeError('spawn', 'RUNTIME_FAILURE');
      events.failed('spawn', runtimeError.reason);
      throw runtimeError;
    }

    // The current Windows ConPTY runtime owns the host through node-pty and does
    // not expose named pipes that another process could open. The orchestrator
    // must therefore fall back to provider-native resume when this surface is
    // reached; the documented ADR records the limitation.
    const reason: PtyRuntimeFailureReason = 'CONPTY_UNAVAILABLE';
    events.failed('spawn', reason);
    throw new PtyRuntimeError('spawn', reason);
  }
}

function assertOwnershipShape(ownership: AgentSessionHostOwnership): void {
  if (ownership.hostPid <= 0) {
    throw new PtyRuntimeError('spawn', 'RUNTIME_FAILURE');
  }
  if (ownership.conptyInPipeName.length === 0 || ownership.conptyOutPipeName.length === 0) {
    throw new PtyRuntimeError('spawn', 'RUNTIME_FAILURE');
  }
}

function assertValidTerminalSize(size: PtyTerminalSize): void {
  if (!isValidTerminalSize(size)) {
    throw new PtyRuntimeError('spawn', 'INVALID_TERMINAL_SIZE');
  }
}

function assertConPtyAvailable(): void {
  if (process.platform !== 'win32') {
    throw new PtyRuntimeError('spawn', 'UNSUPPORTED_PLATFORM');
  }

  const match = /^\d+\.\d+\.(\d+)/u.exec(release());
  const buildNumber = match === null ? Number.NaN : Number.parseInt(match[1] ?? '', 10);
  if (!Number.isSafeInteger(buildNumber) || buildNumber < CONPTY_MINIMUM_WINDOWS_BUILD) {
    throw new PtyRuntimeError('spawn', 'CONPTY_UNAVAILABLE');
  }
}

async function validateLaunchSpec(spec: PtyLaunchSpec): Promise<ValidatedLaunchSpec> {
  const executablePath = await validateExecutablePath(spec.executablePath);
  const workingDirectory = await validateWorkingDirectory(spec.workingDirectory);
  const argumentsList = validateArguments(spec.arguments);
  const environment = validateEnvironment(spec.environment);

  if (!isValidTerminalSize(spec.initialSize)) {
    throw new PtyRuntimeError('spawn', 'INVALID_TERMINAL_SIZE');
  }

  return {
    arguments: argumentsList,
    environment,
    executablePath,
    initialSize: { ...spec.initialSize },
    workingDirectory,
  };
}

function validateArguments(argumentsList: readonly string[]): string[] {
  if (
    !Array.isArray(argumentsList) ||
    argumentsList.some((argument) => typeof argument !== 'string' || argument.includes('\0'))
  ) {
    throw new PtyRuntimeError('spawn', 'INVALID_ARGUMENT');
  }

  return [...argumentsList];
}

function validateEnvironment(
  environment: Readonly<Record<string, string>>,
): Record<string, string> {
  if (
    environment === null ||
    typeof environment !== 'object' ||
    Array.isArray(environment) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(environment))
  ) {
    throw new PtyRuntimeError('spawn', 'INVALID_ENVIRONMENT');
  }

  const environmentKeys = Reflect.ownKeys(environment);
  if (environmentKeys.some((key) => typeof key !== 'string')) {
    throw new PtyRuntimeError('spawn', 'INVALID_ENVIRONMENT');
  }

  const validated: Record<string, string> = {};
  const normalizedNames = new Set<string>();

  for (const key of environmentKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    const normalizedName = key.toLocaleUpperCase('en-US');

    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string' ||
      key.length === 0 ||
      key === '__proto__' ||
      key.includes('=') ||
      key.includes('\0') ||
      descriptor.value.includes('\0') ||
      normalizedNames.has(normalizedName)
    ) {
      throw new PtyRuntimeError('spawn', 'INVALID_ENVIRONMENT');
    }

    normalizedNames.add(normalizedName);
    validated[key] = descriptor.value;
  }

  return validated;
}

async function validateExecutablePath(path: string): Promise<string> {
  if (!isValidAbsolutePath(path)) {
    throw new PtyRuntimeError('spawn', 'INVALID_EXECUTABLE');
  }

  return inspectPath(path, 'INVALID_EXECUTABLE', (pathStat) => pathStat.isFile());
}

async function validateWorkingDirectory(path: string): Promise<string> {
  if (!isValidAbsolutePath(path)) {
    throw new PtyRuntimeError('spawn', 'INVALID_WORKING_DIRECTORY');
  }

  return inspectPath(path, 'INVALID_WORKING_DIRECTORY', (pathStat) => pathStat.isDirectory());
}

async function inspectPath(
  path: string,
  reason: 'INVALID_EXECUTABLE' | 'INVALID_WORKING_DIRECTORY',
  accepts: (pathStat: Stats) => boolean,
): Promise<string> {
  try {
    const canonicalPath = await resolveNativeRealPath(path);
    const pathStat = await stat(canonicalPath);
    if (!accepts(pathStat)) {
      throw new PtyRuntimeError('spawn', reason);
    }
    return canonicalPath;
  } catch (error) {
    if (error instanceof PtyRuntimeError) {
      throw error;
    }
    throw new PtyRuntimeError('spawn', reason);
  }
}

function isValidAbsolutePath(path: string): boolean {
  return typeof path === 'string' && path.length > 0 && !path.includes('\0') && isAbsolute(path);
}

function isValidTerminalSize(size: PtyTerminalSize): boolean {
  try {
    return (
      size !== null &&
      typeof size === 'object' &&
      Number.isInteger(size.columns) &&
      Number.isInteger(size.rows) &&
      size.columns >= 1 &&
      size.rows >= 1 &&
      size.columns <= CONPTY_MAXIMUM_DIMENSION &&
      size.rows <= CONPTY_MAXIMUM_DIMENSION
    );
  } catch {
    return false;
  }
}

function resolveNativeRealPath(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    realpath.native(path, (error, resolvedPath) => {
      if (error === null) {
        resolve(resolvedPath);
      } else {
        reject(error);
      }
    });
  });
}
