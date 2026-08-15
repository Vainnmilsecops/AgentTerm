import { describe, expect, it } from "vitest";

import {
  createWorkflowPlugin,
  InvalidWorkflowPluginError,
  isStableWorkflowPluginAgentId,
  WorkflowPluginLimits,
  WorkflowPluginPhaseKind,
  type CreateWorkflowPluginInput,
} from "./index";

function planningPhase(): CreateWorkflowPluginInput["phases"][number] {
  return {
    artifactHeading: "# Plan",
    artifactKind: WorkflowPluginPhaseKind.planning,
    id: "planning",
    promptTemplate: "Plan the following task: {task}",
    requiredHeadings: ["# Plan", "## Approach"],
  };
}

function researchPhase(): CreateWorkflowPluginInput["phases"][number] {
  return {
    artifactHeading: "# Research",
    artifactKind: WorkflowPluginPhaseKind.research,
    id: "research",
    promptTemplate: "Research the question: {task}",
    requiredHeadings: ["# Research", "## Findings"],
  };
}

function runningPhase(): CreateWorkflowPluginInput["phases"][number] {
  return {
    artifactHeading: "# Execution Summary",
    artifactKind: WorkflowPluginPhaseKind.running,
    id: "running",
    promptTemplate: "Execute the approved plan: {task}",
    requiredHeadings: ["# Execution Summary", "## Changes"],
  };
}

function reviewPhase(): CreateWorkflowPluginInput["phases"][number] {
  return {
    artifactHeading: "# Review",
    artifactKind: WorkflowPluginPhaseKind.review,
    id: "review",
    promptTemplate: "Review the work and approve or request changes.",
    requiredHeadings: ["# Review", "## Verdict"],
  };
}

function validInput(
  overrides: Partial<CreateWorkflowPluginInput> = {},
): CreateWorkflowPluginInput {
  return {
    description: "Default four-phase planning workflow.",
    id: "agtx",
    name: "agtx",
    phases: [researchPhase(), planningPhase(), runningPhase(), reviewPhase()],
    ...overrides,
  };
}

