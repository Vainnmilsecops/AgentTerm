import {
  listMcpProjects,
  listMcpTasks,
  readMcpPaneContent,
  readMcpTask,
  type McpReadOnlyViewDependencies,
} from '@agentterm/application';

import type { McpToolHandler } from '../server';
import { MCP_TOOL_DEFINITIONS, McpInvalidParamsError, type McpToolDefinition } from '../protocol';

export function buildReadOnlyHandlers(
  dependencies: McpReadOnlyViewDependencies,
): Readonly<Record<string, McpToolHandler>> {
  const definitions = collectDefinitions();
  return {
    'get-task': {
      definition: definitions.get('get-task') as McpToolDefinition,
      async invoke(params: Readonly<Record<string, unknown>>) {
        assertKeys(params, ['taskId']);
        const taskId = requireString(params.taskId, 'taskId');
        const detail = await readMcpTask(dependencies, { taskId });
        return detail ?? null;
      },
    },
    'list-projects': {
      definition: definitions.get('list-projects') as McpToolDefinition,
      async invoke(params: Readonly<Record<string, unknown>>) {
        assertKeys(params, ['limit']);
        const limit = optionalNumber(params.limit, 200);
        const projects = await listMcpProjects(dependencies, limit === undefined ? {} : { limit });
        return projects;
      },
    },
    'list-tasks': {
      definition: definitions.get('list-tasks') as McpToolDefinition,
      async invoke(params: Readonly<Record<string, unknown>>) {
        assertKeys(params, ['projectId', 'limit']);
        const projectId = optionalString(params.projectId);
        const limit = optionalNumber(params.limit, 800);
        return listMcpTasks(dependencies, {
          ...(projectId === undefined ? {} : { projectId }),
          ...(limit === undefined ? {} : { limit }),
        });
      },
    },
    'read-pane-content': {
      definition: definitions.get('read-pane-content') as McpToolDefinition,
      async invoke(params: Readonly<Record<string, unknown>>) {
        assertKeys(params, ['sessionId', 'maximumLines']);
        const sessionId = requireString(params.sessionId, 'sessionId');
        const maximumLines = optionalNumber(params.maximumLines, 800);
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
    map.set(definition.name, {
      ...definition,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    });
  }
  return map;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new McpInvalidParamsError(`MCP parameter '${field}' must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, 'projectId');
}

function optionalNumber(value: unknown, maximum: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new McpInvalidParamsError(
      'MCP count parameter must be a positive integer within its documented limit.',
    );
  }
  return value;
}

function assertKeys(params: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  if (Object.keys(params).some((key) => !allowed.includes(key))) {
    throw new McpInvalidParamsError('Unexpected MCP tool argument.');
  }
}
