import {
  createWorkflowPlugin,
  WorkflowPluginPhaseKind,
  type WorkflowPlugin,
} from "@agentterm/domain";

/**
 * Built-in no-op workflow that exposes a single planning phase. Application
 * treats selecting this plugin as a request to fall back to the legacy default
 * behavior (one agent selected through Settings for every phase) and to skip
 * per-phase artifact gating.
 */
export function createBuiltInVoidPlugin(): WorkflowPlugin {
  return createWorkflowPlugin({
    description: "No-op workflow that bypasses per-phase plugin gating.",
    id: "void",
    name: "void",
    phases: [
      {
        artifactHeading: "# Notes",
        artifactKind: WorkflowPluginPhaseKind.planning,
        id: "planning",
        requiredHeadings: ["# Notes"],
      },
    ],
  });
}
