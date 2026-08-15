export interface WorkspaceLayoutTabRecord {
  readonly activePaneId: string;
  readonly id: string;
  readonly panes: readonly WorkspaceLayoutPaneRecord[];
  readonly taskId: string;
}

export interface WorkspaceLayoutPaneRecord {
  readonly id: string;
  readonly sessionId: string | undefined;
  readonly taskId: string;
}

export interface WorkspaceLayoutRecord {
  readonly activeTabId: string | undefined;
  readonly tabs: readonly WorkspaceLayoutTabRecord[];
}

export interface WorkspaceLayoutReadModel {
  readonly layout: WorkspaceLayoutRecord;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface WorkspaceLayoutValidationFailure {
  readonly field: 'activeTabId' | 'tab' | 'pane' | 'panes' | 'tabs' | 'top';
  readonly reason: string;
}

export const WORKSPACE_LAYOUT_MAX_TABS = 32;
export const WORKSPACE_LAYOUT_MAX_PANES_PER_TAB = 2;
export const WORKSPACE_LAYOUT_MAX_TAB_ID_LENGTH = 128;
export const WORKSPACE_LAYOUT_MAX_PANE_ID_LENGTH = 128;
export const WORKSPACE_LAYOUT_MAX_TASK_ID_LENGTH = 128;
export const WORKSPACE_LAYOUT_MAX_SESSION_ID_LENGTH = 128;

const stableIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

export class WorkspaceLayoutValidationError extends Error {
  public readonly failures: readonly WorkspaceLayoutValidationFailure[];

