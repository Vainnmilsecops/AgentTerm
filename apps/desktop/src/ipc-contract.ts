import type {
  AgentSessionTerminalAttachment,
  AgentWorkspaceOverview,
  ApplicationSettingsView,
  AttachAgentSessionTerminalInput,
  GetTaskFileDiffInput,
  PtyRuntimeEvent,
  PtyTerminalSize,
  QualityGateSummary,
  TaskChangeSet,
  TaskFileDiff,
  TaskPullRequestState,
  UpdateApplicationSettingsInput,
} from '@agentterm/application';

export const desktopIpcChannels = Object.freeze({
  acceptPlan: 'agentterm:planning:accept',
  approveReview: 'agentterm:review:approve',
  beginTaskPlanning: 'agentterm:task:begin-planning',
  createTask: 'agentterm:task:create',
  createPullRequest: 'agentterm:pull-request:create',
  getTaskFileDiff: 'agentterm:changes:diff',
  inspectPullRequest: 'agentterm:pull-request:inspect',
  listQualityGates: 'agentterm:quality-gates:list',
  listTaskChanges: 'agentterm:changes:list',
  loadSettings: 'agentterm:settings:load',
  loadWorkspace: 'agentterm:workspace:load',
  openProject: 'agentterm:project:open',
  pushTaskBranch: 'agentterm:pull-request:push',
  refreshPullRequest: 'agentterm:pull-request:refresh',
  requestChanges: 'agentterm:review:request-changes',
  requestReview: 'agentterm:review:request',
  retryExecution: 'agentterm:execution:retry',
  runQualityGate: 'agentterm:quality-gates:run',
  startExecution: 'agentterm:execution:start',
  startPlanning: 'agentterm:planning:start',
  terminalAttach: 'agentterm:terminal:attach',
  terminalDetach: 'agentterm:terminal:detach',
  terminalResize: 'agentterm:terminal:resize',
  terminalWrite: 'agentterm:terminal:write',
  updateSettings: 'agentterm:settings:update',
} as const);

export const terminalIpcEventChannel = 'agentterm:terminal:event' as const;

export type DesktopIpcChannel = (typeof desktopIpcChannels)[keyof typeof desktopIpcChannels];

type EmptyRequest = Readonly<Record<string, never>>;

interface TaskRequest {
  readonly taskId: string;
}

interface CreateTaskRequest {
  readonly brief: string;
  readonly projectId: string;
  readonly title: string;
}

export interface CreateDesktopTaskResult {
  readonly taskId: string;
}

export type OpenDesktopProjectResult = 'CANCELLED' | 'OPENED';

interface AgentTaskRequest extends TaskRequest {
  readonly agentId: string;
}

interface ReviewRequest extends TaskRequest {
  readonly reviewId: string;
}

interface PlanRequest extends TaskRequest {
  readonly planId: string;
}

interface QualityGateRequest extends TaskRequest {
  readonly gateId: string;
}

interface PullRequestRefreshRequest extends TaskRequest {
  readonly pullRequestNumber: number;
  readonly repositoryName: string;
  readonly repositoryOwner: string;
}

interface TerminalSubscriptionRequest {
  readonly subscriptionId: string;
}

interface TerminalAttachRequest extends TerminalSubscriptionRequest {
  readonly sessionId: string;
}

interface TerminalWriteRequest extends TerminalSubscriptionRequest {
  readonly data: string;
}

interface TerminalResizeRequest extends PtyTerminalSize, TerminalSubscriptionRequest {}

