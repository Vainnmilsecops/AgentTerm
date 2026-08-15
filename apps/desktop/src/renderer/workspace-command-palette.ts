export type WorkspaceFocusTarget =
  'artifacts' | 'changes' | 'checks' | 'review' | 'sidebar' | 'terminal' | 'workspace';

export type WorkspaceCommandArtifactKind = 'execution-summary' | 'plan' | 'review';
export type WorkspaceCommandQualityGateKind = 'BUILD' | 'LINT' | 'TEST' | 'TYPECHECK';
export type WorkspaceCommandTaskPhase =
  | 'BACKLOG'
  | 'DONE'
  | 'PLANNING'
  | 'REVIEW'
  | 'RUNNING';

export interface WorkspaceCommand {
  readonly category: 'Navigate' | 'Quality gates' | 'Task';
  readonly id: string;
  readonly keywords: readonly string[];
  readonly label: string;
  readonly run: () => Promise<void> | void;
  readonly shortcut?: string;
}

export interface WorkspaceCommandDependency {
  readonly id: string;
  readonly phase: WorkspaceCommandTaskPhase;
  readonly projectId: string;
  readonly title: string;
}

export interface WorkspaceCommandTask {
  readonly canProduceArtifact: boolean;
  readonly canRequestReview: boolean;
  readonly canRetryExecution: boolean;
  readonly canRevisePlan: boolean;
  readonly canRunQualityGate: boolean;
  readonly canStartExecution: boolean;
  readonly canStartPlanning: boolean;
  readonly dependencies: readonly WorkspaceCommandDependency[];
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
}

export interface WorkspaceCommandContext {
  readonly actionBusy: boolean;
  readonly now: number;
  readonly qualityGates: readonly {
    readonly id: string;
    readonly kind: WorkspaceCommandQualityGateKind;
  }[];
  readonly selectedAgentId: string | undefined;
  readonly selectedTask: WorkspaceCommandTask | undefined;
  readonly tasks: readonly {
    readonly id: string;
    readonly projectName: string;
    readonly title: string;
  }[];
}

export interface WorkspaceCommandActions {
  addDependency(dependencyTaskId: string, taskId: string): Promise<void> | void;
  focus(target: WorkspaceFocusTarget): void;
  produceArtifact(input: {
    readonly content: string;
    readonly createdAt: number;
    readonly id: string;
    readonly kind: WorkspaceCommandArtifactKind;
    readonly sessionId: string | undefined;
    readonly taskId: string;
  }): Promise<unknown> | unknown;
  registerQualityGate(input: {
    readonly arguments: readonly string[];
    readonly executablePath: string;
    readonly id: string;
    readonly kind: WorkspaceCommandQualityGateKind;
    readonly timeoutMs: number;
  }): Promise<unknown> | unknown;
  removeDependency(dependencyTaskId: string, taskId: string): Promise<void> | void;
  requestReview(): Promise<void> | void;
  retryExecution(): Promise<void> | void;
  runQualityGate(gateId: string): Promise<void> | void;
  selectTask(taskId: string): void;
  startExecution(): Promise<void> | void;
  startPlanning(): Promise<void> | void;
  unregisterQualityGate(gateId: string): Promise<boolean> | boolean;
  importQualityGateConfig(): Promise<unknown> | unknown;
  exportQualityGateConfig(): Promise<void> | void;
}

export interface CommandPaletteState {
  readonly activeIndex: number;
  readonly open: boolean;
  readonly query: string;
}

export type CommandPaletteAction =
  | { readonly kind: 'CLOSE' }
  | { readonly kind: 'MOVE'; readonly delta: -1 | 1 }
  | { readonly kind: 'OPEN' }
  | { readonly kind: 'SEARCH'; readonly query: string };

export type WorkspaceGlobalShortcut =
  | 'focus-sidebar'
  | 'focus-terminal'
  | 'focus-workspace'
  | 'next-pane'
  | 'next-tab'
  | 'open-palette'
  | 'previous-pane'
  | 'previous-tab';