  public constructor(failures: readonly WorkspaceLayoutValidationFailure[]) {
    super(workspaceLayoutValidationMessage(failures));
    this.name = 'WorkspaceLayoutValidationError';
    this.failures = Object.freeze([...failures]);
  }
}

export class WorkspaceLayoutConflictError extends Error {
  public constructor(options?: ErrorOptions) {
    super('Workspace Layout changed in another window. Reload and try again.', options);
    this.name = 'WorkspaceLayoutConflictError';
  }
}

export function validateWorkspaceLayoutRecord(
  input: unknown,
): { readonly layout: WorkspaceLayoutRecord } {
  const failures: WorkspaceLayoutValidationFailure[] = [];
  const layout = parseWorkspaceLayout(input, failures);
  if (failures.length > 0) {
    throw new WorkspaceLayoutValidationError(failures);
  }
  return { layout };
}

export function isWorkspaceLayoutRecord(input: WorkspaceLayoutRecord): boolean {
  try {
    validateWorkspaceLayoutRecord(input);
    return true;
  } catch {
    return false;
  }
}

function parseWorkspaceLayout(
  input: unknown,
  failures: WorkspaceLayoutValidationFailure[],
): WorkspaceLayoutRecord {
  const record = readRecord(input, failures, 'top');
  const tabs = parseTabs(record.tabs, failures);
  const activeTabId = parseActiveTabId(record.activeTabId, tabs, failures);
  return Object.freeze({ activeTabId, tabs: Object.freeze(tabs) });
}

function parseTabs(
  value: unknown,
  failures: WorkspaceLayoutValidationFailure[],
): readonly WorkspaceLayoutTabRecord[] {
  if (!Array.isArray(value)) {
    failures.push({ field: 'tabs', reason: 'Tabs must be an array.' });
    return Object.freeze([]);
  }
  if (value.length > WORKSPACE_LAYOUT_MAX_TABS) {
    failures.push({ field: 'tabs', reason: `Too many tabs (max ${WORKSPACE_LAYOUT_MAX_TABS}).` });
    return Object.freeze([]);
  }
  const tabs: WorkspaceLayoutTabRecord[] = [];
  const seenIds = new Set<string>();
  for (const candidate of value) {
    const tab = parseTab(candidate, failures);
    if (tab === undefined) continue;
    if (seenIds.has(tab.id)) {
      failures.push({ field: 'tab', reason: `Duplicate tab id: ${tab.id}.` });
      continue;
    }
    seenIds.add(tab.id);
    tabs.push(tab);
  }
  return tabs;
}

function parseTab(
  input: unknown,
  failures: WorkspaceLayoutValidationFailure[],
): WorkspaceLayoutTabRecord | undefined {
  const record = readRecord(input, failures, 'tab');
  const id = readBoundedId(record.id, 'tab', failures, WORKSPACE_LAYOUT_MAX_TAB_ID_LENGTH);
  const taskId = readBoundedId(record.taskId, 'tab', failures, WORKSPACE_LAYOUT_MAX_TASK_ID_LENGTH);
  const panes = parsePanes(record.panes, failures);
  const activePaneId = parseActivePaneId(record.activePaneId, panes, failures);
  if (id === undefined || taskId === undefined || panes.length === 0) {
    return undefined;
  }
  return Object.freeze({
    activePaneId: activePaneId ?? panes[0]!.id,
    id,
    panes: Object.freeze(panes),
    taskId,
  });
}

function parsePanes(
  value: unknown,
  failures: WorkspaceLayoutValidationFailure[],
): readonly WorkspaceLayoutPaneRecord[] {
  if (!Array.isArray(value)) {
    failures.push({ field: 'panes', reason: 'Panes must be an array.' });
    return Object.freeze([]);
  }
  if (value.length > WORKSPACE_LAYOUT_MAX_PANES_PER_TAB) {
    failures.push({
      field: 'panes',
      reason: `Too many panes per tab (max ${WORKSPACE_LAYOUT_MAX_PANES_PER_TAB}).`,
    });
    return Object.freeze([]);
  }
  const panes: WorkspaceLayoutPaneRecord[] = [];
  const seenIds = new Set<string>();
  for (const candidate of value) {
    const pane = parsePane(candidate, failures);
    if (pane === undefined) continue;
    if (seenIds.has(pane.id)) {
      failures.push({ field: 'pane', reason: `Duplicate pane id: ${pane.id}.` });
      continue;
    }
    seenIds.add(pane.id);
    panes.push(pane);
  }
  return panes;
}

function parsePane(
  input: unknown,
  failures: WorkspaceLayoutValidationFailure[],
): WorkspaceLayoutPaneRecord | undefined {
  const record = readRecord(input, failures, 'pane');
  const id = readBoundedId(record.id, 'pane', failures, WORKSPACE_LAYOUT_MAX_PANE_ID_LENGTH);
  const taskId = readBoundedId(record.taskId, 'pane', failures, WORKSPACE_LAYOUT_MAX_TASK_ID_LENGTH);
  if (id === undefined || taskId === undefined) {
    return undefined;
  }
  const sessionId = parseSessionId(record.sessionId, failures);
  return Object.freeze({ id, sessionId, taskId });
}

function parseSessionId(
  value: unknown,
  failures: WorkspaceLayoutValidationFailure[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    failures.push({ field: 'pane', reason: 'Pane sessionId must be a string when defined.' });
    return undefined;
  }
  if (value.length === 0 || value.length > WORKSPACE_LAYOUT_MAX_SESSION_ID_LENGTH) {
    failures.push({
      field: 'pane',
      reason: `Pane sessionId length must be between 1 and ${WORKSPACE_LAYOUT_MAX_SESSION_ID_LENGTH}.`,
    });
    return undefined;
  }
  if (!stableIdPattern.test(value)) {
    failures.push({ field: 'pane', reason: 'Pane sessionId contains an invalid character.' });
    return undefined;
  }
  return value;
}

function parseActivePaneId(
  value: unknown,
  panes: readonly WorkspaceLayoutPaneRecord[],
  failures: WorkspaceLayoutValidationFailure[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    failures.push({ field: 'pane', reason: 'Tab activePaneId must be a string when defined.' });
    return undefined;
  }
  if (!panes.some((pane) => pane.id === value)) {
    failures.push({ field: 'pane', reason: `Tab activePaneId ${value} does not match a pane.` });
    return undefined;
  }
  return value;
}

function parseActiveTabId(
  value: unknown,
  tabs: readonly WorkspaceLayoutTabRecord[],
  failures: WorkspaceLayoutValidationFailure[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    failures.push({
      field: 'activeTabId',
      reason: 'Workspace activeTabId must be a string when defined.',
    });
    return undefined;
  }
  if (!tabs.some((tab) => tab.id === value)) {
    failures.push({
      field: 'activeTabId',
      reason: `Workspace activeTabId ${value} does not match a tab.`,
    });
    return undefined;
  }
  return value;
}

function readRecord(
  input: unknown,
  failures: WorkspaceLayoutValidationFailure[],
  field: WorkspaceLayoutValidationFailure['field'],
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    failures.push({ field, reason: 'Workspace Layout value must be a plain object.' });
    return {};
  }
  return input as Record<string, unknown>;
}

function readBoundedId(
  value: unknown,
  field: WorkspaceLayoutValidationFailure['field'],
  failures: WorkspaceLayoutValidationFailure[],
  maxLength: number,
): string | undefined {
  if (typeof value !== 'string') {
    failures.push({ field, reason: 'Identifier must be a string.' });
    return undefined;
  }
  if (value.length === 0 || value.length > maxLength) {
    failures.push({
      field,
      reason: `Identifier length must be between 1 and ${maxLength}.`,
    });
    return undefined;
  }
  if (!stableIdPattern.test(value)) {
    failures.push({ field, reason: 'Identifier contains an invalid character.' });
    return undefined;
  }
  return value;
}

function workspaceLayoutValidationMessage(
  failures: readonly WorkspaceLayoutValidationFailure[],
): string {
  if (failures.length === 0) return 'Workspace Layout is invalid.';
  const first = failures[0]!;
  return `Workspace Layout is invalid: ${first.field} – ${first.reason}`;
}