export interface DesktopIpcRequestMap {
  readonly [desktopIpcChannels.acceptPlan]: PlanRequest;
  readonly [desktopIpcChannels.approveReview]: ReviewRequest;
  readonly [desktopIpcChannels.beginTaskPlanning]: TaskRequest;
  readonly [desktopIpcChannels.createTask]: CreateTaskRequest;
  readonly [desktopIpcChannels.createPullRequest]: TaskRequest;
  readonly [desktopIpcChannels.getTaskFileDiff]: GetTaskFileDiffInput;
  readonly [desktopIpcChannels.inspectPullRequest]: TaskRequest;
  readonly [desktopIpcChannels.listQualityGates]: EmptyRequest;
  readonly [desktopIpcChannels.listTaskChanges]: TaskRequest;
  readonly [desktopIpcChannels.loadSettings]: EmptyRequest;
  readonly [desktopIpcChannels.loadWorkspace]: EmptyRequest;
  readonly [desktopIpcChannels.openProject]: EmptyRequest;
  readonly [desktopIpcChannels.pushTaskBranch]: TaskRequest;
  readonly [desktopIpcChannels.refreshPullRequest]: PullRequestRefreshRequest;
  readonly [desktopIpcChannels.requestChanges]: ReviewRequest;
  readonly [desktopIpcChannels.requestReview]: TaskRequest;
  readonly [desktopIpcChannels.retryExecution]: AgentTaskRequest;
  readonly [desktopIpcChannels.runQualityGate]: QualityGateRequest;
  readonly [desktopIpcChannels.startExecution]: AgentTaskRequest;
  readonly [desktopIpcChannels.startPlanning]: AgentTaskRequest;
  readonly [desktopIpcChannels.terminalAttach]: TerminalAttachRequest;
  readonly [desktopIpcChannels.terminalDetach]: TerminalSubscriptionRequest;
  readonly [desktopIpcChannels.terminalResize]: TerminalResizeRequest;
  readonly [desktopIpcChannels.terminalWrite]: TerminalWriteRequest;
  readonly [desktopIpcChannels.updateSettings]: UpdateApplicationSettingsInput;
}

export interface DesktopIpcResponseMap {
  readonly [desktopIpcChannels.acceptPlan]: null;
  readonly [desktopIpcChannels.approveReview]: null;
  readonly [desktopIpcChannels.beginTaskPlanning]: null;
  readonly [desktopIpcChannels.createTask]: CreateDesktopTaskResult;
  readonly [desktopIpcChannels.createPullRequest]: null;
  readonly [desktopIpcChannels.getTaskFileDiff]: TaskFileDiff;
  readonly [desktopIpcChannels.inspectPullRequest]: TaskPullRequestState;
  readonly [desktopIpcChannels.listQualityGates]: readonly QualityGateSummary[];
  readonly [desktopIpcChannels.listTaskChanges]: TaskChangeSet;
  readonly [desktopIpcChannels.loadSettings]: ApplicationSettingsView;
  readonly [desktopIpcChannels.loadWorkspace]: AgentWorkspaceOverview;
  readonly [desktopIpcChannels.openProject]: OpenDesktopProjectResult;
  readonly [desktopIpcChannels.pushTaskBranch]: null;
  readonly [desktopIpcChannels.refreshPullRequest]: null;
  readonly [desktopIpcChannels.requestChanges]: null;
  readonly [desktopIpcChannels.requestReview]: null;
  readonly [desktopIpcChannels.retryExecution]: null;
  readonly [desktopIpcChannels.runQualityGate]: null;
  readonly [desktopIpcChannels.startExecution]: null;
  readonly [desktopIpcChannels.startPlanning]: null;
  readonly [desktopIpcChannels.terminalAttach]: null;
  readonly [desktopIpcChannels.terminalDetach]: null;
  readonly [desktopIpcChannels.terminalResize]: null;
  readonly [desktopIpcChannels.terminalWrite]: null;
  readonly [desktopIpcChannels.updateSettings]: ApplicationSettingsView;
}

export type DesktopIpcErrorCode =
  | 'CONFLICT'
  | 'INTERNAL_ERROR'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'OPERATION_FAILED'
  | 'UNAUTHORIZED'
  | 'UNAVAILABLE';

export interface DesktopIpcError {
  readonly code: DesktopIpcErrorCode;
  readonly message: string;
}

export type DesktopIpcResponse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly error: DesktopIpcError; readonly ok: false };

export interface TerminalIpcEventMessage {
  readonly event: PtyRuntimeEvent;
  readonly subscriptionId: string;
}

export interface AgentTermDesktopApi {
  acceptTaskPlan(input: PlanRequest): Promise<void>;
  approveTaskReview(input: ReviewRequest): Promise<void>;
  attachTerminal(input: AttachAgentSessionTerminalInput): Promise<AgentSessionTerminalAttachment>;
  beginTaskPlanning(input: TaskRequest): Promise<void>;
  createTask(input: CreateTaskRequest): Promise<CreateDesktopTaskResult>;
  createTaskPullRequest(input: TaskRequest): Promise<void>;
  getTaskFileDiff(input: GetTaskFileDiffInput): Promise<TaskFileDiff>;
  inspectTaskPullRequest(input: TaskRequest): Promise<TaskPullRequestState>;
  listQualityGates(): Promise<readonly QualityGateSummary[]>;
  listTaskChanges(input: TaskRequest): Promise<TaskChangeSet>;
  loadSettings(): Promise<ApplicationSettingsView>;
  loadWorkspace(): Promise<AgentWorkspaceOverview>;
  openProject(): Promise<OpenDesktopProjectResult>;
  pushTaskBranch(input: TaskRequest): Promise<void>;
  refreshTaskPullRequest(input: PullRequestRefreshRequest): Promise<void>;
  requestTaskChanges(input: ReviewRequest): Promise<void>;
  requestTaskReview(input: TaskRequest): Promise<void>;
  retryTaskExecution(input: AgentTaskRequest): Promise<void>;
  runQualityGate(input: QualityGateRequest): Promise<void>;
  startTaskExecution(input: AgentTaskRequest): Promise<void>;
  startTaskPlanning(input: AgentTaskRequest): Promise<void>;
  updateSettings(input: UpdateApplicationSettingsInput): Promise<ApplicationSettingsView>;
}

