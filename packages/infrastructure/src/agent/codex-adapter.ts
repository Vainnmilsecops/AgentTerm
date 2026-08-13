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
import type {
  AgentAdapter,
  AgentAvailability,
  AgentLaunchCommand,
  AgentLaunchRequest,
  AgentVersion,
} from '@agentterm/application';

const PROBE_MAX_BUFFER = 64 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const PACKAGE_MANIFEST_MAX_BYTES = 64 * 1024;
const CODEX_IDENTITY = Object.freeze({ displayName: 'Codex', id: 'codex' });
const CODEX_RESUME_CAPABILITIES = Object.freeze(['SESSION_RESUME'] as const);
const NO_CAPABILITIES = Object.freeze([]);
const probeEnvironmentAllowlist = new Set([
  'COMSPEC',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'WINDIR',
]);

type ExecutableResolutionFailure = 'INSPECTION_FAILED' | 'NOT_FOUND';

class ExecutableResolutionError extends Error {
  public constructor(public readonly reason: ExecutableResolutionFailure) {
    super(reason);
    this.name = 'ExecutableResolutionError';
  }
}

interface ProbeResult {
  readonly exitCode: number;
  readonly stdout: string;
}

interface ResolvedCodexInvocation {
  readonly executablePath: string;
  readonly identityPath: string;
  readonly prefixArguments: readonly string[];
}

export class CodexAdapter implements AgentAdapter {
  public readonly identity = CODEX_IDENTITY;

  public constructor(private readonly configuredExecutable = 'codex') {}

  public async inspect(): Promise<AgentAvailability> {
    let invocation: ResolvedCodexInvocation;

    try {
      invocation = await resolveCodexInvocation(this.configuredExecutable);
    } catch (error) {
      return {
        kind: 'unavailable',
        reason:
          error instanceof ExecutableResolutionError && error.reason === 'NOT_FOUND'
            ? 'EXECUTABLE_NOT_FOUND'
            : 'INSPECTION_FAILED',
      };
    }

    try {
      const versionProbe = await executeProbe(invocation, ['--version']);
      if (versionProbe.exitCode !== 0) {
        return { kind: 'unavailable', reason: 'INSPECTION_FAILED' };
      }
      const version = parseCodexVersion(versionProbe.stdout);

      const resumeProbe = await executeProbe(invocation, ['resume', '--help']).catch(
        () => undefined,
      );

      return {
        capabilities: resumeProbe?.exitCode === 0 ? CODEX_RESUME_CAPABILITIES : NO_CAPABILITIES,
        executablePath: invocation.identityPath,
        kind: 'available',
        ...(version === undefined ? {} : { version }),
      };
    } catch {
      return { kind: 'unavailable', reason: 'INSPECTION_FAILED' };
    }
  }

  public async buildLaunchCommand(request: AgentLaunchRequest): Promise<AgentLaunchCommand> {
    const invocation = await resolveLaunchInvocation(this.configuredExecutable);
    let workingDirectory: string;
    let environment: Record<string, string>;

    try {
      workingDirectory = await validateWorkingDirectory(request.workingDirectory);
      environment = validateEnvironment(request.environment);
      if (invocation.prefixArguments.length > 0 && containsNodeInjection(environment)) {
        throw new AgentAdapterError('INVALID_LAUNCH_REQUEST');
      }
    } catch (error) {
      if (error instanceof AgentAdapterError) {
        throw error;
      }
      throw new AgentAdapterError('INVALID_LAUNCH_REQUEST');
    }

    return {
      arguments: [...invocation.prefixArguments, '--cd', workingDirectory],
      environment,
      executablePath: invocation.executablePath,
      workingDirectory,
    };
  }
}

async function resolveLaunchInvocation(
  configuredExecutable: string,
): Promise<ResolvedCodexInvocation> {
  try {
    return await resolveCodexInvocation(configuredExecutable);
  } catch (error) {
    throw new AgentAdapterError(
      error instanceof ExecutableResolutionError && error.reason === 'NOT_FOUND'
        ? 'EXECUTABLE_NOT_FOUND'
        : 'INSPECTION_FAILED',
    );
  }
}

async function resolveCodexInvocation(
  configuredExecutable: string,
): Promise<ResolvedCodexInvocation> {
  if (
    typeof configuredExecutable !== 'string' ||
    configuredExecutable.trim().length === 0 ||
    configuredExecutable.includes('\0')
  ) {
    throw new ExecutableResolutionError('INSPECTION_FAILED');
  }

  if (isAbsolute(configuredExecutable)) {
    return inspectCodexEntrypoint(configuredExecutable);
  }

  if (basename(configuredExecutable) !== configuredExecutable) {
    throw new ExecutableResolutionError('INSPECTION_FAILED');
  }

  const pathValue = getEnvironmentVariable('PATH');
  if (pathValue === undefined) {
    throw new ExecutableResolutionError('NOT_FOUND');
  }

  let sawInspectionFailure = false;

  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = removeSurroundingQuotes(rawDirectory);
    if (directory.length === 0 || !isAbsolute(directory)) {
      continue;
    }

    for (const executableName of createExecutableNames(configuredExecutable)) {
      try {
        return await inspectCodexEntrypoint(join(directory, executableName));
      } catch (error) {
        if (error instanceof ExecutableResolutionError) {
          sawInspectionFailure ||= error.reason === 'INSPECTION_FAILED';
        } else {
          throw error;
        }
      }
    }
  }

  throw new ExecutableResolutionError(sawInspectionFailure ? 'INSPECTION_FAILED' : 'NOT_FOUND');
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

