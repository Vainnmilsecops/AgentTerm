import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST_FAILURE_SIGNAL = -1;
const HOST_OPERATION_TIMEOUT_MS = 5_000;
const HOST_STARTUP_TIMEOUT_MS = 7_500;

export interface HostedPtyExitEvent {
  readonly exitCode?: number;
  readonly signal?: number;
}

export interface HostedPtyLaunch {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executablePath: string;
  readonly initialColumns: number;
  readonly initialRows: number;
  readonly workingDirectory: string;
}

export interface HostedPtyProcess {
  readonly pid: number;
  kill(): Promise<void>;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: HostedPtyExitEvent) => void): { dispose(): void };
  resize(columns: number, rows: number): Promise<void>;
  write(input: string): Promise<void>;
}

type HostCommandOperation = 'resize' | 'terminate' | 'write';

interface PendingRequest {
  readonly operation: HostCommandOperation;
  readonly reject: () => void;
  readonly resolve: () => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

type ParentToHostMessage =
  | { readonly launch: HostedPtyLaunch; readonly type: 'launch' }
  | {
      readonly input: string;
      readonly operation: 'write';
      readonly requestId: number;
      readonly type: 'request';
    }
  | {
      readonly columns: number;
      readonly operation: 'resize';
      readonly requestId: number;
      readonly rows: number;
      readonly type: 'request';
    }
  | {
      readonly operation: 'terminate';
      readonly requestId: number;
      readonly type: 'request';
    };

type HostToParentMessage =
  | { readonly data: string; readonly type: 'data' }
  | { readonly exitCode?: number; readonly signal?: number; readonly type: 'terminal-exit' }
  | { readonly pid: number; readonly type: 'ready' }
  | { readonly ok: boolean; readonly requestId: number; readonly type: 'response' };

export function spawnWindowsConPtyHost(launch: HostedPtyLaunch): HostedPtyProcess {
  const hostModulePath = fileURLToPath(new URL('./windows-conpty-host.cjs', import.meta.url));
  const child = spawn(process.execPath, [hostModulePath], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: createHostEnvironment(),
    serialization: 'json',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });

  return new WindowsConPtyHostProcess(child, launch);
}