export class DesktopIpcRequestValidationError extends Error {
  public constructor() {
    super('The desktop request is invalid.');
    this.name = 'DesktopIpcRequestValidationError';
  }
}

const allowedChannels = new Set<DesktopIpcChannel>(Object.values(desktopIpcChannels));
const stableAgentIdPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const subscriptionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const repositoryPartPattern = /^[A-Za-z0-9_.-]{1,255}$/u;
const taskChangeAreas = new Set(['COMMITTED', 'CONFLICTED', 'STAGED', 'UNSTAGED', 'UNTRACKED']);
const maximumIdentityLength = 32_768;
const maximumTerminalMessageLength = 1024 * 1024;

export function validateDesktopIpcRequest<C extends DesktopIpcChannel>(
  channel: C,
  input: unknown,
): DesktopIpcRequestMap[C] {
  if (!allowedChannels.has(channel)) fail();
  switch (channel) {
    case desktopIpcChannels.loadWorkspace:
    case desktopIpcChannels.loadSettings:
    case desktopIpcChannels.listQualityGates:
    case desktopIpcChannels.openProject:
      return exactRecord(input, []) as unknown as DesktopIpcRequestMap[C];
    case desktopIpcChannels.createTask: {
      const record = exactRecord(input, ['brief', 'projectId', 'title']);
      return Object.freeze({
        brief: readTaskBrief(record.brief),
        projectId: readIdentity(record.projectId),
        title: readTaskTitle(record.title),
      }) as DesktopIpcRequestMap[C];
    }
    case desktopIpcChannels.startExecution:
    case desktopIpcChannels.retryExecution:
    case desktopIpcChannels.startPlanning: {
      const record = exactRecord(input, ['agentId', 'taskId']);
      return Object.freeze({
        agentId: readAgentId(record.agentId),
        taskId: readIdentity(record.taskId),
      }) as DesktopIpcRequestMap[C];
    }
    case desktopIpcChannels.acceptPlan: {
      const record = exactRecord(input, ['planId', 'taskId']);
      return Object.freeze({
        planId: readIdentity(record.planId),
        taskId: readIdentity(record.taskId),
      }) as DesktopIpcRequestMap[C];
    }
    case desktopIpcChannels.approveReview:
    case desktopIpcChannels.requestChanges: {
      const record = exactRecord(input, ['reviewId', 'taskId']);
      return Object.freeze({
        reviewId: readIdentity(record.reviewId),
        taskId: readIdentity(record.taskId),
      }) as DesktopIpcRequestMap[C];
    }
    case desktopIpcChannels.runQualityGate: {
      const record = exactRecord(input, ['gateId', 'taskId']);
      return Object.freeze({
        gateId: readIdentity(record.gateId),
        taskId: readIdentity(record.taskId),
      }) as DesktopIpcRequestMap[C];
    }
    case desktopIpcChannels.getTaskFileDiff:
      return readFileDiffRequest(input) as DesktopIpcRequestMap[C];
    case desktopIpcChannels.refreshPullRequest: {
      const record = exactRecord(input, [
        'pullRequestNumber',
        'repositoryName',
        'repositoryOwner',
        'taskId',
      ]);
      return Object.freeze({
        pullRequestNumber: readPositiveSafeInteger(record.pullRequestNumber),
        repositoryName: readRepositoryPart(record.repositoryName),
        repositoryOwner: readRepositoryPart(record.repositoryOwner),
        taskId: readIdentity(record.taskId),
      }) as DesktopIpcRequestMap[C];
    }
    case desktopIpcChannels.updateSettings:
      return readSettingsRequest(input) as DesktopIpcRequestMap[C];
    case desktopIpcChannels.terminalAttach: {
      const record = exactRecord(input, ['sessionId', 'subscriptionId']);
      return Object.freeze({
        sessionId: readIdentity(record.sessionId),
        subscriptionId: readSubscriptionId(record.subscriptionId),
      }) as DesktopIpcRequestMap[C];
    }
    case desktopIpcChannels.terminalDetach: {
      const record = exactRecord(input, ['subscriptionId']);
      return Object.freeze({
        subscriptionId: readSubscriptionId(record.subscriptionId),
      }) as DesktopIpcRequestMap[C];
    }
    case desktopIpcChannels.terminalWrite: {
      const record = exactRecord(input, ['data', 'subscriptionId']);
      return Object.freeze({
        data: readTerminalData(record.data),
        subscriptionId: readSubscriptionId(record.subscriptionId),
      }) as DesktopIpcRequestMap[C];
    }
    case desktopIpcChannels.terminalResize: {
      const record = exactRecord(input, ['columns', 'rows', 'subscriptionId']);
      return Object.freeze({
        columns: readTerminalDimension(record.columns),
        rows: readTerminalDimension(record.rows),
        subscriptionId: readSubscriptionId(record.subscriptionId),
      }) as DesktopIpcRequestMap[C];
    }
    case desktopIpcChannels.createPullRequest:
    case desktopIpcChannels.beginTaskPlanning:
    case desktopIpcChannels.inspectPullRequest:
    case desktopIpcChannels.listTaskChanges:
    case desktopIpcChannels.pushTaskBranch:
    case desktopIpcChannels.requestReview: {
      const record = exactRecord(input, ['taskId']);
      return Object.freeze({ taskId: readIdentity(record.taskId) }) as DesktopIpcRequestMap[C];
    }
  }
}