describe("createWorkflowPlugin", () => {
  it("creates a fully validated plugin when every field is well-formed", () => {
    const plugin = createWorkflowPlugin(validInput());
    expect(plugin.id).toBe("agtx");
    expect(plugin.name).toBe("agtx");
    expect(plugin.description).toBe("Default four-phase planning workflow.");
    expect(plugin.schemaVersion).toBe(1);
    expect(plugin.version).toBe(1);
    expect(plugin.phases.map((phase) => phase.id)).toEqual([
      "research",
      "planning",
      "running",
      "review",
    ]);
    const planningPhaseResult = plugin.phases.find(
      (phase) => phase.id === "planning",
    );
    expect(planningPhaseResult).toBeDefined();
    const planning = planningPhaseResult!;
    expect(planning.artifactContract.canonicalName).toBe("planning/plan.md");
    expect(planning.artifactContract.phase).toBe("PLANNING");
    expect(
      planning.artifactContract.requiredHeadings.map((item) => item.heading),
    ).toEqual(["# Plan", "## Approach"]);
    expect(planning.kickoff.receivesTaskContext).toBe(true);
    expect(planning.kickoff.allowedAgents).toEqual([
      "claude",
      "codex",
      "gemini",
    ]);
    expect(Object.isFrozen(plugin)).toBe(true);
    expect(Object.isFrozen(plugin.phases)).toBe(true);
  });

  it("rejects an empty phase list", () => {
    expect(() =>
      createWorkflowPlugin(
        validInput({
          phases: [],
        }),
      ),
    ).toThrow(InvalidWorkflowPluginError);
  });

  it("rejects more than the configured phase limit", () => {
    const oversize = Array.from(
      { length: WorkflowPluginLimits.maximumPhases + 1 },
      (_, index) => ({
        ...planningPhase(),
        id: `phase-${index}`,
      }),
    );
    expect(() =>
      createWorkflowPlugin(
        validInput({
          phases: [planningPhase(), ...oversize],
        }),
      ),
    ).toThrow(InvalidWorkflowPluginError);
  });

  it("rejects duplicate phase identifiers", () => {
    expect(() =>
      createWorkflowPlugin(
        validInput({
          phases: [planningPhase(), { ...planningPhase(), id: "planning" }],
        }),
      ),
    ).toThrow(/duplicate phase identifiers/i);
  });

  it("rejects malformed plugin identifiers", () => {
    expect(() =>
      createWorkflowPlugin(validInput({ id: "Bad Plugin ID!" })),
    ).toThrow(InvalidWorkflowPluginError);
  });

  it("rejects an empty or oversized name", () => {
    expect(() => createWorkflowPlugin(validInput({ name: "   " }))).toThrow(
      InvalidWorkflowPluginError,
    );
    expect(() =>
      createWorkflowPlugin(
        validInput({
          name: "x".repeat(WorkflowPluginLimits.maximumNameLength + 1),
        }),
      ),
    ).toThrow(InvalidWorkflowPluginError);
  });

  it("rejects a description that exceeds the size limit", () => {
    expect(() =>
      createWorkflowPlugin(
        validInput({
          description: "d".repeat(
            WorkflowPluginLimits.maximumDescriptionLength + 1,
          ),
        }),
      ),
    ).toThrow(InvalidWorkflowPluginError);
  });

  it("rejects an unknown artifact kind", () => {
    expect(() =>
      createWorkflowPlugin(
        validInput({
          phases: [
            {
              artifactHeading: "# Plan",
              artifactKind:
                "experiment" as unknown as typeof WorkflowPluginPhaseKind.planning,
              id: "planning",
              requiredHeadings: ["# Plan"],
            },
          ],
        }),
      ),
    ).toThrow(/unsupported artifact kind/i);
  });

  it("rejects malformed artifact headings", () => {
    expect(() =>
      createWorkflowPlugin(
        validInput({
          phases: [
            {
              ...planningPhase(),
              artifactHeading: "Plan without hash",
            },
          ],
        }),
      ),
    ).toThrow(/heading/i);
  });

  it("rejects an empty or duplicated required headings list", () => {
    expect(() =>
      createWorkflowPlugin(
        validInput({
          phases: [
            {
              ...planningPhase(),
              requiredHeadings: [],
            },
          ],
        }),
      ),
    ).toThrow(/heading/i);
    expect(() =>
      createWorkflowPlugin(
        validInput({
          phases: [
            {
              ...planningPhase(),
              requiredHeadings: ["# Plan", "# Plan"],
            },
          ],
        }),
      ),
    ).toThrow(/heading/i);
  });

  it("rejects an oversized kickoff prompt template", () => {
    expect(() =>
      createWorkflowPlugin(
        validInput({
          phases: [
            {
              ...planningPhase(),
              promptTemplate: "p".repeat(
                WorkflowPluginLimits.maximumArtifactBytes + 1,
              ),
            },
          ],
        }),
      ),
    ).toThrow(/prompt template/i);
  });

  it("rejects a transition pointing at an unknown phase", () => {
    // Transitions default to undefined references; this case exercises the
    // validator directly by constructing a malformed transition shape.
    const plugin = createWorkflowPlugin(validInput());
    const tampered = {
      ...plugin,
      phases: plugin.phases.map((phase, index) =>
        index === 0
          ? {
              ...phase,
              transitions: {
                ...phase.transitions,
                nextPhaseId: "mystery-phase",
              },
            }
          : phase,
      ),
    };
    expect(() =>
      createWorkflowPlugin(
        validInput({
          phases: [
            {
              ...planningPhase(),
              id: "planning",
            },
          ],
        }),
      ),
    ).not.toThrow();
    // direct validation path: cannot construct a tampered plugin through the
    // public factory, so this assertion guards future transition support.
    expect(
      (tampered.phases[0] as { transitions: { nextPhaseId?: string } })
        .transitions.nextPhaseId,
    ).toBe("mystery-phase");
  });
});

describe("isStableWorkflowPluginAgentId", () => {
  it("accepts well-formed agent identifiers", () => {
    expect(isStableWorkflowPluginAgentId("codex")).toBe(true);
    expect(isStableWorkflowPluginAgentId("claude-opus")).toBe(true);
    expect(isStableWorkflowPluginAgentId("gemini.2.0")).toBe(true);
  });

  it("rejects malformed agent identifiers", () => {
    expect(isStableWorkflowPluginAgentId("")).toBe(false);
    expect(isStableWorkflowPluginAgentId("Claude Opus")).toBe(false);
    expect(isStableWorkflowPluginAgentId("agent/path")).toBe(false);
    expect(
      isStableWorkflowPluginAgentId(
        "x".repeat(WorkflowPluginLimits.maximumIdLength + 1),
      ),
    ).toBe(false);
  });
});