class WindowsConPtyHostProcess implements HostedPtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private finalExit: HostedPtyExitEvent | undefined;
  private readonly exitListeners = new Set<(event: HostedPtyExitEvent) => void>();
  private finalized = false;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private pendingTerminalExit: HostedPtyExitEvent | undefined;
  private readonly startupTimeout: ReturnType<typeof setTimeout>;
  private targetPid = 0;

  public constructor(
    private readonly child: ChildProcess,
    launch: HostedPtyLaunch,
  ) {
    child.on('message', (message) => this.receiveMessage(message));
    child.once('error', () => this.recordHostFailure());
    child.once('close', () => this.finalize());
    this.startupTimeout = setTimeout(() => this.recordHostFailure(), HOST_STARTUP_TIMEOUT_MS);
    this.send({ launch, type: 'launch' });
  }

  public get pid(): number {
    return this.targetPid;
  }

  public onData(listener: (data: string) => void): { dispose(): void } {
    if (!this.finalized) {
      this.dataListeners.add(listener);
    }
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  public onExit(listener: (event: HostedPtyExitEvent) => void): { dispose(): void } {
    if (this.finalExit !== undefined) {
      listener(this.finalExit);
    } else {
      this.exitListeners.add(listener);
    }
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  public write(input: string): Promise<void> {
    return this.request('write', (requestId) => ({
      input,
      operation: 'write',
      requestId,
      type: 'request',
    }));
  }

  public resize(columns: number, rows: number): Promise<void> {
    return this.request('resize', (requestId) => ({
      columns,
      operation: 'resize',
      requestId,
      rows,
      type: 'request',
    }));
  }

  public kill(): Promise<void> {
    if (this.finalized) {
      return Promise.resolve();
    }
    return this.request('terminate', (requestId) => ({
      operation: 'terminate',
      requestId,
      type: 'request',
    }));
  }

  private request(
    operation: HostCommandOperation,
    createMessage: (requestId: number) => ParentToHostMessage,
  ): Promise<void> {
    if (this.finalized || !this.child.connected) {
      return Promise.reject(new Error('ConPTY host is not running.'));
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => this.recordHostFailure(), HOST_OPERATION_TIMEOUT_MS);
      this.pendingRequests.set(requestId, {
        operation,
        reject: () => reject(new Error('ConPTY host operation failed.')),
        resolve,
        timeout,
      });
      this.send(createMessage(requestId), requestId);
    });
  }

  private send(message: ParentToHostMessage, requestId?: number): void {
    if (!this.child.connected) {
      if (requestId !== undefined) {
        this.rejectRequest(requestId);
      } else {
        this.recordHostFailure();
      }
      return;
    }

    try {
      this.child.send(message, (error) => {
        if (error) {
          if (requestId !== undefined) {
            this.rejectRequest(requestId);
          }
          this.recordHostFailure();
        }
      });
    } catch {
      if (requestId !== undefined) {
        this.rejectRequest(requestId);
      }
      this.recordHostFailure();
    }
  }

  private receiveMessage(message: unknown): void {
    if (!isHostMessage(message) || this.finalized) {
      this.recordHostFailure();
      return;
    }

    switch (message.type) {
      case 'ready':
        clearTimeout(this.startupTimeout);
        this.targetPid = message.pid;
        return;
      case 'data':
        for (const listener of this.dataListeners) {
          listener(message.data);
        }
        return;
      case 'response': {
        const pending = this.pendingRequests.get(message.requestId);
        if (pending === undefined) {
          this.recordHostFailure();
          return;
        }
        this.pendingRequests.delete(message.requestId);
        clearTimeout(pending.timeout);
        if (message.ok) {
          pending.resolve();
        } else {
          pending.reject();
        }
        return;
      }
      case 'terminal-exit':
        clearTimeout(this.startupTimeout);
        this.pendingTerminalExit = {
          ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
          ...(message.signal === undefined ? {} : { signal: message.signal }),
        };
    }
  }

  private rejectRequest(requestId: number): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending !== undefined) {
      this.pendingRequests.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject();
    }
  }

  private recordHostFailure(): void {
    this.pendingTerminalExit ??= { exitCode: -1, signal: HOST_FAILURE_SIGNAL };
    if (!this.child.killed) {
      this.child.kill();
    }
  }

  private finalize(): void {
    if (this.finalized) {
      return;
    }

    this.finalized = true;
    clearTimeout(this.startupTimeout);
    this.finalExit = this.pendingTerminalExit ?? {
      exitCode: -1,
      signal: HOST_FAILURE_SIGNAL,
    };
    for (const listener of this.exitListeners) {
      listener(this.finalExit);
    }
    this.exitListeners.clear();
    this.dataListeners.clear();

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject();
    }
    this.pendingRequests.clear();
  }
}

function isHostMessage(message: unknown): message is HostToParentMessage {
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    return false;
  }

  switch (message.type) {
    case 'ready':
      return 'pid' in message && Number.isSafeInteger(message.pid) && Number(message.pid) > 0;
    case 'data':
      return 'data' in message && typeof message.data === 'string';
    case 'response':
      return (
        'requestId' in message &&
        Number.isSafeInteger(message.requestId) &&
        'ok' in message &&
        typeof message.ok === 'boolean'
      );
    case 'terminal-exit':
      return (
        (!('exitCode' in message) ||
          message.exitCode === undefined ||
          typeof message.exitCode === 'number') &&
        (!('signal' in message) ||
          message.signal === undefined ||
          typeof message.signal === 'number')
      );
    default:
      return false;
  }
}

function createHostEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    AGENTTERM_PTY_HOST: '1',
    ELECTRON_RUN_AS_NODE: '1',
  };
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'] as const) {
    const value = process.env[name];
    if (value !== undefined && !value.includes('\0')) {
      environment[name] = value;
    }
  }
  return environment;
}
