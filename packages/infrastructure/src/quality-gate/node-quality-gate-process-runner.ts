import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants, realpath } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join, isAbsolute, normalize } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { QualityGateProcessRunner } from '@agentterm/application';

type QualityGateProcessRequest = Parameters<QualityGateProcessRunner['run']>[0];
type QualityGateProcessResult = Awaited<ReturnType<QualityGateProcessRunner['run']>>;

const maximumConfiguredOutputBytes = 16 * 1024 * 1024;
const maximumConfiguredTimeoutMs = 24 * 60 * 60 * 1_000;
const terminationGraceMs = 5_000;
const taskkillTimeoutMs = 3_000;

interface ValidatedRequest {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executablePath: string;
  readonly maxOutputBytes: number;
  readonly redactValues: readonly string[];
  readonly timeoutMs: number;
  readonly workingDirectory: string;
}

class InvalidProcessRequestError extends Error {}
class MissingExecutableError extends Error {}

class BoundedRedactedOutput {
  private readonly chunks: Buffer[] = [];
  private discarded = false;
  private retainedBytes = 0;
  private readonly retentionLimit: number;

  public constructor(
    private readonly maximumBytes: number,
    private readonly redactValues: readonly string[],
  ) {
    const longestRedactionValue = redactValues.reduce(
      (longest, value) => Math.max(longest, Buffer.byteLength(value, 'utf8')),
      0,
    );
    this.retentionLimit = maximumBytes + longestRedactionValue;
  }

  public append(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    const available = Math.max(0, this.retentionLimit - this.retainedBytes);
    if (available > 0) {
      const retained = bytes.length <= available ? bytes : bytes.subarray(0, available);
      this.chunks.push(Buffer.from(retained));
      this.retainedBytes += retained.length;
    }
    if (bytes.length > available) {
      this.discarded = true;
    }
  }

  public finish(): { readonly output: string; readonly truncated: boolean } {
    const decoder = new StringDecoder('utf8');
    let output = decoder.write(Buffer.concat(this.chunks));
    if (!this.discarded) {
      output += decoder.end();
    }

    for (const value of this.redactValues) {
      output = output.split(value).join('[REDACTED]');
    }

    const encoded = Buffer.from(output, 'utf8');
    if (encoded.length <= this.maximumBytes) {
      return Object.freeze({ output, truncated: this.discarded });
    }

    const truncatedDecoder = new StringDecoder('utf8');
    const boundedOutput = truncatedDecoder.write(encoded.subarray(0, this.maximumBytes));
    return Object.freeze({ output: boundedOutput, truncated: true });
  }
}

export class NodeQualityGateProcessRunner implements QualityGateProcessRunner {
  public async run(request: QualityGateProcessRequest): Promise<QualityGateProcessResult> {
    let validated: ValidatedRequest;

    try {
      validated = await validateRequest(request);
    } catch (error) {
      return Object.freeze({
        kind: 'launch-error',
        output: '',
        reason:
          error instanceof MissingExecutableError ? 'EXECUTABLE_NOT_FOUND' : 'INVALID_REQUEST',
        truncated: false,
      });
    }

    return runValidatedProcess(validated);
  }
}

