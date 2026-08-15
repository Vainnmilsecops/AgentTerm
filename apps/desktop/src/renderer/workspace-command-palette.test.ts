import { describe, expect, it, vi } from 'vitest';

import {
  buildWorkspaceCommands,
  filterWorkspaceCommands,
  initialCommandPaletteState,
  reduceCommandPalette,
  resolveCommandPaletteKey,
  resolveWorkspaceGlobalShortcut,
  type WorkspaceCommandActions,
  type WorkspaceCommandContext,
} from './workspace-command-palette';

const baseContext: WorkspaceCommandContext = {
  actionBusy: false,
  now: 1_700_000_000_000,
  qualityGates: [
    { id: 'lint', kind: 'LINT' },
    { id: 'tests', kind: 'TEST' },
  ],
  selectedAgentId: 'codex',
  selectedTask: {
    canProduceArtifact: true,
    canRequestReview: true,
    canRetryExecution: true,
    canRevisePlan: false,
    canRunQualityGate: true,
    canStartExecution: false,
    canStartPlanning: false,
    dependencies: [
      { id: 'task-blocker', phase: 'RUNNING', projectId: 'project-1', title: 'Blocker' },
    ],
    id: 'task-vietnamese',
    projectId: 'project-1',
    title: 'Kiểm tra tiếng Việt',
  },
  tasks: [
    { id: 'task-vietnamese', projectName: 'AgentTerm', title: 'Kiểm tra tiếng Việt' },
    { id: 'task-review', projectName: 'AgentTerm', title: 'Review flow' },
    { id: 'task-blocker', projectName: 'AgentTerm', title: 'Blocker' },
  ],
};

function createActions() {
  return {
    addDependency: vi.fn<WorkspaceCommandActions['addDependency']>(),
    focus: vi.fn<WorkspaceCommandActions['focus']>(),
    produceArtifact: vi.fn<WorkspaceCommandActions['produceArtifact']>(),
    registerQualityGate: vi.fn<WorkspaceCommandActions['registerQualityGate']>(),
    removeDependency: vi.fn<WorkspaceCommandActions['removeDependency']>(),
    requestReview: vi.fn<WorkspaceCommandActions['requestReview']>(),
    retryExecution: vi.fn<WorkspaceCommandActions['retryExecution']>(),
    runQualityGate: vi.fn<WorkspaceCommandActions['runQualityGate']>(),
    selectTask: vi.fn<WorkspaceCommandActions['selectTask']>(),
    startExecution: vi.fn<WorkspaceCommandActions['startExecution']>(),
    startPlanning: vi.fn<WorkspaceCommandActions['startPlanning']>(),
    unregisterQualityGate: vi.fn<WorkspaceCommandActions['unregisterQualityGate']>(),
    importQualityGateConfig: vi.fn<WorkspaceCommandActions['importQualityGateConfig']>(),
    exportQualityGateConfig: vi.fn<WorkspaceCommandActions['exportQualityGateConfig']>(),
  };
}