export function validateTerminalIpcEventMessage(input: unknown): TerminalIpcEventMessage {
  const record = exactRecord(input, ['event', 'subscriptionId']);
  return Object.freeze({
    event: readRuntimeEvent(record.event),
    subscriptionId: readSubscriptionId(record.subscriptionId),
  });
}

function readFileDiffRequest(input: unknown): GetTaskFileDiffInput {
  const record = readRecord(input);
  const keys = Object.keys(record);
  const expected =
    record.previousPath === undefined
      ? ['area', 'path', 'taskId']
      : ['area', 'path', 'previousPath', 'taskId'];
  assertExactKeys(keys, expected);
  if (typeof record.area !== 'string' || !taskChangeAreas.has(record.area)) fail();
  const path = readRepositoryRelativePath(record.path);
  const previousPath =
    record.previousPath === undefined ? undefined : readRepositoryRelativePath(record.previousPath);
  return Object.freeze({
    area: record.area as GetTaskFileDiffInput['area'],
    path,
    ...(previousPath === undefined ? {} : { previousPath }),
    taskId: readIdentity(record.taskId),
  });
}

function readSettingsRequest(input: unknown): UpdateApplicationSettingsInput {
  const record = exactRecord(input, [
    'agentExecutables',
    'defaultAgentId',
    'expectedRevision',
    'terminalFontSize',
  ]);
  if (!Array.isArray(record.agentExecutables) || record.agentExecutables.length > 32) fail();
  const seen = new Set<string>();
  const agentExecutables = record.agentExecutables.map((value) => {
    const executable = exactRecord(value, ['agentId', 'executablePath']);
    const agentId = readAgentId(executable.agentId);
    if (seen.has(agentId)) fail();
    seen.add(agentId);
    return Object.freeze({
      agentId,
      executablePath: readBoundedString(executable.executablePath, maximumIdentityLength),
    });
  });
  const expectedRevision = readNonnegativeSafeInteger(record.expectedRevision);
  const terminalFontSize = record.terminalFontSize;
  if (
    typeof terminalFontSize !== 'number' ||
    !Number.isInteger(terminalFontSize) ||
    terminalFontSize < 8 ||
    terminalFontSize > 32
  ) {
    fail();
  }
  return Object.freeze({
    agentExecutables: Object.freeze(agentExecutables),
    defaultAgentId: readAgentId(record.defaultAgentId),
    expectedRevision,
    terminalFontSize,
  });
}