export interface WorkspaceShortcutInput {
  readonly altKey?: boolean;
  readonly code: string;
  readonly ctrlKey?: boolean;
  readonly key: string;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

export interface CommandPaletteKeyInput {
  readonly isComposing?: boolean;
  readonly key: string;
}

export const initialCommandPaletteState: CommandPaletteState = Object.freeze({
  activeIndex: 0,
  open: false,
  query: '',
});

export function buildWorkspaceCommands(
  context: WorkspaceCommandContext,
  actions: WorkspaceCommandActions,
): readonly WorkspaceCommand[] {
  const commands: WorkspaceCommand[] = context.tasks.map((task) =>
    command({
      category: 'Task',
      id: `task:${task.id}`,
      keywords: [task.id, task.projectName, task.title, 'open choose select task'],
      label: `Open Task: ${task.title}`,
      run: () => actions.selectTask(task.id),
    }),
  );
  const selected = context.selectedTask;
  if (selected === undefined) {
    return Object.freeze(commands);
  }

  if (!context.actionBusy && context.selectedAgentId !== undefined) {
    if (selected.canStartPlanning || selected.canRevisePlan) {
      commands.push(
        command({
          category: 'Task',
          id: 'execution:planning',
          keywords: ['agent plan planning revise replan'],
          label: selected.canRevisePlan ? 'Revise plan' : 'Start planning',
          run: actions.startPlanning,
        }),
      );
    } else if (selected.canRetryExecution) {
      commands.push(
        command({
          category: 'Task',
          id: 'execution:retry',
          keywords: ['agent execution retry rerun'],
          label: 'Retry execution',
          run: actions.retryExecution,
        }),
      );
    } else if (selected.canStartExecution) {
      commands.push(
        command({
          category: 'Task',
          id: 'execution:start',
          keywords: ['agent execution launch run'],
          label: 'Start execution',
          run: actions.startExecution,
        }),
      );
    }
  }

  if (!context.actionBusy && selected.canRequestReview) {
    commands.push(
      command({
        category: 'Task',
        id: 'review:request',
        keywords: ['request begin code evidence'],
        label: 'Start review',
        run: actions.requestReview,
      }),
    );
  }

  commands.push(
    focusCommand(
      'focus:sidebar',
      'Focus Sidebar',
      ['projects tasks navigation'],
      'Alt+1',
      'sidebar',
    ),
    focusCommand('focus:workspace', 'Focus Workspace', ['task details main'], 'Alt+2', 'workspace'),
    focusCommand(
      'open:terminal',
      'Open Terminal',
      ['agent session pty shell'],
      'Alt+3',
      'terminal',
    ),
    focusCommand(
      'open:artifacts',
      'Open Artifacts',
      ['evidence output plan summary'],
      undefined,
      'artifacts',
    ),
    focusCommand(
      'open:checks',
      'Open Checks',
      ['quality gates kiểm tra chất lượng validation'],
      undefined,
      'checks',
    ),
    focusCommand('open:changes', 'Open Changes', ['git diff changed files'], undefined, 'changes'),
    focusCommand('open:review', 'Open Review', ['approval evidence decision'], undefined, 'review'),
  );

  if (!context.actionBusy && selected.canRunQualityGate) {
    for (const gate of context.qualityGates) {
      commands.push(
        command({
          category: 'Quality gates',
          id: `gate:${gate.id}`,
          keywords: [gate.id, gate.kind, 'run check validation'],
          label: `Run ${gate.kind}: ${gate.id}`,
          run: () => actions.runQualityGate(gate.id),
        }),
      );
    }
    for (const gate of context.qualityGates) {
      commands.push(
        command({
          category: 'Quality gates',
          id: `gate:remove:${gate.id}`,
          keywords: [gate.id, gate.kind, 'unregister remove delete disable'],
          label: `Unregister Quality Gate: ${gate.id}`,
          run: async () => {
            await actions.unregisterQualityGate(gate.id);
          },
        }),
      );
    }
    commands.push(
      command({
        category: 'Quality gates',
        id: 'gate:config:import',
        keywords: ['gate config import trust root json file'],
        label: 'Import Quality Gate configuration…',
        run: () => {
          void actions.importQualityGateConfig();
        },
      }),
    );
    if (context.qualityGates.length > 0) {
      commands.push(
        command({
          category: 'Quality gates',
          id: 'gate:config:export',
          keywords: ['gate config export save json file'],
          label: 'Export Quality Gate configuration…',
          run: () => {
            void actions.exportQualityGateConfig();
          },
        }),
      );
    }
  }

  if (!context.actionBusy && selected.canProduceArtifact) {
    commands.push(
      command({
        category: 'Task',
        id: 'artifact:produce',
        keywords: ['artifact produce capture summary plan review'],
        label: 'Produce artifact',
        run: () => {
          void actions.produceArtifact({
            content: '',
            createdAt: context.now,
            id: `palette-${String(context.now)}`,
            kind: 'execution-summary',
            sessionId: undefined,
            taskId: selected.id,
          });
        },
      }),
    );
  }

  if (!context.actionBusy) {
    const requiredCandidates = context.tasks.filter((task) => task.id !== selected.id);
    const firstUnmet = requiredCandidates.find(
      (task) => !selected.dependencies.some((dependency) => dependency.id === task.id),
    );
    if (firstUnmet !== undefined) {
      commands.push(
        command({
          category: 'Task',
          id: `dependency:require:${firstUnmet.id}`,
          keywords: [
            firstUnmet.id,
            firstUnmet.title,
            'dependency require block chain',
          ],
          label: `Require task: ${firstUnmet.title}`,
          run: () => void actions.addDependency(firstUnmet.id, selected.id),
        }),
      );
    }
    if (selected.dependencies.length > 0) {
      const firstMet = selected.dependencies[0]!;
      commands.push(
        command({
          category: 'Task',
          id: `dependency:remove:${firstMet.id}`,
          keywords: [
            firstMet.id,
            firstMet.title,
            'dependency remove unrequire release',
          ],
          label: `Remove required task: ${firstMet.title}`,
          run: () => void actions.removeDependency(firstMet.id, selected.id),
        }),
      );
    }
  }

  if (!context.actionBusy && selected.canRunQualityGate) {
    commands.push(
      command({
        category: 'Quality gates',
        id: 'gate:register',
        keywords: ['register add create new quality gate check validation'],
        label: 'Register Quality Gate',
        run: () => actions.focus('checks'),
      }),
    );
  }

  return Object.freeze(commands);

  function focusCommand(
    id: string,
    label: string,
    keywords: readonly string[],
    shortcut: string | undefined,
    target: WorkspaceFocusTarget,
  ): WorkspaceCommand {
    return command({
      category: 'Navigate',
      id,
      keywords,
      label,
      run: () => actions.focus(target),
      ...(shortcut === undefined ? {} : { shortcut }),
    });
  }
}

export function filterWorkspaceCommands(
  commands: readonly WorkspaceCommand[],
  query: string,
): readonly WorkspaceCommand[] {
  const terms = normalizeSearch(query).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) {
    return commands;
  }
  return commands.filter((candidate) => {
    const haystack = normalizeSearch(
      [candidate.label, candidate.category, candidate.id, ...candidate.keywords].join(' '),
    );
    return terms.every((term) => haystack.includes(term));
  });
}

