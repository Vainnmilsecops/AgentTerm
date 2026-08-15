import {
  listMcpProjects,
  listMcpTasks,
  readMcpPaneContent,
  readMcpTask,
  type McpReadOnlyViewDependencies,
} from '@agentterm/application';

import type { McpToolHandler } from '../server';
import { MCP_TOOL_DEFINITIONS, type McpToolDefinition } from '../protocol';

export function buildReadOnlyHandlers(
  dependencies: McpReadOnlyViewDependencies,
): Readonly<Record<string, McpToolHandler>> {
  const definitions = collectDefinitions();
  return {
    'get-task': {
      definition: definitions.get('get-task') as McpToolDefinition,
      async invoke(params: Readonly<Record<string, unknown>>) {
        const taskId = requireString(params.taskId, 'taskId');
        const detail = await readMcpTask(dependencies, { taskId });
        return detail ?? null;
      },
    },
    'list-projects': {
      definition: definitions.get('list-projects') as McpToolDefinition,
      async invoke(params: Readonly<Record<string, unknown>>) {
        const limit = optionalNumber(params.limit);
        const projects = await listMcpProjects(dependencies, limit === undefined ? {} : { limit });
        return projects;
      },
    },
    'list-tasks': {
      definition: definitions.get('list-tasks') as McpToolDefinition,
      async invoke(params: Readonly<Record<string, unknown>>) {
        const projectId = optionalString(params.projectId);
        const limit = optionalNumber(params.limit);
        return listMcpTasks(dependencies, {
          ...(projectId === undefined ? {} : { projectId }),
          ...(limit === undefined ? {} : { limit }),
        });
      },
    },
    'read-pane-content': {
      definition: definitions.get('read-pane-content') as McpToolDefinition,
      async invoke(params: Readonly<Record<string, unknown>>) {
        const sessionId = requireString(params.sessionId, 'sessionId');
        const maximumLines = optionalNumber(params.maximumLines);
        return readMcpPaneContent(dependencies, {
          ...(maximumLines === undefined ? {} : { maximumLines }),
          sessionId,
        });
      },
    },
  };
}

function collectDefinitions(): ReadonlyMap<string, McpToolDefinition> {
  const map = new Map<string, McpToolDefinition>();
  for (const definition of MCP_TOOL_DEFINITIONS) {
    map.set(definition.name, definition);
  }
  return map;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`MCP parameter '${field}' must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new TypeError('MCP string parameter must be a string.');
  }
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('MCP numeric parameter must be a finite number.');
  }
  return value;
}