function readRuntimeEvent(input: unknown): PtyRuntimeEvent {
  const record = readRecord(input);
  const kind = record.kind;
  const sequence = readPositiveSafeInteger(record.sequence);
  if (kind === 'started') {
    assertExactKeys(Object.keys(record), ['kind', 'sequence']);
    return Object.freeze({ kind, sequence });
  }
  if (kind === 'output') {
    assertExactKeys(Object.keys(record), ['data', 'kind', 'sequence']);
    return Object.freeze({
      data: readTerminalData(record.data),
      kind,
      sequence,
    });
  }
  if (kind === 'failed') {
    assertExactKeys(Object.keys(record), ['kind', 'operation', 'reason', 'sequence']);
    const operations = ['cleanup', 'resize', 'runtime', 'spawn', 'terminate', 'write'];
    const reasons = [
      'CONPTY_UNAVAILABLE',
      'INVALID_ARGUMENT',
      'INVALID_ENVIRONMENT',
      'INVALID_EXECUTABLE',
      'INVALID_INPUT',
      'INVALID_TERMINAL_SIZE',
      'INVALID_WORKING_DIRECTORY',
      'NOT_RUNNING',
      'RUNTIME_FAILURE',
      'UNSUPPORTED_PLATFORM',
    ];
    if (
      typeof record.operation !== 'string' ||
      !operations.includes(record.operation) ||
      typeof record.reason !== 'string' ||
      !reasons.includes(record.reason)
    ) {
      fail();
    }
    return Object.freeze({
      kind,
      operation: record.operation as Extract<PtyRuntimeEvent, { kind: 'failed' }>['operation'],
      reason: record.reason as Extract<PtyRuntimeEvent, { kind: 'failed' }>['reason'],
      sequence,
    });
  }
  if (kind === 'exited') {
    const expected =
      record.signal === undefined
        ? ['exitCode', 'kind', 'sequence']
        : ['exitCode', 'kind', 'sequence', 'signal'];
    assertExactKeys(Object.keys(record), expected);
    if (typeof record.exitCode !== 'number' || !Number.isInteger(record.exitCode)) fail();
    if (
      record.signal !== undefined &&
      (typeof record.signal !== 'number' || !Number.isInteger(record.signal))
    )
      fail();
    return Object.freeze({
      exitCode: record.exitCode,
      kind,
      sequence,
      ...(record.signal === undefined ? {} : { signal: record.signal }),
    });
  }
  fail();
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  const record = readRecord(input);
  assertExactKeys(Object.keys(record), expectedKeys);
  return record;
}

function readRecord(input: unknown): Readonly<Record<string, unknown>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail();
  return input as Readonly<Record<string, unknown>>;
}

function assertExactKeys(actual: readonly string[], expected: readonly string[]): void {
  if (
    actual.length !== expected.length ||
    [...actual].sort().some((key, index) => key !== [...expected].sort()[index])
  ) {
    fail();
  }
}

function readIdentity(input: unknown): string {
  return readBoundedString(input, maximumIdentityLength);
}

function readAgentId(input: unknown): string {
  const value = readBoundedString(input, 64);
  if (!stableAgentIdPattern.test(value)) fail();
  return value;
}

function readTaskTitle(input: unknown): string {
  return readBoundedString(input, 512);
}

function readTaskBrief(input: unknown): string {
  const value = readBoundedString(input, 16_384);
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === 0x7f ||
      (codePoint !== undefined &&
        codePoint <= 0x1f &&
        codePoint !== 0x09 &&
        codePoint !== 0x0a &&
        codePoint !== 0x0d)
    ) {
      fail();
    }
  }
  return value;
}

function readSubscriptionId(input: unknown): string {
  if (typeof input !== 'string' || !subscriptionIdPattern.test(input)) fail();
  return input;
}

function readRepositoryPart(input: unknown): string {
  if (typeof input !== 'string' || !repositoryPartPattern.test(input)) fail();
  return input;
}

function readRepositoryRelativePath(input: unknown): string {
  const value = readBoundedString(input, maximumIdentityLength);
  if (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:/u.test(value) ||
    value.split(/[\\/]/u).includes('..')
  ) {
    fail();
  }
  return value;
}

function readTerminalData(input: unknown): string {
  if (typeof input !== 'string' || input.length > maximumTerminalMessageLength) fail();
  return input;
}

function readTerminalDimension(input: unknown): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1 || input > 32_767) fail();
  return input;
}

function readPositiveSafeInteger(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input <= 0) fail();
  return input;
}

function readNonnegativeSafeInteger(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) fail();
  return input;
}

function readBoundedString(input: unknown, maximum: number): string {
  if (
    typeof input !== 'string' ||
    input.trim().length === 0 ||
    input.length > maximum ||
    input.includes('\0')
  ) {
    fail();
  }
  return input;
}

function fail(): never {
  throw new DesktopIpcRequestValidationError();
}
