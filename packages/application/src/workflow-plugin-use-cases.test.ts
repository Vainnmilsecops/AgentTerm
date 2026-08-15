import { describe, expect, it, vi } from "vitest";

import {
  createWorkflowPlugin,
  WorkflowPluginPhaseKind,
  type ApplicationSettings,
  type WorkflowPlugin,
} from "@agentterm/domain";

import {
  bindPhaseAgent,
  selectPhaseArtifactContract,
} from "./workflow-plugin-use-cases";
import { installWorkflowPluginForTask } from "./workflow-plugin-loader";
import type {
  AgentCatalog,
  AgentIdentity,
  WorkflowPluginBindingRecord,
  WorkflowPluginConfigurator,
  WorkflowPluginConfiguratorResult,
  WorkflowPluginConfiguration,
} from "./ports";

function settings(
  overrides: Partial<ApplicationSettings> = {},
): ApplicationSettings {
  return {
    agentExecutables: [],
    defaultAgentId: "codex",
    revision: 1,
    schemaVersion: 1,
    terminalFontSize: 14,
    ...overrides,
  };
}

function pluginWithPhases(): WorkflowPlugin {
  return createWorkflowPlugin({
    description: "four-phase workflow",
    id: "agtx",
    name: "agtx",
    phases: [
      {
        artifactHeading: "# Research",
        artifactKind: WorkflowPluginPhaseKind.research,
        id: "research",
        requiredHeadings: ["# Research", "## Findings"],
      },
      {
        artifactHeading: "# Plan",
        artifactKind: WorkflowPluginPhaseKind.planning,
        id: "planning",
        requiredHeadings: ["# Plan", "## Approach"],
      },
      {
        artifactHeading: "# Execution Summary",
        artifactKind: WorkflowPluginPhaseKind.running,
        id: "running",
        requiredHeadings: ["# Execution Summary"],
      },
      {
        artifactHeading: "# Review",
        artifactKind: WorkflowPluginPhaseKind.review,
        id: "review",
        requiredHeadings: ["# Review"],
      },
    ],
  });
}

function identity(id: string, displayName?: string): AgentIdentity {
  return { displayName: displayName ?? id, id };
}

function catalogWith(agents: readonly AgentIdentity[]): AgentCatalog {
  return {
    findById: (id) => {
      const agent = agents.find((candidate) => candidate.id === id);
      return agent
        ? {
            buildLaunchCommand: vi.fn(),
            identity: agent,
            inspect: vi.fn(),
          }
        : undefined;
    },
    list: () =>
      agents.map((agent) => ({
        buildLaunchCommand: vi.fn(),
        identity: agent,
        inspect: vi.fn(),
      })),
  };
}

describe("bindPhaseAgent", () => {
  it("prefers an allowed catalog agent in declaration order", () => {
    const plugin = pluginWithPhases();
    const result = bindPhaseAgent(
      {
        phaseId: "planning",
        plugin,
        settings: settings({ defaultAgentId: "gemini" }),
      },
      catalogWith([identity("gemini"), identity("codex"), identity("claude")]),
    );
    expect(result.id).toBe("gemini");
  });

  it("falls back to Settings defaultAgentId when the phase allows any catalog agent", () => {
    const plugin = pluginWithPhases();
    // research allowed list is ['gemini'] in M1
    const result = bindPhaseAgent(
      {
        phaseId: "research",
        plugin,
        settings: settings({ defaultAgentId: "gemini" }),
      },
      catalogWith([identity("codex"), identity("gemini")]),
    );
    expect(result.id).toBe("gemini");
  });

  it("rejects when no catalog agent satisfies the phase allow list", () => {
    const plugin = pluginWithPhases();
    expect(() =>
      bindPhaseAgent(
        {
          phaseId: "running",
          plugin,
          settings: settings({ defaultAgentId: "claude" }),
        },
        // running allows ['claude', 'codex']; only 'gemini' is registered.
        catalogWith([identity("gemini")]),
      ),
    ).toThrow(/configured for phase/i);
  });

  it("rejects unknown phase identifiers", () => {
    const plugin = pluginWithPhases();
    expect(() =>
      bindPhaseAgent(
        {
          phaseId: "non-existent",
          plugin,
          settings: settings(),
        },
        catalogWith([identity("codex")]),
      ),
    ).toThrow(/does not declare phase/i);
  });
});

