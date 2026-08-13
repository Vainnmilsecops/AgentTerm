import { describe, expect, it, vi } from 'vitest';

import { createApplicationSettings } from '@agentterm/domain';

import {
  ApplicationSettingsConflictError,
  ApplicationSettingsValidationError,
  ConfiguredAgentCatalog,
  loadApplicationSettings,
  updateApplicationSettings,
  type AgentAdapter,
  type AgentAvailability,
  type AgentConfigurationInspector,
  type AgentIdentity,
  type AgentLaunchCommand,
  type AgentLaunchRequest,
  type ApplicationSettingsRepository,
} from './index';

class StubAdapter implements AgentAdapter {
  public constructor(
    public readonly identity: AgentIdentity,
    private readonly availability: AgentAvailability,
  ) {}

  public inspect(): Promise<AgentAvailability> {
    return Promise.resolve(this.availability);
  }

  public buildLaunchCommand(request: AgentLaunchRequest): Promise<AgentLaunchCommand> {
    return Promise.resolve({
      arguments: [],
      environment: request.environment,
      executablePath:
        this.availability.kind === 'available' ? this.availability.executablePath : '',
      workingDirectory: request.workingDirectory,
    });
  }
}

class MemorySettingsRepository implements ApplicationSettingsRepository {
  public updateCalls = 0;

  public constructor(public value = createApplicationSettings()) {}

  public get() {
    return Promise.resolve(this.value);
  }

  public update(next: typeof this.value, expectedRevision: number) {
    if (this.value.revision !== expectedRevision) {
      throw new ApplicationSettingsConflictError();
    }
    this.updateCalls += 1;
    this.value = next;
    return Promise.resolve();
  }
}

function adapter(id: string, kind: 'available' | 'unavailable' = 'available'): StubAdapter {
  return new StubAdapter(
    { displayName: id[0]!.toUpperCase() + id.slice(1), id },
    kind === 'available'
      ? { capabilities: [], executablePath: `C:\\detected\\${id}.exe`, kind }
      : { kind, reason: 'EXECUTABLE_NOT_FOUND' },
  );
}

