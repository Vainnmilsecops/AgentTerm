import { TaskPhase, type TaskPhase as TaskPhaseValue } from "./task-phase";

export const WorkflowPluginPhaseKind = Object.freeze({
  planning: "planning" as const,
  research: "research" as const,
  review: "review" as const,
  running: "running" as const,
});

export type WorkflowPluginPhaseKind =
  (typeof WorkflowPluginPhaseKind)[keyof typeof WorkflowPluginPhaseKind];

export const WorkflowPluginLimits = Object.freeze({
  maximumArtifactBytes: 65_536,
  maximumDescriptionLength: 256,
  maximumIdLength: 64,
  maximumNameLength: 128,
  maximumPhaseArtifactHeadings: 16,
  maximumPhaseIdLength: 64,
  maximumPhases: 8,
  minimumRequiredArtifactHeadings: 1,
  minimumSchemaVersion: 1,
} as const);

export interface WorkflowArtifactHeading {
  readonly heading: string;
}

export interface WorkflowArtifactContract {
  readonly canonicalName: string;
  readonly format: "markdown";
  readonly heading: string;
  readonly kind: WorkflowPluginPhaseKind;
  readonly phase: TaskPhaseValue;
  readonly requiredHeadings: readonly WorkflowArtifactHeading[];
}

export interface WorkflowPhaseKickoffPolicy {
  /**
   * Optional list of allowed `AgentIdentity.id` values for this phase. An empty
   * list means "any catalog agent". Application still owns selection, so this
   * is purely declarative policy that `bindPhaseAgent` consults.
   */
  readonly allowedAgents: readonly string[];
  readonly promptTemplate: string;
  readonly receivesTaskContext: boolean;
}

export interface WorkflowPhaseTransition {
  readonly nextPhaseId: string | undefined;
  readonly previousPhaseId: string | undefined;
}

export interface WorkflowPhase {
  readonly artifactContract: WorkflowArtifactContract;
  readonly id: string;
  readonly kickoff: WorkflowPhaseKickoffPolicy;
  readonly taskPhase: TaskPhaseValue;
  readonly transitions: WorkflowPhaseTransition;
}

export interface WorkflowPlugin {
  readonly description: string;
  readonly id: string;
  readonly name: string;
  readonly phases: readonly WorkflowPhase[];
  readonly schemaVersion: 1;
  readonly version: 1;
}

export interface CreateWorkflowPhaseInput {
  readonly artifactHeading: string;
  readonly artifactKind: WorkflowPluginPhaseKind;
  readonly id: string;
  readonly promptTemplate?: string;
  readonly requiredHeadings: readonly string[];
}

export interface CreateWorkflowPluginInput {
  readonly description?: string;
  readonly id: string;
  readonly name: string;
  readonly phases: readonly CreateWorkflowPhaseInput[];
}

export type WorkflowPluginValidationReason =
  | "CYCLIC_PHASE_GRAPH"
  | "DUPLICATE_PHASE_ID"
  | "EMPTY_PHASE_GRAPH"
  | "INVALID_ARTIFACT_KIND"
  | "INVALID_ARTIFACT_NAME"
  | "INVALID_DESCRIPTION"
  | "INVALID_HEADING"
  | "INVALID_KICKOFF_PROMPT"
  | "INVALID_NAME"
  | "INVALID_PHASE_ID"
  | "INVALID_PLUGIN_ID"
  | "INVALID_REQUIRED_HEADINGS"
  | "INVALID_TASK_PHASE_BINDING"
  | "INVALID_TRANSITION_REFERENCE"
  | "TOO_MANY_PHASES";

export class InvalidWorkflowPluginError extends Error {
  public constructor(public readonly reason: WorkflowPluginValidationReason) {
    super(messageForReason(reason));
    this.name = "InvalidWorkflowPluginError";
  }
}

const stableIdPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const stableAgentIdPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const headingPattern = /^#{1,6}\s+\S/u;

interface BuilderState {
  readonly plugin: CreateWorkflowPluginInput;
}

export function createWorkflowPlugin(
  input: CreateWorkflowPluginInput,
): WorkflowPlugin {
  const state: BuilderState = { plugin: validateMetadata(input) };
  const phaseInputs = state.plugin.phases;
  if (!Array.isArray(phaseInputs) || phaseInputs.length === 0) {
    throw new InvalidWorkflowPluginError("EMPTY_PHASE_GRAPH");
  }
  if (phaseInputs.length > WorkflowPluginLimits.maximumPhases) {
    throw new InvalidWorkflowPluginError("TOO_MANY_PHASES");
  }

  const phaseIds = new Set<string>();
  const phases: WorkflowPhase[] = [];
  for (const phaseInput of phaseInputs) {
    validatePhaseId(phaseInput.id);
    if (phaseIds.has(phaseInput.id)) {
      throw new InvalidWorkflowPluginError("DUPLICATE_PHASE_ID");
    }
    phaseIds.add(phaseInput.id);
    phases.push(buildPhase(phaseInput));
  }

  validateTransitions(phases);

  return Object.freeze({
    description: state.plugin.description ?? "",
    id: state.plugin.id,
    name: state.plugin.name ?? "",
    phases: Object.freeze(phases.map(freezePhase)),
    schemaVersion: 1 as const,
    version: 1 as const,
  });
}