export function reduceCommandPalette(
  state: CommandPaletteState,
  action: CommandPaletteAction,
  resultCount: number,
): CommandPaletteState {
  switch (action.kind) {
    case 'OPEN':
      return Object.freeze({ activeIndex: resultCount === 0 ? -1 : 0, open: true, query: '' });
    case 'CLOSE':
      return initialCommandPaletteState;
    case 'SEARCH':
      return Object.freeze({
        activeIndex: resultCount === 0 ? -1 : 0,
        open: state.open,
        query: action.query,
      });
    case 'MOVE':
      if (resultCount === 0) {
        return Object.freeze({ ...state, activeIndex: -1 });
      }
      return Object.freeze({
        ...state,
        activeIndex: (state.activeIndex + action.delta + resultCount) % resultCount,
      });
  }
}

export function resolveWorkspaceGlobalShortcut(
  input: WorkspaceShortcutInput,
): WorkspaceGlobalShortcut | undefined {
  const alt = input.altKey === true;
  const ctrl = input.ctrlKey === true;
  const meta = input.metaKey === true;
  const shift = input.shiftKey === true;

  if (!alt && ctrl && !meta && shift && input.code === 'KeyP') {
    return 'open-palette';
  }
  if (alt && !ctrl && !meta && ['BracketLeft', 'BracketRight'].includes(input.code)) {
    if (input.code === 'BracketLeft') {
      return shift ? 'previous-pane' : 'previous-tab';
    }
    return shift ? 'next-pane' : 'next-tab';
  }
  if (!alt || ctrl || meta || shift) {
    return undefined;
  }
  switch (input.code) {
    case 'Digit1':
      return 'focus-sidebar';
    case 'Digit2':
      return 'focus-workspace';
    case 'Digit3':
      return 'focus-terminal';
    default:
      return undefined;
  }
}

export function resolveCommandPaletteKey(
  input: CommandPaletteKeyInput,
): CommandPaletteAction | 'RUN' | undefined {
  if (input.isComposing === true) {
    return undefined;
  }
  switch (input.key) {
    case 'ArrowDown':
      return { delta: 1, kind: 'MOVE' };
    case 'ArrowUp':
      return { delta: -1, kind: 'MOVE' };
    case 'Enter':
      return 'RUN';
    case 'Escape':
      return { kind: 'CLOSE' };
    default:
      return undefined;
  }
}

function command(input: WorkspaceCommand): WorkspaceCommand {
  return Object.freeze({ ...input, keywords: Object.freeze([...input.keywords]) });
}

function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Mark}/gu, '')
    .replace(/đ/gu, 'd')
    .replace(/Đ/gu, 'D')
    .toLocaleLowerCase('vi')
    .trim();
}