describe('Application Settings use cases', () => {
  it('loads settings with safe detected agent metadata', async () => {
    const settings = new MemorySettingsRepository();
    const catalog = new ConfiguredAgentCatalog([
      adapter('codex'),
      adapter('gemini', 'unavailable'),
    ]);
    const inspector: AgentConfigurationInspector = {
      inspect: vi.fn(async ({ agentId, configuredExecutablePath }): Promise<AgentAvailability> =>
        agentId === 'codex'
          ? {
              capabilities: ['SESSION_RESUME'],
              executablePath: configuredExecutablePath ?? 'C:\\detected\\codex.exe',
              kind: 'available',
              version: { major: 1, minor: 2, patch: 3, raw: 'codex 1.2.3' },
            }
          : { kind: 'unavailable', reason: 'EXECUTABLE_NOT_FOUND' },
      ),
    };

    const view = await loadApplicationSettings({ catalog, inspector, settings });

    expect(view.settings).toEqual(createApplicationSettings());
    expect(view.agents).toEqual([
      {
        capabilities: ['SESSION_RESUME'],
        configuredExecutablePath: undefined,
        detectedExecutablePath: 'C:\\detected\\codex.exe',
        displayName: 'Codex',
        id: 'codex',
        kind: 'available',
        version: 'codex 1.2.3',
      },
      {
        configuredExecutablePath: undefined,
        displayName: 'Gemini',
        id: 'gemini',
        kind: 'unavailable',
        reason: 'EXECUTABLE_NOT_FOUND',
      },
    ]);
    expect(JSON.stringify(view)).not.toMatch(/environment|arguments|token|credential/i);
  });

  it('validates a custom executable before persisting and advances the revision once', async () => {
    const settings = new MemorySettingsRepository();
    const catalog = new ConfiguredAgentCatalog([adapter('codex'), adapter('claude')]);
    const inspector: AgentConfigurationInspector = {
      inspect: vi.fn(async ({ agentId, configuredExecutablePath }): Promise<AgentAvailability> => ({
        capabilities: agentId === 'claude' ? ['SESSION_RESUME'] : [],
        executablePath: configuredExecutablePath ?? agentId,
        kind: 'available',
      })),
    };

    const result = await updateApplicationSettings(
      {
        agentExecutables: [{ agentId: 'claude', executablePath: 'C:\\Tools\\claude.exe' }],
        defaultAgentId: 'claude',
        expectedRevision: 0,
        terminalFontSize: 16,
      },
      { catalog, inspector, settings },
    );

    expect(settings.updateCalls).toBe(1);
    expect(settings.value).toEqual(
      createApplicationSettings({
        agentExecutables: [{ agentId: 'claude', executablePath: 'C:\\Tools\\claude.exe' }],
        defaultAgentId: 'claude',
        revision: 1,
        terminalFontSize: 16,
      }),
    );
    expect(result.settings).toBe(settings.value);
  });

  it('rejects unknown agents and unavailable custom executables without persisting', async () => {
    const settings = new MemorySettingsRepository();
    const catalog = new ConfiguredAgentCatalog([adapter('codex')]);
    const inspector: AgentConfigurationInspector = {
      inspect: vi.fn(async (): Promise<AgentAvailability> => ({
        kind: 'unavailable',
        reason: 'EXECUTABLE_NOT_FOUND',
      })),
    };

    await expect(
      updateApplicationSettings(
        {
          agentExecutables: [],
          defaultAgentId: 'unknown',
          expectedRevision: 0,
          terminalFontSize: 14,
        },
        { catalog, inspector, settings },
      ),
    ).rejects.toEqual(expect.objectContaining({ reason: 'AGENT_NOT_CONFIGURED' }));

    await expect(
      updateApplicationSettings(
        {
          agentExecutables: [{ agentId: 'codex', executablePath: 'C:\\secret\\missing.exe' }],
          defaultAgentId: 'codex',
          expectedRevision: 0,
          terminalFontSize: 14,
        },
        { catalog, inspector, settings },
      ),
    ).rejects.toEqual(expect.objectContaining({ reason: 'EXECUTABLE_NOT_AVAILABLE' }));
    expect(settings.updateCalls).toBe(0);

    try {
      await updateApplicationSettings(
        {
          agentExecutables: [{ agentId: 'codex', executablePath: 'C:\\secret\\missing.exe' }],
          defaultAgentId: 'codex',
          expectedRevision: 0,
          terminalFontSize: 14,
        },
        { catalog, inspector, settings },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationSettingsValidationError);
      expect(String(error)).not.toContain('C:\\secret');
    }
  });

  it('allows a registered but currently offline default while keeping launch availability explicit', async () => {
    const settings = new MemorySettingsRepository();
    const catalog = new ConfiguredAgentCatalog([
      adapter('codex'),
      adapter('gemini', 'unavailable'),
    ]);
    const inspector: AgentConfigurationInspector = {
      inspect: vi.fn(async ({ agentId }): Promise<AgentAvailability> =>
        agentId === 'gemini'
          ? { kind: 'unavailable', reason: 'EXECUTABLE_NOT_FOUND' }
          : { capabilities: [], executablePath: 'codex', kind: 'available' },
      ),
    };

    const result = await updateApplicationSettings(
      {
        agentExecutables: [],
        defaultAgentId: 'gemini',
        expectedRevision: 0,
        terminalFontSize: 16,
      },
      { catalog, inspector, settings },
    );

    expect(settings.updateCalls).toBe(1);
    expect(result.settings.defaultAgentId).toBe('gemini');
    expect(result.agents).toContainEqual({
      configuredExecutablePath: undefined,
      displayName: 'Gemini',
      id: 'gemini',
      kind: 'unavailable',
      reason: 'EXECUTABLE_NOT_FOUND',
    });
  });

  it('rejects stale updates with optimistic concurrency', async () => {
    const settings = new MemorySettingsRepository(
      createApplicationSettings({ revision: 2, terminalFontSize: 15 }),
    );
    const catalog = new ConfiguredAgentCatalog([adapter('codex')]);
    const inspector: AgentConfigurationInspector = {
      inspect: vi.fn(async (): Promise<AgentAvailability> => ({
        capabilities: [],
        executablePath: 'codex',
        kind: 'available',
      })),
    };

    await expect(
      updateApplicationSettings(
        {
          agentExecutables: [],
          defaultAgentId: 'codex',
          expectedRevision: 1,
          terminalFontSize: 14,
        },
        { catalog, inspector, settings },
      ),
    ).rejects.toBeInstanceOf(ApplicationSettingsConflictError);
    expect(settings.updateCalls).toBe(0);
  });
});
