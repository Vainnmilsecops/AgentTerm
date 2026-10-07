// Isolated test process. Uses the built transport and real Application read views.
import { bootstrapMcpServer } from '../../dist/index.js';

const task = { id: 'task-1', projectId: 'project-1', title: 'Kiểm thử MCP 🚀', phase: 'BACKLOG' };
await bootstrapMcpServer({
  authToken: 'fixture-only-grant',
  dependencies: {
    projects: {
      async listRecent() {
        return [{ id: 'project-1', name: 'Fixture', rootPath: 'C:/fixture' }];
      },
    },
    tasks: {
      async listByProjectId(id) {
        return id === 'project-1' ? [task] : [];
      },
    },
    taskRepository: {
      async findById(id) {
        return id === task.id ? task : undefined;
      },
    },
    sessions: {
      async listByTaskId() {
        return [];
      },
    },
    reviews: {
      async listRecentByTaskId() {
        return [];
      },
    },
    paneSnapshots: {
      async readSnapshot() {
        return undefined;
      },
    },
  },
});