describe("selectPhaseArtifactContract", () => {
  it("returns the canonical name and heading for the requested phase", () => {
    const plugin = pluginWithPhases();
    const projection = selectPhaseArtifactContract({
      phaseId: "planning",
      plugin,
    });
    expect(projection).toEqual({
      canonicalName: "planning/plan.md",
      heading: "# Plan",
      phase: "PLANNING",
    });
    expect(Object.isFrozen(projection)).toBe(true);
  });

  it("rejects when the phase is missing", () => {
    const plugin = pluginWithPhases();
    expect(() =>
      selectPhaseArtifactContract({ phaseId: "unknown", plugin }),
    ).toThrow(/does not declare phase/i);
  });
});

interface FakeBindingRepository {
  readonly records: Map<string, WorkflowPluginBindingRecord>;
  findByTaskId(
    taskId: string,
  ): Promise<WorkflowPluginBindingRecord | undefined>;
  upsert(
    record: WorkflowPluginBindingRecord,
    expectedRevision: number,
  ): Promise<void>;
  removeByTaskId(taskId: string): Promise<boolean>;
}

function fakeBindingRepository(): FakeBindingRepository {
  const records = new Map<string, WorkflowPluginBindingRecord>();
  return {
    records,
    async findByTaskId(taskId) {
      return records.get(taskId);
    },
    async upsert(record, expectedRevision) {
      const existing = records.get(record.taskId);
      if (expectedRevision === 0) {
        if (existing) {
          throw new Error("conflict");
        }
      } else if (!existing || existing.revision !== expectedRevision) {
        throw new Error("conflict");
      }
      records.set(record.taskId, record);
    },
    async removeByTaskId(taskId) {
      return records.delete(taskId);
    },
  };
}

function configuratorWith(plugin: WorkflowPlugin): WorkflowPluginConfigurator {
  const configuration: WorkflowPluginConfiguration = {
    path: "C:/plugins/agtx.json",
    plugin,
    revision: "r1",
  };
  return {
    async load(): Promise<
      WorkflowPluginConfiguratorResult<WorkflowPluginConfiguration>
    > {
      return { failure: undefined, value: configuration };
    },
  };
}

function failingConfigurator(
  reason: "INVALID_FORMAT" | "PATH_NOT_TRUSTED" | "PATH_UNREADABLE",
): WorkflowPluginConfigurator {
  return {
    async load(): Promise<
      WorkflowPluginConfiguratorResult<WorkflowPluginConfiguration>
    > {
      return { failure: reason, value: undefined };
    },
  };
}

describe("installWorkflowPluginForTask", () => {
  it("persists a first-time binding when no prior record exists", async () => {
    const repository = fakeBindingRepository();
    const plugin = pluginWithPhases();
    const result = await installWorkflowPluginForTask(
      {
        expectedRevision: 0,
        path: "C:/plugins/agtx.json",
        taskId: "task-1",
      },
      {
        bindingRepository: repository,
        configurator: configuratorWith(plugin),
        now: () => 1_700_000_000_000,
      },
    );
    expect(result.binding.pluginId).toBe("agtx");
    expect(result.binding.taskId).toBe("task-1");
    expect(result.binding.revision).toBe(1);
    expect(result.binding.activePhaseId).toBe("research");
    expect(result.binding.installedAt).toBe(1_700_000_000_000);
  });

  it("rejects installation when the expected revision does not match", async () => {
    const repository = fakeBindingRepository();
    const plugin = pluginWithPhases();
    await installWorkflowPluginForTask(
      {
        expectedRevision: 0,
        path: "C:/plugins/agtx.json",
        taskId: "task-1",
      },
      {
        bindingRepository: repository,
        configurator: configuratorWith(plugin),
        now: () => 1,
      },
    );
    await expect(
      installWorkflowPluginForTask(
        {
          expectedRevision: 99,
          path: "C:/plugins/agtx.json",
          taskId: "task-1",
        },
        {
          bindingRepository: repository,
          configurator: configuratorWith(plugin),
          now: () => 2,
        },
      ),
    ).rejects.toThrow(/changed in another window/i);
  });

  it("rejects when the configurator fails to load the file", async () => {
    const repository = fakeBindingRepository();
    await expect(
      installWorkflowPluginForTask(
        {
          expectedRevision: 0,
          path: "C:/plugins/agtx.json",
          taskId: "task-1",
        },
        {
          bindingRepository: repository,
          configurator: failingConfigurator("PATH_NOT_TRUSTED"),
          now: () => 1,
        },
      ),
    ).rejects.toThrow(/trust root/i);
  });
});