function runValidatedProcess(request: ValidatedRequest): Promise<QualityGateProcessResult> {
  return new Promise((resolve) => {
    const capturedOutput = new BoundedRedactedOutput(request.maxOutputBytes, request.redactValues);
    let child: ChildProcess;
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
    let processClosed = false;
    let processSpawned = false;
    let processTimedOut = false;
    let protocolFailed = false;
    let settled = false;
    let terminationFailed = false;
    let terminationAttemptCompleted = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: QualityGateProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (cleanupDeadline !== undefined) {
        clearTimeout(cleanupDeadline);
      }
      resolve(Object.freeze(result));
    };

    const finishTimedOut = (): void => {
      if (!processClosed || !terminationAttemptCompleted || settled) {
        return;
      }
      const output = capturedOutput.finish();
      finish({
        kind: 'timed-out',
        output: output.output,
        terminationFailed,
        truncated: output.truncated,
      });
    };

    try {
      child = spawn(request.executablePath, [...request.arguments], {
        cwd: request.workingDirectory,
        env: { ...request.environment },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      finish({
        kind: 'launch-error',
        output: '',
        reason: 'SPAWN_FAILED',
        truncated: false,
      });
      return;
    }

    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      protocolFailed = true;
    }
    stdout?.on('data', (chunk: Buffer | string) => capturedOutput.append(chunk));
    stderr?.on('data', (chunk: Buffer | string) => capturedOutput.append(chunk));
    stdout?.once('error', () => {
      protocolFailed = true;
    });
    stderr?.once('error', () => {
      protocolFailed = true;
    });

    child.once('spawn', () => {
      processSpawned = true;
      timeout = setTimeout(() => {
        processTimedOut = true;
        cleanupDeadline = setTimeout(() => {
          terminationFailed = true;
          try {
            child.kill();
          } catch {
            // The typed result below is the durable evidence for failed cleanup.
          }
          const output = capturedOutput.finish();
          finish({
            kind: 'infrastructure-error',
            output: output.output,
            reason: 'TERMINATION_FAILED',
            truncated: output.truncated,
          });
        }, terminationGraceMs);

        void terminateOwnedProcessTree(child).then((terminated) => {
          terminationAttemptCompleted = true;
          if (!terminated && !settled) {
            terminationFailed = true;
            try {
              child.kill();
            } catch {
              // Wait for close or the bounded cleanup deadline.
            }
          }
          finishTimedOut();
        });
      }, request.timeoutMs);
    });

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (!processSpawned) {
        finish({
          kind: 'launch-error',
          output: '',
          reason: error.code === 'ENOENT' ? 'EXECUTABLE_NOT_FOUND' : 'SPAWN_FAILED',
          truncated: false,
        });
        return;
      }
      protocolFailed = true;
    });

    child.once('close', (exitCode) => {
      processClosed = true;
      if (processTimedOut) {
        finishTimedOut();
        return;
      }
      const output = capturedOutput.finish();
      if (protocolFailed || !Number.isSafeInteger(exitCode)) {
        finish({
          kind: 'infrastructure-error',
          output: output.output,
          reason: 'PROCESS_PROTOCOL_ERROR',
          truncated: output.truncated,
        });
        return;
      }
      finish({
        exitCode: exitCode as number,
        kind: 'exited',
        output: output.output,
        truncated: output.truncated,
      });
    });
  });
}

async function validateRequest(request: QualityGateProcessRequest): Promise<ValidatedRequest> {
  try {
    assertPlainObject(request as unknown);
    assertPositiveSafeInteger(request.timeoutMs, maximumConfiguredTimeoutMs);
    assertPositiveSafeInteger(request.maxOutputBytes, maximumConfiguredOutputBytes);
    const argumentsList = validateArguments(request.arguments);
    const environment = validateEnvironment(request.environment);
    const redactValues = validateRedactionValues(request.redactValues, request.maxOutputBytes);
    const executablePath = await validateExecutablePath(request.executablePath);
    const workingDirectory = await validateWorkingDirectory(request.workingDirectory);

    return Object.freeze({
      arguments: argumentsList,
      environment,
      executablePath,
      maxOutputBytes: request.maxOutputBytes,
      redactValues,
      timeoutMs: request.timeoutMs,
      workingDirectory,
    });
  } catch (error) {
    if (error instanceof MissingExecutableError || error instanceof InvalidProcessRequestError) {
      throw error;
    }
    throw new InvalidProcessRequestError();
  }
}

function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  ) {
    throw new InvalidProcessRequestError();
  }
}

function assertPositiveSafeInteger(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new InvalidProcessRequestError();
  }
}

function validateArguments(argumentsList: readonly string[]): readonly string[] {
  if (
    !Array.isArray(argumentsList) ||
    argumentsList.some((argument) => typeof argument !== 'string' || argument.includes('\0'))
  ) {
    throw new InvalidProcessRequestError();
  }
  return Object.freeze([...argumentsList]);
}

function validateEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  assertPlainObject(environment);
  const names = Reflect.ownKeys(environment);
  if (names.some((name) => typeof name !== 'string')) {
    throw new InvalidProcessRequestError();
  }

  const copy: Record<string, string> = {};
  const normalizedNames = new Set<string>();
  for (const name of names as string[]) {
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
      throw new InvalidProcessRequestError();
    }
    normalizedNames.add(normalizedName);
    copy[name] = descriptor.value;
  }
  return Object.freeze(copy);
}

function validateRedactionValues(
  values: readonly string[],
  maxOutputBytes: number,
): readonly string[] {
  if (
    !Array.isArray(values) ||
    values.some(
      (value) =>
        typeof value !== 'string' ||
        value.length === 0 ||
        value.includes('\0') ||
        Buffer.byteLength(value, 'utf8') > maxOutputBytes,
    )
  ) {
    throw new InvalidProcessRequestError();
  }
  return Object.freeze([...new Set(values)].sort((left, right) => right.length - left.length));
}

async function validateExecutablePath(executablePath: string): Promise<string> {
  if (!isValidAbsolutePath(executablePath)) {
    throw new InvalidProcessRequestError();
  }
  try {
    const canonicalPath = normalize(await resolveNativeRealPath(executablePath));
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile()) {
      throw new InvalidProcessRequestError();
    }
    if (process.platform !== 'win32') {
      await access(canonicalPath, constants.X_OK);
    }
    return canonicalPath;
  } catch (error) {
    if (error instanceof InvalidProcessRequestError) {
      throw error;
    }
    if (getErrorCode(error) === 'ENOENT' || getErrorCode(error) === 'ENOTDIR') {
      throw new MissingExecutableError();
    }
    throw new InvalidProcessRequestError();
  }
}

async function validateWorkingDirectory(workingDirectory: string): Promise<string> {
  if (!isValidAbsolutePath(workingDirectory)) {
    throw new InvalidProcessRequestError();
  }
  try {
    const canonicalPath = normalize(await resolveNativeRealPath(workingDirectory));
    const metadata = await stat(canonicalPath);
    if (!metadata.isDirectory()) {
      throw new InvalidProcessRequestError();
    }
    return canonicalPath;
  } catch (error) {
    if (error instanceof InvalidProcessRequestError) {
      throw error;
    }
    throw new InvalidProcessRequestError();
  }
}

function isValidAbsolutePath(value: string): boolean {
  return (
    typeof value === 'string' && value.length > 0 && !value.includes('\0') && isAbsolute(value)
  );
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

function terminateOwnedProcessTree(child: ChildProcess): Promise<boolean> {
  const processId = child.pid;
  if (!Number.isSafeInteger(processId) || processId === undefined || processId <= 0) {
    return Promise.resolve(false);
  }

  if (process.platform !== 'win32') {
    try {
      child.kill('SIGKILL');
    } catch {
      // A direct kill cannot provide process-tree ownership guarantees.
    }
    return Promise.resolve(false);
  }

  const systemRoot = getEnvironmentVariable('SystemRoot');
  if (systemRoot === undefined || !isAbsolute(systemRoot) || systemRoot.includes('\0')) {
    return Promise.resolve(false);
  }
  const taskkillPath = join(systemRoot, 'System32', 'taskkill.exe');

  return new Promise((resolve) => {
    try {
      execFile(
        taskkillPath,
        ['/PID', String(processId), '/T', '/F'],
        {
          encoding: 'utf8',
          env: { SystemRoot: systemRoot, WINDIR: systemRoot },
          maxBuffer: 64 * 1024,
          shell: false,
          timeout: taskkillTimeoutMs,
          windowsHide: true,
        },
        (error) => resolve(error === null),
      );
    } catch {
      resolve(false);
    }
  });
}

function getEnvironmentVariable(name: string): string | undefined {
  const normalizedName = name.toUpperCase();
  for (const [candidate, value] of Object.entries(process.env)) {
    if (candidate.toUpperCase() === normalizedName) {
      return value;
    }
  }
  return undefined;
}

function getErrorCode(error: unknown): string | number | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' || typeof error.code === 'number' ? error.code : undefined;
}