function validateMetadata(
  input: CreateWorkflowPluginInput,
): CreateWorkflowPluginInput {
  if (typeof input.id !== "string" || !stableIdPattern.test(input.id)) {
    throw new InvalidWorkflowPluginError("INVALID_PLUGIN_ID");
  }
  if (
    input.id.length === 0 ||
    input.id.length > WorkflowPluginLimits.maximumIdLength
  ) {
    throw new InvalidWorkflowPluginError("INVALID_PLUGIN_ID");
  }
  const name = input.name.trim();
  if (
    name.length === 0 ||
    name.length > WorkflowPluginLimits.maximumNameLength ||
    name.includes("\0")
  ) {
    throw new InvalidWorkflowPluginError("INVALID_NAME");
  }
  const description = (input.description ?? "").trim();
  if (
    description.length > WorkflowPluginLimits.maximumDescriptionLength ||
    description.includes("\0")
  ) {
    throw new InvalidWorkflowPluginError("INVALID_DESCRIPTION");
  }
  return { ...input, description, id: input.id, name };
}

function validatePhaseId(id: string): void {
  if (
    typeof id !== "string" ||
    !stableIdPattern.test(id) ||
    id.length === 0 ||
    id.length > WorkflowPluginLimits.maximumPhaseIdLength
  ) {
    throw new InvalidWorkflowPluginError("INVALID_PHASE_ID");
  }
}

function buildPhase(input: CreateWorkflowPhaseInput): WorkflowPhase {
  if (!Object.values(WorkflowPluginPhaseKind).includes(input.artifactKind)) {
    throw new InvalidWorkflowPluginError("INVALID_ARTIFACT_KIND");
  }
  const expectedPhase = phaseForKind(input.artifactKind);
  const heading = input.artifactHeading.trim();
  if (
    heading.length === 0 ||
    heading.includes("\0") ||
    !headingPattern.test(heading)
  ) {
    throw new InvalidWorkflowPluginError("INVALID_HEADING");
  }
  const requiredHeadings = validateRequiredHeadings(input.requiredHeadings);
  const canonicalName = canonicalNameFor(input.artifactKind);
  if (!isValidCanonicalName(canonicalName)) {
    throw new InvalidWorkflowPluginError("INVALID_ARTIFACT_NAME");
  }
  const promptTemplate = (input.promptTemplate ?? "").trim();
  if (
    promptTemplate.length > WorkflowPluginLimits.maximumArtifactBytes ||
    promptTemplate.includes("\0")
  ) {
    throw new InvalidWorkflowPluginError("INVALID_KICKOFF_PROMPT");
  }
  const allowedAgents = validateAllowedAgents(input.artifactKind);

  return {
    artifactContract: {
      canonicalName,
      format: "markdown",
      heading,
      kind: input.artifactKind,
      phase: expectedPhase,
      requiredHeadings,
    },
    id: input.id,
    kickoff: {
      allowedAgents,
      promptTemplate,
      receivesTaskContext: true,
    },
    taskPhase: expectedPhase,
    transitions: {
      nextPhaseId: undefined,
      previousPhaseId: undefined,
    },
  };
}

function freezePhase(phase: WorkflowPhase): WorkflowPhase {
  return Object.freeze({
    artifactContract: Object.freeze({
      canonicalName: phase.artifactContract.canonicalName,
      format: phase.artifactContract.format,
      heading: phase.artifactContract.heading,
      kind: phase.artifactContract.kind,
      phase: phase.artifactContract.phase,
      requiredHeadings: Object.freeze(
        phase.artifactContract.requiredHeadings.map((item) =>
          Object.freeze({ heading: item.heading }),
        ),
      ),
    }),
    id: phase.id,
    kickoff: Object.freeze({
      allowedAgents: Object.freeze([...phase.kickoff.allowedAgents]),
      promptTemplate: phase.kickoff.promptTemplate,
      receivesTaskContext: phase.kickoff.receivesTaskContext,
    }),
    taskPhase: phase.taskPhase,
    transitions: Object.freeze({
      nextPhaseId: phase.transitions.nextPhaseId,
      previousPhaseId: phase.transitions.previousPhaseId,
    }),
  });
}

