import { execFile } from 'node:child_process';
import { constants, realpath } from 'node:fs';
import { access, opendir, readFile, stat } from 'node:fs/promises';
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from 'node:path';

import { AgentAdapterError } from '@agentterm/application';
import type { AgentLaunchRequest, AgentVersion } from '@agentterm/application';

const PROBE_MAX_BUFFER = 64 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const PACKAGE_MANIFEST_MAX_BYTES = 64 * 1024;
const probeEnvironmentAllowlist = new Set([
  'COMSPEC',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'WINDIR',
]);

export type AgentCliResolutionFailure = 'INSPECTION_FAILED' | 'NOT_FOUND';

export class AgentCliResolutionError extends Error {
  public constructor(public readonly reason: AgentCliResolutionFailure) {
    super(reason);
    this.name = 'AgentCliResolutionError';
  }
}

export interface AgentCliPackagePolicy {
  readonly binName: string;
  readonly binPath: string;
  readonly packageName: string;
  readonly packagePath: readonly string[];
  readonly runtime: 'native' | 'node';
}

export interface ResolvedAgentCliInvocation {
  readonly executablePath: string;
  readonly identityPath: string;
  readonly prefixArguments: readonly string[];
  readonly usesNodeRuntime: boolean;
}

export interface AgentCliProbeResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface ValidatedAgentLaunchRequest {
  readonly environment: Readonly<Record<string, string>>;
  readonly resumeSessionId?: string;
  readonly workingDirectory: string;
}

export function validateResumeSessionId(value: string): string {
  // Defensive: any opaque provider session id passed to the adapter must match a
  // narrow alphanumeric shape. Provider IDs are stable opaque tokens; they never
  // contain whitespace, shell metacharacters, or path separators.
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{4,128}$/u.test(value)) {
    throw new AgentAdapterError('INVALID_LAUNCH_REQUEST');
  }
  return value;
}

export async function resolveAgentCliInvocation(
  configuredExecutable: string,
  policy: AgentCliPackagePolicy,
): Promise<ResolvedAgentCliInvocation> {
  if (
    typeof configuredExecutable !== 'string' ||
    configuredExecutable.trim().length === 0 ||
    configuredExecutable.includes('\0')
  ) {
    throw new AgentCliResolutionError('INSPECTION_FAILED');
  }

  if (isAbsolute(configuredExecutable)) {
    return inspectAgentCliEntrypoint(configuredExecutable, policy);
  }

  if (basename(configuredExecutable) !== configuredExecutable) {
    throw new AgentCliResolutionError('INSPECTION_FAILED');
  }

  const pathValue = getEnvironmentVariable('PATH');
  if (pathValue === undefined) {
    throw new AgentCliResolutionError('NOT_FOUND');
  }

  let sawInspectionFailure = false;
  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = removeSurroundingQuotes(rawDirectory);
    if (directory.length === 0 || !isAbsolute(directory)) {
      continue;
    }

    for (const executableName of createExecutableNames(configuredExecutable)) {
      try {
        return await inspectAgentCliEntrypoint(join(directory, executableName), policy);
      } catch (error) {
        if (error instanceof AgentCliResolutionError) {
          sawInspectionFailure ||= error.reason === 'INSPECTION_FAILED';
        } else {
          throw error;
        }
      }
    }
  }

  throw new AgentCliResolutionError(sawInspectionFailure ? 'INSPECTION_FAILED' : 'NOT_FOUND');
}

export async function resolveAgentLaunchInvocation(
  configuredExecutable: string,
  policy: AgentCliPackagePolicy,
): Promise<ResolvedAgentCliInvocation> {
  try {
    return await resolveAgentCliInvocation(configuredExecutable, policy);
  } catch (error) {
    throw new AgentAdapterError(
      error instanceof AgentCliResolutionError && error.reason === 'NOT_FOUND'
        ? 'EXECUTABLE_NOT_FOUND'
        : 'INSPECTION_FAILED',
    );
  }
}

export async function validateAgentLaunchRequest(
  request: AgentLaunchRequest,
  invocation: ResolvedAgentCliInvocation,
): Promise<ValidatedAgentLaunchRequest> {
  try {
    const workingDirectory = await validateWorkingDirectory(request.workingDirectory);
    const environment = validateEnvironment(request.environment);
    if (invocation.usesNodeRuntime && containsNodeInjection(environment)) {
      throw new AgentAdapterError('INVALID_LAUNCH_REQUEST');
    }
    const resumeSessionId =
      request.resumeSessionId === undefined
        ? undefined
        : validateResumeSessionId(request.resumeSessionId);
    return Object.freeze({
      environment,
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      workingDirectory,
    });
  } catch (error) {
    if (error instanceof AgentAdapterError) {
      throw error;
    }
    throw new AgentAdapterError('INVALID_LAUNCH_REQUEST');
  }
}

