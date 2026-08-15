import {
  validateWorkspaceLayoutRecord,
  WorkspaceLayoutConflictError,
  WorkspaceLayoutValidationError,
  isWorkspaceLayoutRecord,
  WORKSPACE_LAYOUT_MAX_TABS,
  WORKSPACE_LAYOUT_MAX_PANES_PER_TAB,
  WORKSPACE_LAYOUT_MAX_TAB_ID_LENGTH,
  WORKSPACE_LAYOUT_MAX_PANE_ID_LENGTH,
  WORKSPACE_LAYOUT_MAX_TASK_ID_LENGTH,
  WORKSPACE_LAYOUT_MAX_SESSION_ID_LENGTH,
  type WorkspaceLayoutPaneRecord,
  type WorkspaceLayoutReadModel,
  type WorkspaceLayoutRecord,
  type WorkspaceLayoutTabRecord,
  type WorkspaceLayoutValidationFailure,
} from './workspace-layout';

export {
  WorkspaceLayoutConflictError,
  WorkspaceLayoutValidationError,
  validateWorkspaceLayoutRecord,
  isWorkspaceLayoutRecord,
  WORKSPACE_LAYOUT_MAX_TABS,
  WORKSPACE_LAYOUT_MAX_PANES_PER_TAB,
  WORKSPACE_LAYOUT_MAX_TAB_ID_LENGTH,
  WORKSPACE_LAYOUT_MAX_PANE_ID_LENGTH,
  WORKSPACE_LAYOUT_MAX_TASK_ID_LENGTH,
  WORKSPACE_LAYOUT_MAX_SESSION_ID_LENGTH,
};
export type {
  WorkspaceLayoutPaneRecord,
  WorkspaceLayoutReadModel,
  WorkspaceLayoutRecord,
  WorkspaceLayoutTabRecord,
  WorkspaceLayoutValidationFailure,
};

export interface WorkspaceLayoutRepository {
  /** Returns the persisted singleton or undefined when no layout has been saved yet. */
  load(): Promise<WorkspaceLayoutReadModel | undefined>;
  /** Atomically replaces the singleton when the stored revision matches. */
  save(input: {
    readonly expectedRevision: number;
    readonly layout: WorkspaceLayoutRecord;
  }): Promise<WorkspaceLayoutReadModel>;
}

export interface WorkspaceLayoutDependencies {
  readonly clock: () => number;
  readonly repository: WorkspaceLayoutRepository;
}

export async function loadWorkspaceLayout(
  dependencies: WorkspaceLayoutDependencies,
): Promise<WorkspaceLayoutReadModel | undefined> {
  return dependencies.repository.load();
}

export interface SaveWorkspaceLayoutInput {
  readonly expectedRevision: number;
  readonly layout: WorkspaceLayoutRecord;
}

export async function saveWorkspaceLayout(
  input: SaveWorkspaceLayoutInput,
  dependencies: WorkspaceLayoutDependencies,
): Promise<WorkspaceLayoutReadModel> {
  const validated = validateWorkspaceLayoutRecord(input.layout);
  return dependencies.repository.save({
    expectedRevision: input.expectedRevision,
    layout: validated.layout,
  });
}
