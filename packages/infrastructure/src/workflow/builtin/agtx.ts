import {
  createWorkflowPlugin,
  WorkflowPluginPhaseKind,
  type WorkflowPlugin,
} from "@agentterm/domain";

/**
 * Built-in four-phase workflow that mirrors `agtx`'s default lifecycle
 * (research → planning → running → review). Phase identifiers are stable and
 * match what Application use cases resolve through {@link bindPhaseAgent}.
 */
export function createBuiltInAgtxPlugin(): WorkflowPlugin {
  return createWorkflowPlugin({
    description: "Default four-phase workflow matching agtx semantics.",
    id: "agtx",
    name: "agtx",
    phases: [
      {
        artifactHeading: "# Research",
        artifactKind: WorkflowPluginPhaseKind.research,
        id: "research",
        promptTemplate:
          "Research the task and persist findings in research/notes.md: {task}",
        requiredHeadings: ["# Research", "## Findings"],
      },
      {
        artifactHeading: "# Plan",
        artifactKind: WorkflowPluginPhaseKind.planning,
        id: "planning",
        promptTemplate:
          "Plan the following task and persist a Plan in planning/plan.md: {task}",
        requiredHeadings: ["# Plan", "## Approach", "## Risks"],
      },
      {
        artifactHeading: "# Execution Summary",
        artifactKind: WorkflowPluginPhaseKind.running,
        id: "running",
        promptTemplate:
          "Execute the approved Plan and persist an Execution Summary: {task}",
        requiredHeadings: ["# Execution Summary", "## Changes"],
      },
      {
        artifactHeading: "# Review",
        artifactKind: WorkflowPluginPhaseKind.review,
        id: "review",
        promptTemplate:
          "Review the implemented work and decide Approve or Request Changes.",
        requiredHeadings: ["# Review", "## Verdict"],
      },
    ],
  });
}