function validateRequiredHeadings(
  headings: readonly string[],
): readonly WorkflowArtifactHeading[] {
  if (
    !Array.isArray(headings) ||
    headings.length < WorkflowPluginLimits.minimumRequiredArtifactHeadings ||
    headings.length > WorkflowPluginLimits.maximumPhaseArtifactHeadings
  ) {
    throw new InvalidWorkflowPluginError("INVALID_REQUIRED_HEADINGS");
  }
  const seen = new Set<string>();
  const result: WorkflowArtifactHeading[] = [];
  for (const heading of headings) {
    if (typeof heading !== "string") {
      throw new InvalidWorkflowPluginError("INVALID_REQUIRED_HEADINGS");
    }
    const trimmed = heading.trim();
    if (
      trimmed.length === 0 ||
      trimmed.includes("\0") ||
      !headingPattern.test(trimmed) ||
      seen.has(trimmed)
    ) {
      throw new InvalidWorkflowPluginError("INVALID_REQUIRED_HEADINGS");
    }
    seen.add(trimmed);
    result.push({ heading: trimmed });
  }
  return Object.freeze(result);
}

function validateAllowedAgents(
  kind: WorkflowPluginPhaseKind,
): readonly string[] {
  // M1 freezes a built-in mapping between artifact kinds and allowed agent
  // identities because we only ship three adapters (codex, claude, gemini).
  // Plugin authors cannot widen the list in M1.
  switch (kind) {
    case "research":
      return Object.freeze(["gemini"]);
    case "planning":
      return Object.freeze(["claude", "codex", "gemini"]);
    case "running":
      return Object.freeze(["claude", "codex"]);
    case "review":
      return Object.freeze(["claude", "codex"]);
  }
}

function isValidCanonicalName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 256 &&
    !name.includes("\0") &&
    !name.startsWith("/") &&
    !name.includes("..") &&
    /^[a-z0-9]+(?:[/_-][a-z0-9]+)+\.md$/u.test(name)
  );
}

function validateTransitions(phases: readonly WorkflowPhase[]): void {
  const ids = new Set(phases.map((phase) => phase.id));
  for (const phase of phases) {
    if (
      phase.transitions.nextPhaseId !== undefined &&
      !ids.has(phase.transitions.nextPhaseId)
    ) {
      throw new InvalidWorkflowPluginError("INVALID_TRANSITION_REFERENCE");
    }
    if (
      phase.transitions.previousPhaseId !== undefined &&
      !ids.has(phase.transitions.previousPhaseId)
    ) {
      throw new InvalidWorkflowPluginError("INVALID_TRANSITION_REFERENCE");
    }
  }
}

function phaseForKind(kind: WorkflowPluginPhaseKind): TaskPhaseValue {
  switch (kind) {
    case "research":
      return TaskPhase.BACKLOG;
    case "planning":
      return TaskPhase.PLANNING;
    case "running":
      return TaskPhase.RUNNING;
    case "review":
      return TaskPhase.REVIEW;
  }
}

function canonicalNameFor(kind: WorkflowPluginPhaseKind): string {
  switch (kind) {
    case "research":
      return "research/notes.md";
    case "planning":
      return "planning/plan.md";
    case "running":
      return "running/execution-summary.md";
    case "review":
      return "review/review.md";
  }
}

function messageForReason(reason: WorkflowPluginValidationReason): string {
  switch (reason) {
    case "CYCLIC_PHASE_GRAPH":
      return "The Workflow Plugin declares a cyclic phase graph.";
    case "DUPLICATE_PHASE_ID":
      return "The Workflow Plugin contains duplicate phase identifiers.";
    case "EMPTY_PHASE_GRAPH":
      return "The Workflow Plugin must declare at least one phase.";
    case "TOO_MANY_PHASES":
      return `The Workflow Plugin declares more than ${WorkflowPluginLimits.maximumPhases} phases.`;
    case "INVALID_ARTIFACT_KIND":
      return "A Workflow Plugin phase uses an unsupported artifact kind.";
    case "INVALID_ARTIFACT_NAME":
      return "A Workflow Plugin artifact canonical name is malformed.";
    case "INVALID_DESCRIPTION":
      return "The Workflow Plugin description is too long or contains invalid characters.";
    case "INVALID_HEADING":
      return "A Workflow Plugin artifact heading is malformed.";
    case "INVALID_KICKOFF_PROMPT":
      return "A Workflow Plugin kickoff prompt template is malformed.";
    case "INVALID_NAME":
      return "The Workflow Plugin name is missing or malformed.";
    case "INVALID_PHASE_ID":
      return "A Workflow Plugin phase identifier is malformed.";
    case "INVALID_PLUGIN_ID":
      return "The Workflow Plugin identifier is malformed.";
    case "INVALID_REQUIRED_HEADINGS":
      return "A Workflow Plugin phase requires an explicit non-empty heading list.";
    case "INVALID_TASK_PHASE_BINDING":
      return "A Workflow Plugin phase does not bind to its expected Task phase.";
    case "INVALID_TRANSITION_REFERENCE":
      return "A Workflow Plugin transition references an unknown phase.";
  }
}

/**
 * Convenience helper that callers may use to test agent identity strings without
 * importing the regex directly. Returns true when the id matches the stable
 * {@link AgentIdentity.id} shape used by the catalog.
 */
export function isStableWorkflowPluginAgentId(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= WorkflowPluginLimits.maximumIdLength &&
    stableAgentIdPattern.test(value)
  );
}
