import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const ipcContract = readFileSync(new URL('./ipc-contract.ts', import.meta.url), 'utf8');
const desktopBridge = readFileSync(new URL('./desktop-bridge.ts', import.meta.url), 'utf8');
const desktopApplication = readFileSync(
  new URL('./desktop-application.ts', import.meta.url),
  'utf8',
);
const desktopMainHandlers = readFileSync(
  new URL('./desktop-main-handlers.ts', import.meta.url),
  'utf8',
);
const applicationIndex = readFileSync(
  new URL('../../../packages/application/src/index.ts', import.meta.url),
  'utf8',
);
const workspaceSource = readFileSync(
  new URL('./renderer/agent-workspace.tsx', import.meta.url),
  'utf8',
);
const workspaceController = readFileSync(
  new URL('./renderer/workspace-controller.ts', import.meta.url),
  'utf8',
);
const artifactProducer = readFileSync(
  new URL('./renderer/artifact-producer.tsx', import.meta.url),
  'utf8',
);
const infrastructureIndex = readFileSync(
  new URL('../../../packages/infrastructure/src/index.ts', import.meta.url),
  'utf8',
);

describe('desktop IPC workflow-gaps contract', () => {
  it('exposes artifact production in the desktop IPC channel registry', () => {
    expect(ipcContract).toContain("createArtifact: 'agentterm:artifact:create'");
    expect(ipcContract).toContain('createArtifact(input: CreateArtifactRequest): Promise<ExecutionArtifact>');
    expect(desktopBridge).toContain('createArtifact: (input) => invoke(desktopIpcChannels.createArtifact, input)');
    expect(desktopMainHandlers).toContain('case desktopIpcChannels.createArtifact:');
    expect(desktopApplication).toContain('createArtifact: async (input) =>');
  });

  it('exposes addTaskDependency and removeTaskDependency in the desktop IPC channel registry', () => {
    expect(ipcContract).toContain("addTaskDependency: 'agentterm:task-dependency:add'");
    expect(ipcContract).toContain("removeTaskDependency: 'agentterm:task-dependency:remove'");
    expect(ipcContract).toContain("listTaskDependencies: 'agentterm:task-dependency:list'");
    expect(ipcContract).toContain('addTaskDependency(input: TaskDependencyEdgeRequest): Promise<TaskDependency>');
    expect(ipcContract).toContain('removeTaskDependency(input: TaskDependencyEdgeRequest): Promise<boolean>');
    expect(desktopBridge).toContain('addTaskDependency: (input) => invoke(desktopIpcChannels.addTaskDependency, input)');
    expect(desktopBridge).toContain('removeTaskDependency: (input) => invoke(desktopIpcChannels.removeTaskDependency, input)');
    expect(desktopBridge).toContain('listTaskDependencies: (input) => invoke(desktopIpcChannels.listTaskDependencies, input)');
    expect(desktopMainHandlers).toContain('case desktopIpcChannels.addTaskDependency:');
    expect(desktopMainHandlers).toContain('case desktopIpcChannels.removeTaskDependency:');
    expect(desktopMainHandlers).toContain('case desktopIpcChannels.listTaskDependencies:');
  });

  it('exposes listProjectTasks so dependency pickers can enumerate same-Project Tasks', () => {
    expect(ipcContract).toContain("listProjectTasks: 'agentterm:project-tasks:list'");
    expect(ipcContract).toContain('listProjectTasks(input: ProjectTasksRequest): Promise<readonly Task[]>');
    expect(desktopBridge).toContain('listProjectTasks: (input) => invoke(desktopIpcChannels.listProjectTasks, input)');
    expect(desktopMainHandlers).toContain('case desktopIpcChannels.listProjectTasks:');
    expect(applicationIndex).toContain('listProjectTasks');
  });

  it('exposes registerQualityGate and unregisterQualityGate for trusted Quality Gate configuration', () => {
    expect(ipcContract).toContain("registerQualityGate: 'agentterm:quality-gates:register'");
    expect(ipcContract).toContain("unregisterQualityGate: 'agentterm:quality-gates:unregister'");
    expect(ipcContract).toContain('registerQualityGate(input: QualityGateRegistrationRequest): Promise<void>');
    expect(ipcContract).toContain('unregisterQualityGate(input: QualityGateIdRequest): Promise<boolean>');
    expect(desktopBridge).toContain('registerQualityGate: (input) => invokeVoid(desktopIpcChannels.registerQualityGate, input)');
    expect(desktopBridge).toContain('unregisterQualityGate: (input) => invoke(desktopIpcChannels.unregisterQualityGate, input)');
    expect(desktopMainHandlers).toContain('case desktopIpcChannels.registerQualityGate:');
    expect(desktopMainHandlers).toContain('case desktopIpcChannels.unregisterQualityGate:');
    expect(desktopApplication).toContain('qualityGateCatalog');
    expect(desktopApplication).toContain('JsonFileQualityGateCatalog');
    expect(infrastructureIndex).toContain('JsonFileQualityGateCatalog');
  });

  it('exposes listTaskReviews so the desktop surfaces immutable Review evidence', () => {
    expect(ipcContract).toContain("listTaskReviews: 'agentterm:review:list'");
    expect(ipcContract).toContain('listTaskReviews(input: TaskRequest): Promise<readonly TaskReviewSummary[]>');
    expect(desktopBridge).toContain('listTaskReviews: (input) => invoke(desktopIpcChannels.listTaskReviews, input)');
    expect(desktopMainHandlers).toContain('case desktopIpcChannels.listTaskReviews:');
  });

  it('validates createArtifact requests against required Markdown headings and bounds', () => {
    expect(ipcContract).toContain('readExecutionArtifactKind');
    expect(ipcContract).toContain('readQualityGateKind');
    expect(ipcContract).toContain('readStringArray');
  });

  it('renders the ArtifactProducer form inside the selected Task workspace', () => {
    expect(workspaceSource).toContain('ArtifactProducer');
    expect(workspaceSource).toContain('onProduceArtifact={');
    expect(artifactProducer).toContain('data-artifact-producer');
    expect(artifactProducer).toContain('data-artifact-submit');
    expect(artifactProducer).toContain('data-artifact-kind');
    expect(artifactProducer).toContain('data-artifact-content');
    expect(artifactProducer).toContain('data-artifact-session');
  });

  it('routes the renderer produceArtifact call through the controller and bridge', () => {
    expect(workspaceController).toContain('produceArtifact');
    expect(workspaceController).toContain("case 'produce-artifact':");
    expect(workspaceController).toContain('client.createArtifact');
    expect(desktopBridge).toContain('createArtifact:');
  });

  it('exposes listQualityGateDetails so the renderer can populate the full Quality Gate form', () => {
    expect(ipcContract).toContain("listQualityGateDetails: 'agentterm:quality-gates:list-details'");
    expect(ipcContract).toContain('listQualityGateDetails(): Promise<readonly QualityGate[]>');
    expect(desktopBridge).toContain('listQualityGateDetails: () => invoke(desktopIpcChannels.listQualityGateDetails, {})');
    expect(desktopMainHandlers).toContain('case desktopIpcChannels.listQualityGateDetails:');
    expect(desktopApplication).toContain('listQualityGateDetails:');
  });

  it('routes register/unregister through the controller and QualityGateConfiguration form', () => {
    expect(workspaceController).toContain('registerQualityGate');
    expect(workspaceController).toContain('unregisterQualityGate');
    expect(workspaceController).toContain('client.listQualityGateDetails');
    expect(workspaceSource).toContain('QualityGateConfiguration');
    expect(workspaceSource).toContain('qualityGateConfig');
  });
});