describe('workspace command registry', () => {
  it('searches Unicode and Vietnamese labels without requiring matching diacritics', () => {
    const actions = createActions();
    const commands = buildWorkspaceCommands(baseContext, actions);

    expect(filterWorkspaceCommands(commands, 'kiem tra tieng viet').map(({ id }) => id)).toContain(
      'task:task-vietnamese',
    );
    expect(filterWorkspaceCommands(commands, 'Kiểm tra').map(({ id }) => id)).toContain(
      'task:task-vietnamese',
    );
    expect(filterWorkspaceCommands(commands, 'chat luong').map(({ id }) => id)).toEqual([
      'open:checks',
    ]);
  });

  it('dispatches only contextual Presentation actions through stable command identities', async () => {
    const actions = createActions();
    const commands = buildWorkspaceCommands(baseContext, actions);

    expect(commands.map(({ id }) => id)).toEqual([
      'task:task-vietnamese',
      'task:task-review',
      'task:task-blocker',
      'execution:retry',
      'review:request',
      'focus:sidebar',
      'focus:workspace',
      'open:terminal',
      'open:artifacts',
      'open:checks',
      'open:changes',
      'open:review',
      'gate:lint',
      'gate:tests',
      'gate:remove:lint',
      'gate:remove:tests',
      'gate:config:import',
      'gate:config:export',
      'artifact:produce',
      'dependency:require:task-review',
      'dependency:remove:task-blocker',
      'gate:register',
    ]);

    await commands.find(({ id }) => id === 'task:task-review')?.run();
    await commands.find(({ id }) => id === 'execution:retry')?.run();
    await commands.find(({ id }) => id === 'open:terminal')?.run();
    await commands.find(({ id }) => id === 'gate:lint')?.run();
    await commands.find(({ id }) => id === 'gate:remove:tests')?.run();
    await commands.find(({ id }) => id === 'artifact:produce')?.run();
    await commands.find(({ id }) => id === 'dependency:require:task-review')?.run();
    await commands.find(({ id }) => id === 'dependency:remove:task-blocker')?.run();
    await commands.find(({ id }) => id === 'gate:register')?.run();

    expect(actions.selectTask).toHaveBeenCalledWith('task-review');
    expect(actions.retryExecution).toHaveBeenCalledOnce();
    expect(actions.focus).toHaveBeenCalledWith('terminal');
    expect(actions.runQualityGate).toHaveBeenCalledWith('lint');
    expect(actions.unregisterQualityGate).toHaveBeenCalledWith('tests');
    expect(actions.produceArtifact).toHaveBeenCalledOnce();
    expect(actions.produceArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'execution-summary', taskId: 'task-vietnamese' }),
    );
    expect(actions.addDependency).toHaveBeenCalledWith('task-review', 'task-vietnamese');
    expect(actions.removeDependency).toHaveBeenCalledWith('task-blocker', 'task-vietnamese');
    expect(actions.focus).toHaveBeenCalledWith('checks');
  });

  it('hides Quality Gate palette entries when the Task cannot run gates or the workspace is busy', () => {
    const actions = createActions();
    const blockedGate = buildWorkspaceCommands(
      {
        ...baseContext,
        selectedTask: { ...baseContext.selectedTask!, canRunQualityGate: false },
      },
      actions,
    );
    const busyGate = buildWorkspaceCommands(
      {
        ...baseContext,
        actionBusy: true,
      },
      actions,
    );

    expect(blockedGate.map(({ id }) => id).some((id) => id.startsWith('gate:'))).toBe(false);
    expect(
      blockedGate.map(({ id }) => id).some((id) => id === 'gate:register'),
    ).toBe(false);
    expect(busyGate.map(({ id }) => id).some((id) => id.startsWith('gate:'))).toBe(false);
    expect(busyGate.map(({ id }) => id)).not.toContain('artifact:produce');
    expect(busyGate.map(({ id }) => id).some((id) => id.startsWith('dependency:'))).toBe(false);
  });

  it('hides the artifact producer when the selected Task cannot produce one', () => {
    const actions = createActions();
    const commands = buildWorkspaceCommands(
      {
        ...baseContext,
        selectedTask: { ...baseContext.selectedTask!, canProduceArtifact: false },
      },
      actions,
    );

    expect(commands.map(({ id }) => id)).not.toContain('artifact:produce');
  });

  it('hides the dependency commands when none are actionable from the selected Task', () => {
    const actions = createActions();
    const candidateLess = buildWorkspaceCommands(
      {
        ...baseContext,
        selectedTask: { ...baseContext.selectedTask!, dependencies: [] },
        tasks: [{ id: baseContext.selectedTask!.id, projectName: 'AgentTerm', title: baseContext.selectedTask!.title }],
      },
      actions,
    );

    expect(candidateLess.map(({ id }) => id).some((id) => id.startsWith('dependency:'))).toBe(false);
  });

  it('omits unavailable mutation commands instead of duplicating business enablement', () => {
    const actions = createActions();
    const noAgentCommands = buildWorkspaceCommands(
      {
        ...baseContext,
        selectedAgentId: undefined,
        selectedTask: {
          ...baseContext.selectedTask!,
          canRequestReview: false,
          canRetryExecution: false,
          canRunQualityGate: false,
          canStartExecution: true,
        },
      },
      actions,
    );
    const busyCommands = buildWorkspaceCommands(
      {
        ...baseContext,
        actionBusy: true,
        selectedTask: { ...baseContext.selectedTask!, canRequestReview: false },
      },
      actions,
    );

    expect(noAgentCommands.map(({ id }) => id)).not.toContain('execution:start');
    expect(noAgentCommands.map(({ id }) => id)).not.toContain('review:request');
    expect(noAgentCommands.map(({ id }) => id).some((id) => id.startsWith('gate:'))).toBe(false);
    expect(noAgentCommands.map(({ id }) => id)).toContain('open:terminal');
    expect(busyCommands.map(({ id }) => id)).not.toContain('execution:retry');
    expect(busyCommands.map(({ id }) => id).some((id) => id.startsWith('gate:'))).toBe(false);
  });
});

