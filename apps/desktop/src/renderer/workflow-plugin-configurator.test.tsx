import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import type {
  InstallWorkflowPluginRequest,
  InstallWorkflowPluginResponse,
  SelectWorkflowPluginPathResponse,
} from '../ipc-contract';

import {
  WorkflowPluginConfigurator,
  type InstalledWorkflowPluginSummary,
} from './workflow-plugin-configurator';

function renderConfigurator(
  overrides: Partial<{
    busy: boolean;
    disabledReason: string | undefined;
    error: string | undefined;
    installed: readonly InstalledWorkflowPluginSummary[];
    onInstall: (input: InstallWorkflowPluginRequest) => Promise<InstallWorkflowPluginResponse>;
    onSelectPath: () => Promise<SelectWorkflowPluginPathResponse>;
    selectedTaskId: string | undefined;
  }> = {},
): string {
  const props = {
    busy: overrides.busy ?? false,
    disabledReason: overrides.disabledReason,
    error: overrides.error,
    installed: overrides.installed ?? Object.freeze([]),
    onInstall:
      overrides.onInstall ?? (async () => ({
        activePhaseId: '',
        bindingRevision: 0,
        pluginId: '',
        pluginName: '',
        sourcePath: 'C:/trusted/plugin.json',
      })),
    onSelectPath:
      overrides.onSelectPath ?? (async () => ({ path: undefined, result: 'CANCELLED' as const })),
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
    expect(html).toContain('disabled=""');
    expect(html).toContain('Select a task to install or remove workflow plugin bindings.');
  });

  it('lists installed bindings with their active phase id and revision', () => {
    const installed = Object.freeze([
      {
        activePhaseId: 'planning',
        bindingRevision: 3,
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
  });

  it('surfaces server error messages', () => {
    const html = renderConfigurator({ error: 'PATH_NOT_TRUSTED: refused' });
    expect(html).toContain('PATH_NOT_TRUSTED: refused');
    expect(html).toContain('role="alert"');
  });
});
