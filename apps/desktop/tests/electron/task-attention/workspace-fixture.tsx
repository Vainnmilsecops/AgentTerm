import { useState } from 'react';
import type { AgentWorkspaceOverview } from '@agentterm/application';
import {
  AgentWorkspaceView,
  type AgentWorkspaceViewProps,
} from '../../../src/renderer/agent-workspace';
import { createWorkspaceLayout } from '../../../src/renderer/workspace-layout';

/** Only read/navigation actions are allowed in this attention-center journey. */
export function WorkspaceFixture({
  overview,
  onUnexpectedAction,
}: {
  readonly overview: AgentWorkspaceOverview;
  readonly onUnexpectedAction: () => never;
}) {
  const [selectedTaskId, setSelectedTaskId] = useState(overview.projects[0]!.tasks[0]!.task.id);
  const forbidden = onUnexpectedAction;
  const forbiddenAsync = async () => forbidden();
  const props: AgentWorkspaceViewProps = {
    onAcceptPlan: forbidden,
    onAddDependency: forbidden,
    onApproveReview: forbidden,
    onBeginPlanning: forbidden,
    onCreatePullRequest: forbidden,
    onCreateTask: forbidden,
    onProduceArtifact: forbiddenAsync,
    onCloseWorkspacePane: forbidden,
    onCloseWorkspaceTab: forbidden,
    onCycleWorkspacePane: forbidden,
    onCycleWorkspaceTab: forbidden,
    onPushTaskBranch: forbidden,
    onOpenProject: forbidden,
    onRefreshPullRequest: forbidden,
    onRefresh: async () => undefined,
    onRegisterQualityGate: forbiddenAsync,
    onRequestChanges: forbidden,
    onRequestReview: forbidden,
    onRemoveDependency: forbidden,
    onRetry: forbidden,
    onRetryTask: forbidden,
    onRunQualityGate: forbidden,
    onSelectTaskChange: forbidden,
    onSelectTask: setSelectedTaskId,
    onSelectWorkspacePane: forbidden,
    onSelectWorkspaceTab: forbidden,
    onSplitTerminal: forbidden,
    onStartTask: forbidden,
    onStartPlanning: forbidden,
    onStartResearch: forbidden,
    onCaptureBrainstormNote: forbidden,
    onCaptureSweepNote: forbidden,
    onUnregisterQualityGate: forbiddenAsync,
    onImportQualityGateConfig: forbiddenAsync,
    onExportQualityGateConfig: forbiddenAsync,
    workflowPluginBindings: [],
    workflowPluginError: undefined,
    snapshot: {
      kind: 'ready',
      overview,
      selectedTaskId,
      layout: createWorkspaceLayout({ taskId: selectedTaskId }),
      activeAction: undefined,
      actionError: undefined,
      selectedAgentId: undefined,
      terminalSessionId: undefined,
    },
  };
  return <AgentWorkspaceView {...props} />;
}
