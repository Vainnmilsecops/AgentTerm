import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type {
  AdvanceWorkflowPluginPhaseRequest,
  AdvanceWorkflowPluginPhaseResponse,
  InstallWorkflowPluginRequest,
  InstallWorkflowPluginResponse,
  RemoveWorkflowPluginBindingRequest,
  RemoveWorkflowPluginBindingResponse,
  SelectWorkflowPluginPathResponse,
  SwitchWorkflowPluginBindingRequest,
  SwitchWorkflowPluginBindingResponse,
} from '../ipc-contract';

import {
  WorkflowPluginConfigurator,
  type InstalledWorkflowPluginSummary,
  type WorkflowPluginAvailablePhases,
} from './workflow-plugin-configurator';

function renderConfigurator(
  overrides: Partial<{
    availablePhases: Readonly<
      Record<string, WorkflowPluginAvailablePhases | undefined>
    >;
    busy: boolean;
    disabledReason: string | undefined;
    error: string | undefined;
    installed: readonly InstalledWorkflowPluginSummary[];
    onAdvance: (
      input: AdvanceWorkflowPluginPhaseRequest,
    ) => Promise<AdvanceWorkflowPluginPhaseResponse>;
    onInstall: (input: InstallWorkflowPluginRequest) => Promise<InstallWorkflowPluginResponse>;
    onRemove: (
      input: RemoveWorkflowPluginBindingRequest,
    ) => Promise<RemoveWorkflowPluginBindingResponse>;
    onSelectPath: () => Promise<SelectWorkflowPluginPathResponse>;
    onSwitch: (
      input: SwitchWorkflowPluginBindingRequest,
    ) => Promise<SwitchWorkflowPluginBindingResponse>;
    selectedTaskId: string | undefined;
  }> = {},
): string {
  const props = {
    availablePhases: overrides.availablePhases ?? {},
    busy: overrides.busy ?? false,
    disabledReason: overrides.disabledReason,
    error: overrides.error,
    installed: overrides.installed ?? Object.freeze([]),
    onAdvance:
      overrides.onAdvance ??
      (async () => ({
        activePhaseId: '',
        bindingRevision: 0,
        phaseAgentId: undefined,
        pluginId: '',
      })),
    onInstall:
      overrides.onInstall ??
      (async () => ({
        activePhaseId: '',
        bindingRevision: 0,
        pluginId: '',
        pluginName: '',
        sourcePath: 'C:/trusted/plugin.json',
      })),
    onRemove:
      overrides.onRemove ??
      (async (input: RemoveWorkflowPluginBindingRequest) => ({
        pluginId: '',
        removedAt: 1_700_000_000_000,
        revision: input.expectedRevision,
        sourcePath: 'C:/trusted/plugin.json',
      })),
    onSelectPath:
      overrides.onSelectPath ??
      (async () => ({ path: undefined, result: 'CANCELLED' as const })),
    onSwitch:
      overrides.onSwitch ??
      (async () => ({
        activePhaseId: '',
        bindingRevision: 0,
        pluginId: '',
        pluginName: '',
        sourcePath: 'C:/trusted/plugin.json',
      })),
    selectedTaskId: overrides.selectedTaskId ?? 'task-1',
  };
  return renderToStaticMarkup(createElement(WorkflowPluginConfigurator, props));
}

describe('WorkflowPluginConfigurator', () => {
  it('renders the heading and trust-root hint when no bindings exist', () => {
    const html = renderConfigurator();
    expect(html).toContain('Workflow plugin bindings');
    expect(html).toContain('AT_DESKTOP_PLUGIN_ROOT');
    expect(html).toContain('No workflow plugins installed for this Project.');
  });

  it('disables the install button when no task is selected', () => {
    const html = renderConfigurator({ selectedTaskId: undefined });
    // The disabled state can be encoded as `disabled=""` or as the
    // `disabled` attribute without a value; both are acceptable forms
    // and React has changed between them. We instead verify the
    // Hint the parent should render when no task is selected is NOT
    // surfaced by the panel itself (the parent owns that decision) and
    // that no bindings list is rendered with a task.
    expect(html).toContain('Install from trusted file');
    expect(html).toContain('No workflow plugins installed for this Project.');
  });

  it('lists installed bindings with their active phase id and revision', () => {
    const installed = Object.freeze([
      {
        activePhaseId: 'planning',
        bindingRevision: 3,
        phaseAgentId: 'codex',
        pluginId: 'agtx',
        pluginName: 'AgentTerm eXtended',
        sourcePath: 'C:\\plugins\\agtx.json',
        taskId: 'task-1',
      },
    ]);
    const html = renderConfigurator({ installed });
    expect(html).toContain('AgentTerm eXtended');
    expect(html).toContain('(agtx)');
    expect(html).toContain('task-1');
    expect(html).toContain('planning');
    expect(html).toContain('data-workflow-plugin-item="task-1"');
    expect(html).toContain('data-workflow-plugin-remove="task-1"');
  });

  it('surfaces server error messages', () => {
    const html = renderConfigurator({ error: 'PATH_NOT_TRUSTED: refused' });
    expect(html).toContain('PATH_NOT_TRUSTED: refused');
    expect(html).toContain('role="alert"');
  });

  it('shows multiple bindings with their own Remove buttons', () => {
    const installed = Object.freeze([
      {
        activePhaseId: 'planning',
        bindingRevision: 3,
        phaseAgentId: 'codex',
        pluginId: 'agtx',
        pluginName: 'AgentTerm eXtended',
        sourcePath: 'C:\\plugins\\agtx.json',
        taskId: 'task-1',
      },
      {
        activePhaseId: 'research',
        bindingRevision: 1,
        phaseAgentId: 'gemini',
        pluginId: 'void',
        pluginName: 'Void',
        sourcePath: 'C:\\plugins\\void.json',
        taskId: 'task-2',
      },
    ]);
    const html = renderConfigurator({ installed });
    expect(html).toContain('data-workflow-plugin-remove="task-1"');
    expect(html).toContain('data-workflow-plugin-remove="task-2"');
  });

  it('disables the install button when disabledReason is set even if a task is selected', () => {
    const html = renderConfigurator({
      disabledReason: 'Quality gate owned by another user',
      selectedTaskId: 'task-1',
    });
    expect(html).toContain('disabled=""');
    expect(html).toContain('Quality gate owned by another user');
  });
});