async function inspectCodexEntrypoint(configuredPath: string): Promise<ResolvedCodexInvocation> {
  const entrypointPath = await inspectExecutable(configuredPath);
  const extension = extname(entrypointPath).toLowerCase();

  if (process.platform !== 'win32' || extension === '.exe') {
    return {
      executablePath: entrypointPath,
      identityPath: entrypointPath,
      prefixArguments: [],
    };
  }

  if (extension === '.cmd' || extension === '.ps1') {
    return inspectNpmCodexInstallation(entrypointPath);
  }

  throw new ExecutableResolutionError('INSPECTION_FAILED');
}

async function inspectNpmCodexInstallation(shimPath: string): Promise<ResolvedCodexInvocation> {
  try {
    const packageRoot = normalize(
      await resolveNativeRealPath(join(dirname(shimPath), 'node_modules', '@openai', 'codex')),
    );
    const packageMetadata = await stat(packageRoot);
    if (!packageMetadata.isDirectory()) {
      throw new Error('Invalid Codex npm package directory.');
    }

    const manifestPath = join(packageRoot, 'package.json');
    const manifestMetadata = await stat(manifestPath);
    if (!manifestMetadata.isFile() || manifestMetadata.size > PACKAGE_MANIFEST_MAX_BYTES) {
      throw new Error('Invalid Codex npm package manifest.');
    }

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    if (!isOfficialCodexManifest(manifest)) {
      throw new Error('Unexpected Codex npm package manifest.');
    }

    const identityPath = await inspectExecutable(join(packageRoot, 'bin', 'codex.js'));
    if (!isPathWithin(packageRoot, identityPath)) {
      throw new Error('Codex npm entrypoint escapes its package.');
    }

    const executablePath = await resolveNodeExecutable(dirname(shimPath));
    return {
      executablePath,
      identityPath,
      prefixArguments: [identityPath],
    };
  } catch {
    throw new ExecutableResolutionError('INSPECTION_FAILED');
  }
}

function isOfficialCodexManifest(manifest: unknown): boolean {
  if (typeof manifest !== 'object' || manifest === null || !('name' in manifest)) {
    return false;
  }

  if (manifest.name !== '@openai/codex' || !('bin' in manifest)) {
    return false;
  }

  const bin = manifest.bin;
  return (
    bin === 'bin/codex.js' ||
    (typeof bin === 'object' && bin !== null && 'codex' in bin && bin.codex === 'bin/codex.js')
  );
}

async function resolveNodeExecutable(shimDirectory: string): Promise<string> {
  try {
    return await inspectExecutable(join(shimDirectory, 'node.exe'));
  } catch {
    const pathValue = getEnvironmentVariable('PATH');
    if (pathValue !== undefined) {
      for (const rawDirectory of pathValue.split(delimiter)) {
        const directory = removeSurroundingQuotes(rawDirectory);
        if (directory.length === 0 || !isAbsolute(directory)) {
          continue;
        }

        try {
          return await inspectExecutable(join(directory, 'node.exe'));
        } catch {
          // Continue searching the remaining absolute PATH entries.
        }
      }
    }
  }

  throw new ExecutableResolutionError('INSPECTION_FAILED');
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

async function inspectExecutable(executablePath: string): Promise<string> {
  try {
    const canonicalPath = normalize(await resolveNativeRealPath(executablePath));
    const metadata = await stat(canonicalPath);

    if (!metadata.isFile()) {
      throw new ExecutableResolutionError('NOT_FOUND');
    }

    if (process.platform !== 'win32') {
      await access(canonicalPath, constants.X_OK);
    }

    return canonicalPath;
  } catch (error) {
    if (error instanceof ExecutableResolutionError) {
      throw error;
    }

    throw new ExecutableResolutionError(
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
    const metadata = await stat(canonicalPath);
    if (!metadata.isDirectory()) {
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
    const normalizedName = name.toUpperCase();
    return normalizedName === 'NODE_OPTIONS' || normalizedName === 'NODE_PATH';
  });
}

function parseCodexVersion(output: string): AgentVersion | undefined {
  const raw = stripTerminalControls(output).trim();
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(raw);
  if (match === null) {
    return undefined;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return undefined;
  }

  return { major, minor, patch, raw };
}

function stripTerminalControls(value: string): string {
  return (
    value
      // The probe output can contain OSC and CSI control sequences emitted by the CLI.
      // eslint-disable-next-line no-control-regex
      .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
  );
}

function executeProbe(
  invocation: ResolvedCodexInvocation,
  arguments_: readonly string[],
): Promise<ProbeResult> {
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

function createProbeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (probeEnvironmentAllowlist.has(name.toUpperCase()) && value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
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
    realpath.native(path, (error, resolvedPath) => {
      if (error === null) {
        resolve(resolvedPath);
      } else {
        reject(error);
      }
    });
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