describe('command palette keyboard model', () => {
  it('opens, resets search, wraps keyboard navigation, and closes deterministically', () => {
    const opened = reduceCommandPalette(initialCommandPaletteState, { kind: 'OPEN' }, 3);
    const searched = reduceCommandPalette(opened, { kind: 'SEARCH', query: 'kiểm' }, 2);
    const wrappedUp = reduceCommandPalette(searched, { delta: -1, kind: 'MOVE' }, 2);
    const wrappedDown = reduceCommandPalette(wrappedUp, { delta: 1, kind: 'MOVE' }, 2);
    const closed = reduceCommandPalette(wrappedDown, { kind: 'CLOSE' }, 2);

    expect(opened).toEqual({ activeIndex: 0, open: true, query: '' });
    expect(searched).toEqual({ activeIndex: 0, open: true, query: 'kiểm' });
    expect(wrappedUp.activeIndex).toBe(1);
    expect(wrappedDown.activeIndex).toBe(0);
    expect(closed).toEqual(initialCommandPaletteState);
  });

  it('maps navigation keys while leaving Vietnamese IME composition untouched', () => {
    expect(resolveCommandPaletteKey({ key: 'ArrowDown' })).toEqual({ delta: 1, kind: 'MOVE' });
    expect(resolveCommandPaletteKey({ key: 'ArrowUp' })).toEqual({ delta: -1, kind: 'MOVE' });
    expect(resolveCommandPaletteKey({ key: 'Enter' })).toBe('RUN');
    expect(resolveCommandPaletteKey({ key: 'Escape' })).toEqual({ kind: 'CLOSE' });
    expect(resolveCommandPaletteKey({ isComposing: true, key: 'Enter' })).toBeUndefined();
    expect(resolveCommandPaletteKey({ key: 'k' })).toBeUndefined();
  });

  it('keeps ordinary terminal keys untouched and intercepts only documented global chords', () => {
    for (const input of [
      { code: 'KeyA', key: 'a' },
      { code: 'Enter', key: 'Enter' },
      { code: 'KeyC', ctrlKey: true, key: 'c' },
      { code: 'KeyV', ctrlKey: true, key: 'v' },
    ]) {
      expect(resolveWorkspaceGlobalShortcut(input)).toBeUndefined();
    }

    expect(
      resolveWorkspaceGlobalShortcut({ code: 'KeyP', ctrlKey: true, key: 'P', shiftKey: true }),
    ).toBe('open-palette');
    expect(resolveWorkspaceGlobalShortcut({ altKey: true, code: 'Digit1', key: '1' })).toBe(
      'focus-sidebar',
    );
    expect(resolveWorkspaceGlobalShortcut({ altKey: true, code: 'Digit2', key: '2' })).toBe(
      'focus-workspace',
    );
    expect(resolveWorkspaceGlobalShortcut({ altKey: true, code: 'Digit3', key: '3' })).toBe(
      'focus-terminal',
    );
    expect(resolveWorkspaceGlobalShortcut({ altKey: true, code: 'BracketLeft', key: '[' })).toBe(
      'previous-tab',
    );
    expect(resolveWorkspaceGlobalShortcut({ altKey: true, code: 'BracketRight', key: ']' })).toBe(
      'next-tab',
    );
    expect(
      resolveWorkspaceGlobalShortcut({
        altKey: true,
        code: 'BracketLeft',
        key: '[',
        shiftKey: true,
      }),
    ).toBe('previous-pane');
    expect(
      resolveWorkspaceGlobalShortcut({
        altKey: true,
        code: 'BracketRight',
        key: ']',
        shiftKey: true,
      }),
    ).toBe('next-pane');
  });
});
