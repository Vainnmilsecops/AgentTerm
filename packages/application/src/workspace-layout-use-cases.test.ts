import { describe, expect, it } from 'vitest';

import {
  WorkspaceLayoutConflictError,
  WorkspaceLayoutValidationError,
  isWorkspaceLayoutRecord,
  loadWorkspaceLayout,
  saveWorkspaceLayout,
  validateWorkspaceLayoutRecord,
  type WorkspaceLayoutReadModel,
  type WorkspaceLayoutRecord,
  type WorkspaceLayoutRepository,
} from './workspace-layout-use-cases';

const sampleLayout = (): WorkspaceLayoutRecord => ({
  activeTabId: 'tab:task-1',
  tabs: [
    {
      activePaneId: 'pane:task-1:main',
      id: 'tab:task-1',
      panes: [
        { id: 'pane:task-1:main', sessionId: 'session-1', taskId: 'task-1' },
      ],
      taskId: 'task-1',
    },
  ],
});

class InMemoryRepository implements WorkspaceLayoutRepository {
  public records = new Map<number, WorkspaceLayoutRecord>();
  public nextRevision = 0;

  public async load(): Promise<WorkspaceLayoutReadModel | undefined> {
    if (this.records.size === 0) return undefined;
    const revision = Math.max(...this.records.keys());
    const layout = this.records.get(revision);
    return { layout: layout as WorkspaceLayoutRecord, revision, updatedAt: revision };
  }

  public async save({
    expectedRevision,
    layout,
  }: {
    expectedRevision: number;
    layout: WorkspaceLayoutRecord;
  }): Promise<WorkspaceLayoutReadModel> {
    if (expectedRevision !== this.nextRevision) {
      throw new WorkspaceLayoutConflictError();
    }
    this.nextRevision += 1;
    this.records.set(this.nextRevision, layout);
    return { layout, revision: this.nextRevision, updatedAt: this.nextRevision };
  }
}

describe('workspace-layout validation', () => {
  it('accepts a well-formed layout', () => {
    expect(() => validateWorkspaceLayoutRecord(sampleLayout())).not.toThrow();
  });

  it('rejects duplicate tab ids', () => {
    const sample = sampleLayout();
    const layout: WorkspaceLayoutRecord = {
      ...sample,
      tabs: [
        ...sample.tabs,
        {
          activePaneId: 'pane:task-2:main',
          id: 'tab:task-1',
          panes: [{ id: 'pane:task-2:main', sessionId: undefined, taskId: 'task-2' }],
          taskId: 'task-2',
        },
      ],
    };
    expect(() => validateWorkspaceLayoutRecord(layout)).toThrow(WorkspaceLayoutValidationError);
  });

  it('rejects invalid characters in identifiers', () => {
    const layout: WorkspaceLayoutRecord = {
      ...sampleLayout(),
      tabs: [
        {
          ...sampleLayout().tabs[0]!,
          id: 'tab with space',
        },
      ],
    };
    expect(() => validateWorkspaceLayoutRecord(layout)).toThrow(WorkspaceLayoutValidationError);
  });

  it('rejects too many tabs', () => {
    const layout = {
      activeTabId: undefined,
      tabs: Array.from({ length: 33 }, () => sampleLayout().tabs[0]!),
    };
    expect(() => validateWorkspaceLayoutRecord(layout)).toThrow(WorkspaceLayoutValidationError);
  });

  it('isWorkspaceLayoutRecord returns boolean only', () => {
    expect(isWorkspaceLayoutRecord(sampleLayout())).toBe(true);
    expect(isWorkspaceLayoutRecord({ tabs: 'not-array' } as unknown as WorkspaceLayoutRecord)).toBe(
      false,
    );
  });
});

describe('loadWorkspaceLayout / saveWorkspaceLayout use cases', () => {
  it('returns undefined when no layout is persisted', async () => {
    const repository = new InMemoryRepository();
    await expect(loadWorkspaceLayout({ clock: () => 1, repository })).resolves.toBeUndefined();
  });

  it('saves the layout and returns the next revision', async () => {
    const repository = new InMemoryRepository();
    const result = await saveWorkspaceLayout(
      { expectedRevision: 0, layout: sampleLayout() },
      { clock: () => 1, repository },
    );
    expect(result.revision).toBe(1);
    expect(repository.records.size).toBe(1);
  });

  it('rejects save with mismatched expected revision', async () => {
    const repository = new InMemoryRepository();
    await saveWorkspaceLayout(
      { expectedRevision: 0, layout: sampleLayout() },
      { clock: () => 1, repository },
    );
    await expect(
      saveWorkspaceLayout(
        { expectedRevision: 5, layout: sampleLayout() },
        { clock: () => 2, repository },
      ),
    ).rejects.toBeInstanceOf(WorkspaceLayoutConflictError);
  });

  it('rejects invalid layout on save', async () => {
    const repository = new InMemoryRepository();
    await expect(
      saveWorkspaceLayout(
        {
          expectedRevision: 0,
          layout: { tabs: 'not-an-array' } as unknown as WorkspaceLayoutRecord,
        },
        { clock: () => 1, repository },
      ),
    ).rejects.toBeInstanceOf(WorkspaceLayoutValidationError);
  });
});
