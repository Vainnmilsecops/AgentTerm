import { describe, expect, it } from 'vitest';

import {
  ConfiguredAgentCatalog,
  listAgentSummaries,
  type AgentAdapter,
  type AgentAvailability,
  type AgentIdentity,
  type AgentLaunchCommand,
  type AgentLaunchRequest,
} from './index';

class StubAgentAdapter implements AgentAdapter {
  public readonly identity: AgentIdentity;

  public constructor(
    identity: AgentIdentity,
    private readonly availability: AgentAvailability,
  ) {
    this.identity = Object.freeze({ ...identity });
  }

  public async inspect(): Promise<AgentAvailability> {
    return this.availability;
  }

  public async buildLaunchCommand(request: AgentLaunchRequest): Promise<AgentLaunchCommand> {
    return {
      arguments: [],
      environment: request.environment,
      executablePath: 'C:\\private\\agent.exe',
      workingDirectory: request.workingDirectory,
    };
  }
}

function availableAdapter(id: string, displayName: string): StubAgentAdapter {
  return new StubAgentAdapter(
    { displayName, id },
    {
      capabilities: Object.freeze(['SESSION_RESUME']),
      executablePath: `C:\\private\\${id}.exe`,
      kind: 'available',
      version: { major: 1, minor: 2, patch: 3, raw: `${id} 1.2.3` },
    },
  );
}

describe('ConfiguredAgentCatalog', () => {
  it('selects configured adapters solely by their stable identity', () => {
    const codex = availableAdapter('codex', 'Codex');
    const local = availableAdapter('local-agent', 'Local Agent');
    const catalog = new ConfiguredAgentCatalog([codex, local]);

    expect(catalog.findById('codex')?.identity).toEqual({ displayName: 'Codex', id: 'codex' });
    expect(catalog.findById('local-agent')?.identity).toEqual({
      displayName: 'Local Agent',
      id: 'local-agent',
    });
    expect(catalog.findById('missing')).toBeUndefined();
    expect(catalog.list().map((adapter) => adapter.identity.id)).toEqual(['codex', 'local-agent']);
  });

  it('rejects duplicate and unstable configured identities', () => {
    expect(
      () =>
        new ConfiguredAgentCatalog([
          availableAdapter('codex', 'Codex'),
          availableAdapter('codex', 'Duplicate Codex'),
        ]),
    ).toThrow('Duplicate Agent id: codex.');

    expect(() => new ConfiguredAgentCatalog([availableAdapter('Codex CLI', 'Codex')])).toThrow(
      'Agent id must be a stable identifier.',
    );
    expect(() => new ConfiguredAgentCatalog([availableAdapter('codex', '   ')])).toThrow(
      'Agent display name must not be blank.',
    );
  });

  it('keeps the registered identity stable when an adapter mutates its source descriptor', async () => {
    const identity = { displayName: 'Mutable Agent', id: 'mutable-agent' };
    let releaseInspection = (): void => undefined;
    const inspectionGate = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const adapter: AgentAdapter = {
      identity,
      inspect: async () => {
        await inspectionGate;
        return {
          capabilities: [],
          executablePath: 'C:\\private\\mutable-agent.exe',
          kind: 'available',
        };
      },
      buildLaunchCommand: async (request) => ({
        arguments: [],
        environment: request.environment,
        executablePath: 'C:\\private\\mutable-agent.exe',
        workingDirectory: request.workingDirectory,
      }),
    };
    const catalog = new ConfiguredAgentCatalog([adapter]);
    const summaries = listAgentSummaries(catalog);

    identity.id = 'changed-agent';
    identity.displayName = 'Changed Agent';
    releaseInspection();

    expect(catalog.findById('mutable-agent')?.identity).toEqual({
      displayName: 'Mutable Agent',
      id: 'mutable-agent',
    });
    expect(catalog.findById('changed-agent')).toBeUndefined();
    await expect(summaries).resolves.toEqual([
      {
        capabilities: [],
        displayName: 'Mutable Agent',
        id: 'mutable-agent',
        kind: 'available',
      },
    ]);
  });
});

describe('listAgentSummaries', () => {
  it('exposes identity and capabilities without executable paths or version details', async () => {
    const catalog = new ConfiguredAgentCatalog([
      availableAdapter('codex', 'Codex'),
      new StubAgentAdapter(
        { displayName: 'Offline', id: 'offline-agent' },
        { kind: 'unavailable', reason: 'EXECUTABLE_NOT_FOUND' },
      ),
    ]);

    const summaries = await listAgentSummaries(catalog);

    expect(summaries).toEqual([
      {
        capabilities: ['SESSION_RESUME'],
        displayName: 'Codex',
        id: 'codex',
        kind: 'available',
      },
      {
        displayName: 'Offline',
        id: 'offline-agent',
        kind: 'unavailable',
        reason: 'EXECUTABLE_NOT_FOUND',
      },
    ]);
    expect(JSON.stringify(summaries)).not.toContain('C:\\private');
    expect(JSON.stringify(summaries)).not.toContain('1.2.3');
  });
});
