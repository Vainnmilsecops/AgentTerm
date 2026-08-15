import { describe, expect, it } from 'vitest';

import {
  AgentAdapterError,
  PtyRuntimeError,
  inspectAgent,
  launchAgent,
  type AgentAdapter,
  type AgentAvailability,
  type AgentLaunchCommand,
  type AgentLaunchRequest,
  type AgentVersion,
  type PtyHandle,
  type PtyLaunchSpec,
  type PtyRuntime,
  type PtyRuntimeEvent,
  type PtyRuntimeEventSink,
} from './index';

class RecordingAgentAdapter implements AgentAdapter {
  public readonly identity = Object.freeze({ displayName: 'Codex', id: 'codex' });
  public inspectionCount = 0;
  public readonly launchRequests: AgentLaunchRequest[] = [];

  public constructor(
    private readonly availability: AgentAvailability,
    private readonly launchCommand: AgentLaunchCommand,
    private readonly launchError: Error | undefined = undefined,
  ) {}

  public async inspect(): Promise<AgentAvailability> {
    this.inspectionCount += 1;
    return this.availability;
  }

  public async buildLaunchCommand(request: AgentLaunchRequest): Promise<AgentLaunchCommand> {
    this.launchRequests.push(request);

    if (this.launchError !== undefined) {
      throw this.launchError;
    }

    return this.launchCommand;
  }
}

interface RuntimeOpenCall {
  readonly sink: PtyRuntimeEventSink;
  readonly spec: PtyLaunchSpec;
}

class RecordingPtyRuntime implements PtyRuntime {
  public readonly openCalls: RuntimeOpenCall[] = [];

  public constructor(
    private readonly handle: PtyHandle,
    private readonly events: readonly PtyRuntimeEvent[] = [],
    private readonly openError: Error | undefined = undefined,
  ) {}

  public async open(spec: PtyLaunchSpec, sink: PtyRuntimeEventSink): Promise<PtyHandle> {
    this.openCalls.push({ sink, spec });

    if (this.openError !== undefined) {
      throw this.openError;
    }

    for (const event of this.events) {
      sink(event);
    }

    return this.handle;
  }

  public async reattach(
    ownershipPty: { hostPid: number },
    initialSizePty: { columns: number; rows: number },
    sinkPty: PtyRuntimeEventSink,
  ): Promise<PtyHandle> {
    void ownershipPty;
    void initialSizePty;
    void sinkPty;
    throw new PtyRuntimeError('spawn', 'CONPTY_UNAVAILABLE');
  }
}

const codexVersion: AgentVersion = Object.freeze({
  major: 0,
  minor: 147,
  patch: 0,
  raw: 'codex-cli 0.147.0',
});

const availableCodex = Object.freeze({
  capabilities: Object.freeze(['SESSION_RESUME'] as const),
  executablePath: 'C:\\Program Files\\OpenAI Codex\\codex.exe',
  kind: 'available',
  version: codexVersion,
} satisfies AgentAvailability);

const workingDirectory = 'D:\\AgentTerm Worktrees\\T\u00e1c v\u1ee5 42';
const terminalSize = Object.freeze({ columns: 132, rows: 41 });
const environment = Object.freeze({
  PATH: 'C:\\Windows\\System32',
  SYSTEMROOT: 'C:\\Windows',
});
const launchCommand: AgentLaunchCommand = Object.freeze({
  arguments: Object.freeze(['--cd', workingDirectory]),
  environment,
  executablePath: availableCodex.executablePath,
  workingDirectory,
});
const launchSpec: PtyLaunchSpec = Object.freeze({ ...launchCommand, initialSize: terminalSize });

function createHandle(): PtyHandle {
  return {
    async dispose(): Promise<void> {},
    async resize(): Promise<void> {},
    async terminate(): Promise<void> {},
    async write(): Promise<void> {},
  };
}

describe('inspectAgent', () => {
  it('returns the adapter availability without introducing provider policy', async () => {
    const adapter = new RecordingAgentAdapter(availableCodex, launchCommand);

    const result = await inspectAgent(adapter);

    expect(result).toBe(availableCodex);
    expect(adapter.inspectionCount).toBe(1);
    expect(adapter.launchRequests).toEqual([]);
  });
});

describe('launchAgent', () => {
  it('builds a launch for the supplied Worktree and opens that exact spec in the PTY runtime', async () => {
    const adapter = new RecordingAgentAdapter(availableCodex, launchCommand);
    const handle = createHandle();
    const runtime = new RecordingPtyRuntime(handle);
    const eventSink: PtyRuntimeEventSink = () => undefined;

    const result = await launchAgent(
      { environment, eventSink, initialSize: terminalSize, workingDirectory },
      adapter,
      runtime,
    );

    expect(result).toBe(handle);
    expect(adapter.launchRequests).toEqual([{ environment, workingDirectory }]);
    expect(runtime.openCalls).toEqual([{ sink: eventSink, spec: launchSpec }]);
  });

  it('does not open a PTY when the adapter cannot build a launch command', async () => {
    const adapterError = new AgentAdapterError('EXECUTABLE_NOT_FOUND');
    const adapter = new RecordingAgentAdapter(availableCodex, launchCommand, adapterError);
    const runtime = new RecordingPtyRuntime(createHandle());

    const result = launchAgent(
      {
        eventSink: () => undefined,
        environment,
        initialSize: terminalSize,
        workingDirectory,
      },
      adapter,
      runtime,
    );

    await expect(result).rejects.toBe(adapterError);
    expect(adapterError).toMatchObject({
      name: 'AgentAdapterError',
      reason: 'EXECUTABLE_NOT_FOUND',
    });
    expect(runtime.openCalls).toEqual([]);
  });

  it('preserves a synchronous PTY launch failure for the caller', async () => {
    const adapter = new RecordingAgentAdapter(availableCodex, launchCommand);
    const runtimeError = new PtyRuntimeError('spawn', 'INVALID_EXECUTABLE');
    const runtime = new RecordingPtyRuntime(createHandle(), [], runtimeError);

    const result = launchAgent(
      {
        eventSink: () => undefined,
        environment,
        initialSize: terminalSize,
        workingDirectory,
      },
      adapter,
      runtime,
    );

    await expect(result).rejects.toBe(runtimeError);
  });

  it('forwards runtime events unchanged and leaves Task completion outside the launch use case', async () => {
    const events: readonly PtyRuntimeEvent[] = [
      { kind: 'started', sequence: 1 },
      { data: 'Ready\r\n', kind: 'output', sequence: 2 },
      { exitCode: 0, kind: 'exited', sequence: 3 },
    ];
    const receivedEvents: PtyRuntimeEvent[] = [];
    const handle = createHandle();
    const adapter = new RecordingAgentAdapter(availableCodex, launchCommand);
    const runtime = new RecordingPtyRuntime(handle, events);

    const result = await launchAgent(
      {
        eventSink: (event) => receivedEvents.push(event),
        environment,
        initialSize: terminalSize,
        workingDirectory,
      },
      adapter,
      runtime,
    );

    expect(result).toBe(handle);
    expect(receivedEvents).toEqual(events);
  });
});