export function executeAgentCliProbe(
  invocation: ResolvedAgentCliInvocation,
  arguments_: readonly string[],
): Promise<AgentCliProbeResult> {
  return new Promise((resolve, reject) => {
    try {
      execFile(
        invocation.executablePath,
        [...invocation.prefixArguments, ...arguments_],
        {
          cwd: dirname(invocation.identityPath),
          encoding: 'utf8',
          env: createProbeEnvironment(),
          maxBuffer: PROBE_MAX_BUFFER,
          shell: false,
          timeout: PROBE_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error === null) {
            resolve({ exitCode: 0, stdout });
            return;
          }
          const exitCode = getNumericErrorCode(error);
          if (exitCode !== undefined) {
            resolve({ exitCode, stdout });
          } else {
            reject(error);
          }
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}

export function parseAgentVersion(output: string, pattern: RegExp): AgentVersion | undefined {
  const raw = stripTerminalControls(output).trim();
  const match = pattern.exec(raw);
  if (match === null) {
    return undefined;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return [major, minor, patch].every(Number.isSafeInteger)
    ? Object.freeze({ major, minor, patch, raw })
    : undefined;
}

export function advertisesResume(helpOutput: string): boolean {
  const normalized = stripTerminalControls(helpOutput);
  return /(?:^|\n)\s*(?:-r,\s*)?--resume(?:\s|\[|$)/u.test(normalized);
}

function createExecutableNames(configuredExecutable: string): readonly string[] {
  if (process.platform !== 'win32') {
    return [configuredExecutable];
  }
  const extension = extname(configuredExecutable);
  if (extension.length === 0) {
    return [
      `${configuredExecutable}.exe`,
      `${configuredExecutable}.cmd`,
      `${configuredExecutable}.ps1`,
    ];
  }
  return ['.cmd', '.exe', '.ps1'].includes(extension.toLowerCase()) ? [configuredExecutable] : [];
}

async function inspectAgentCliEntrypoint(
  configuredPath: string,
  policy: AgentCliPackagePolicy,
): Promise<ResolvedAgentCliInvocation> {
  const entrypointPath = await inspectExecutable(configuredPath);
  const extension = extname(entrypointPath).toLowerCase();

  if (process.platform === 'win32' && (extension === '.cmd' || extension === '.ps1')) {
    return inspectNpmInstallationFromShim(entrypointPath, policy);
  }

  if (policy.runtime === 'node' && ['.cjs', '.js', '.mjs'].includes(extension)) {
    return inspectNpmNodeEntrypoint(entrypointPath, policy);
  }

  if (process.platform === 'win32' && extension !== '.exe') {
    throw new AgentCliResolutionError('INSPECTION_FAILED');
  }

  return {
    executablePath: entrypointPath,
    identityPath: entrypointPath,
    prefixArguments: Object.freeze([]),
    usesNodeRuntime: false,
  };
}

async function inspectNpmInstallationFromShim(
  shimPath: string,
  policy: AgentCliPackagePolicy,
): Promise<ResolvedAgentCliInvocation> {
  const packageRoot = join(dirname(shimPath), 'node_modules', ...policy.packagePath);
  return inspectOfficialPackage(packageRoot, dirname(shimPath), policy);
}

async function inspectNpmNodeEntrypoint(
  entrypointPath: string,
  policy: AgentCliPackagePolicy,
): Promise<ResolvedAgentCliInvocation> {
  const binSegments = policy.binPath.split('/');
  let packageRoot = entrypointPath;
  for (let index = 0; index < binSegments.length; index += 1) {
    packageRoot = dirname(packageRoot);
  }
  return inspectOfficialPackage(packageRoot, undefined, policy, entrypointPath);
}

async function inspectOfficialPackage(
  unresolvedPackageRoot: string,
  shimDirectory: string | undefined,
  policy: AgentCliPackagePolicy,
  expectedEntrypoint?: string,
): Promise<ResolvedAgentCliInvocation> {
  try {
    const packageRoot = normalize(await resolveNativeRealPath(unresolvedPackageRoot));
    if (!(await stat(packageRoot)).isDirectory()) {
      throw new Error('Invalid agent package directory.');
    }

    const manifestPath = join(packageRoot, 'package.json');
    const manifestMetadata = await stat(manifestPath);
    if (!manifestMetadata.isFile() || manifestMetadata.size > PACKAGE_MANIFEST_MAX_BYTES) {
      throw new Error('Invalid agent package manifest.');
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    if (!isOfficialManifest(manifest, policy)) {
      throw new Error('Unexpected agent package manifest.');
    }

    const identityPath = await inspectExecutable(join(packageRoot, ...policy.binPath.split('/')));
    if (
      !isPathWithin(packageRoot, identityPath) ||
      (expectedEntrypoint !== undefined && identityPath !== expectedEntrypoint)
    ) {
      throw new Error('Agent package entrypoint escapes its package.');
    }

    if (policy.runtime === 'native') {
      return {
        executablePath: identityPath,
        identityPath,
        prefixArguments: Object.freeze([]),
        usesNodeRuntime: false,
      };
    }

    const executablePath = await resolveNodeExecutable(shimDirectory);
    return {
      executablePath,
      identityPath,
      prefixArguments: Object.freeze([identityPath]),
      usesNodeRuntime: true,
    };
  } catch {
    throw new AgentCliResolutionError('INSPECTION_FAILED');
  }
}

function isOfficialManifest(manifest: unknown, policy: AgentCliPackagePolicy): boolean {
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('name' in manifest) ||
    !('bin' in manifest)
  ) {
    return false;
  }
  if (manifest.name !== policy.packageName) {
    return false;
  }
  const bin = manifest.bin;
  return (
    bin === policy.binPath ||
    (typeof bin === 'object' &&
      bin !== null &&
      policy.binName in bin &&
      (bin as Record<string, unknown>)[policy.binName] === policy.binPath)
  );
}

async function resolveNodeExecutable(shimDirectory: string | undefined): Promise<string> {
  if (shimDirectory !== undefined) {
    try {
      return await inspectExecutable(join(shimDirectory, executableName('node')));
    } catch {
      // Continue with absolute PATH entries.
    }
  }
  const pathValue = getEnvironmentVariable('PATH');
  if (pathValue !== undefined) {
    for (const rawDirectory of pathValue.split(delimiter)) {
      const directory = removeSurroundingQuotes(rawDirectory);
      if (directory.length === 0 || !isAbsolute(directory)) {
        continue;
      }
      try {
        return await inspectExecutable(join(directory, executableName('node')));
      } catch {
        // Continue searching.
      }
    }
  }
  throw new AgentCliResolutionError('INSPECTION_FAILED');
}

function executableName(bareName: string): string {
  return process.platform === 'win32' ? `${bareName}.exe` : bareName;
}

async function inspectExecutable(executablePath: string): Promise<string> {
  try {
    const canonicalPath = normalize(await resolveNativeRealPath(executablePath));
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile()) {
      throw new AgentCliResolutionError('NOT_FOUND');
    }
    if (process.platform !== 'win32') {
      await access(canonicalPath, constants.X_OK);
    }
    return canonicalPath;
  } catch (error) {
    if (error instanceof AgentCliResolutionError) {
      throw error;
    }
    throw new AgentCliResolutionError(
      isMissingFileSystemError(error) ? 'NOT_FOUND' : 'INSPECTION_FAILED',
    );
  }
}

async function validateWorkingDirectory(workingDirectory: string): Promise<string> {
  if (
    typeof workingDirectory !== 'string' ||
    workingDirectory.length === 0 ||
    workingDirectory.includes('\0') ||
    !isAbsolute(workingDirectory)
  ) {
    throw new AgentAdapterError('INVALID_LAUNCH_REQUEST');
  }
  try {
    const canonicalPath = normalize(await resolveNativeRealPath(workingDirectory));
    if (!(await stat(canonicalPath)).isDirectory()) {
      throw new AgentAdapterError('INVALID_LAUNCH_REQUEST');
    }
    const directory = await opendir(canonicalPath);
    await directory.close();
    return canonicalPath;
  } catch (error) {
    if (error instanceof AgentAdapterError) {
      throw error;
    }
    throw new AgentAdapterError('INVALID_LAUNCH_REQUEST');
  }
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
    throw new AgentAdapterError('INVALID_LAUNCH_REQUEST');
  }
  const keys = Reflect.ownKeys(environment);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new AgentAdapterError('INVALID_LAUNCH_REQUEST');
  }

  const validated: Record<string, string> = {};
  const normalizedNames = new Set<string>();
  for (const key of keys as string[]) {
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
      throw new AgentAdapterError('INVALID_LAUNCH_REQUEST');
    }
    normalizedNames.add(normalizedName);
    validated[key] = descriptor.value;
  }
  return validated;
}

function containsNodeInjection(environment: Readonly<Record<string, string>>): boolean {
  return Object.keys(environment).some((name) => {
    const normalized = name.toUpperCase();
    return normalized === 'NODE_OPTIONS' || normalized === 'NODE_PATH';
  });
}

function createProbeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (probeEnvironmentAllowlist.has(name.toUpperCase()) && value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function stripTerminalControls(value: string): string {
  return (
    value
      // Probe output may include OSC and CSI sequences emitted by interactive CLIs.
      // eslint-disable-next-line no-control-regex
      .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
  );
}

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(parentPath, candidatePath);
  return (
    relativePath.length > 0 &&
    !isAbsolute(relativePath) &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`)
  );
}

function getEnvironmentVariable(name: string): string | undefined {
  const normalizedName = name.toUpperCase();
  for (const [environmentName, value] of Object.entries(process.env)) {
    if (environmentName.toUpperCase() === normalizedName) {
      return value;
    }
  }
  return undefined;
}

function removeSurroundingQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function resolveNativeRealPath(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    realpath.native(path, (error, resolvedPath) =>
      error === null ? resolve(resolvedPath) : reject(error),
    );
  });
}

function isMissingFileSystemError(error: unknown): boolean {
  return getErrorCode(error) === 'ENOENT' || getErrorCode(error) === 'ENOTDIR';
}

function getNumericErrorCode(error: unknown): number | undefined {
  const code = getErrorCode(error);
  return typeof code === 'number' ? code : undefined;
}

function getErrorCode(error: unknown): string | number | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' || typeof error.code === 'number' ? error.code : undefined;
}
