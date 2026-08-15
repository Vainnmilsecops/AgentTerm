import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrateSqliteDatabase } from "./sqlite/migrate";
import { SqliteWorkflowPluginBindingRepository } from "./sqlite/workflow-plugin-bindings";
import { createBuiltInAgtxPlugin } from "./workflow/builtin/agtx";
import { createBuiltInVoidPlugin } from "./workflow/builtin/void";
import { createWorkflowPluginConfigurator } from "./workflow/plugin-configurator";

interface FakeFileSystem {
  readText(path: string): string | undefined;
  resolveRealPath(path: string): string | undefined;
}

type DatabaseSync = import("node:sqlite").DatabaseSync;
type NodeSqliteModule = typeof import("node:sqlite");
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as NodeSqliteModule;

describe("createWorkflowPluginConfigurator", () => {
  it("returns PATH_NOT_TRUSTED for paths outside the trust root", async () => {
    const configurator = createWorkflowPluginConfigurator({
      fileSystem: {
        readText: () => undefined,
        resolveRealPath: () => undefined,
      },
      trustRoots: ["C:/trusted/plugins"],
    });
    const result = await configurator.load({
      path: "C:/anywhere/outside/plugin.json",
    });
    expect(result.failure).toBe("PATH_NOT_TRUSTED");
    expect(result.value).toBeUndefined();
  });

  it("returns PATH_UNREADABLE when the trusted file does not exist", async () => {
    const trustRoot = "C:/trusted";
    const fs: FakeFileSystem = {
      readText: () => undefined,
      resolveRealPath: (path: string) => path,
    };
    const configurator = createWorkflowPluginConfigurator({
      fileSystem: fs,
      trustRoots: [trustRoot],
    });
    const result = await configurator.load({
      path: join(trustRoot, "missing.json"),
    });
    expect(result.failure).toBe("PATH_UNREADABLE");
  });

  it("returns INVALID_FORMAT for malformed JSON", async () => {
    const trustRoot = "C:/trusted";
    const fs: FakeFileSystem = {
      readText: () => "{ this is not json",
      resolveRealPath: (path: string) => path,
    };
    const result = await loadWith(
      trustRoot,
      join(trustRoot, "malformed.json"),
      fs,
    );
    expect(result.failure).toBe("INVALID_FORMAT");
  });

  it("returns INVALID_FORMAT when the inner plugin fails Domain validation", async () => {
    const trustRoot = "C:/trusted";
    const body = JSON.stringify({
      plugin: {
        id: "BAD ID!",
        name: "bad",
        phases: [],
      },
      revision: "r1",
    });
    const fs: FakeFileSystem = {
      readText: () => body,
      resolveRealPath: (path: string) => path,
    };
    const result = await loadWith(
      trustRoot,
      join(trustRoot, "bad-id.json"),
      fs,
    );
    expect(result.failure).toBe("INVALID_FORMAT");
  });

  it("returns the validated Domain plugin when the file is well-formed", async () => {
    const trustRoot = "C:/trusted";
    const plugin = createBuiltInAgtxPlugin();
    const body = JSON.stringify({
      plugin: {
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        phases: plugin.phases.map((phase) => ({
          id: phase.id,
          artifactHeading: phase.artifactContract.heading,
          artifactKind: phase.artifactContract.kind,
          promptTemplate: phase.kickoff.promptTemplate,
          requiredHeadings: phase.artifactContract.requiredHeadings.map(
            (item) => item.heading,
          ),
        })),
      },
      revision: "r-stable",
    });
    const fs: FakeFileSystem = {
      readText: () => body,
      resolveRealPath: (path: string) => path,
    };
    const result = await loadWith(
      trustRoot,
      join(trustRoot, "agtx-stable.json"),
      fs,
    );
    expect(result.failure).toBeUndefined();
    expect(result.value?.plugin.id).toBe("agtx");
    expect(result.value?.plugin.phases.map((phase) => phase.id)).toEqual([
      "research",
      "planning",
      "running",
      "review",
    ]);
    expect(result.value?.revision).toBe("r-stable");
  });
});

describe("SqliteWorkflowPluginBindingRepository", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "agentterm-plugin-bindings-"));
  const databasePath = join(fixtureRoot, "agentterm.db");
  let database: DatabaseSync;
  let repository: SqliteWorkflowPluginBindingRepository;

  beforeAll(() => {
    database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: false,
    });
    database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA trusted_schema = OFF;
    `);
    migrateSqliteDatabase(database);
    repository = new SqliteWorkflowPluginBindingRepository(database);
  });

  afterAll(() => {
    database.close();
    rmSync(fixtureRoot, { force: true, recursive: true });
  });

  it("writes, reads, and removes a binding", async () => {
    const record = Object.freeze({
      activePhaseId: "planning",
      installedAt: 1_700_000_000_000,
      pluginId: "agtx",
      revision: 1,
      sourcePath: "C:/plugins/agtx.json",
      taskId: "task-bind-1",
    });
    await repository.upsert(record, 0);
    const read = await repository.findByTaskId("task-bind-1");
    expect(read).toEqual(record);

    const updated = Object.freeze({
      ...record,
      revision: 2,
      activePhaseId: "running",
    });
    await repository.upsert(updated, 1);
    const readAfter = await repository.findByTaskId("task-bind-1");
    expect(readAfter?.revision).toBe(2);
    expect(readAfter?.activePhaseId).toBe("running");

    const removal = await repository.removeByTaskId("task-bind-1");
    expect(removal).toBe(true);
    const removed = await repository.findByTaskId("task-bind-1");
    expect(removed).toBeUndefined();
  });

  it("rejects upsert when the expected revision no longer matches", async () => {
    const record = Object.freeze({
      activePhaseId: "planning",
      installedAt: 1_700_000_000_000,
      pluginId: "agtx",
      revision: 1,
      sourcePath: "C:/plugins/agtx.json",
      taskId: "task-bind-2",
    });
    await repository.upsert(record, 0);
    await expect(repository.upsert(record, 99)).rejects.toThrow(
      /changed in another window/i,
    );
  });
});

async function loadWith(
  trustRoot: string,
  path: string,
  fileSystem: FakeFileSystem,
): Promise<
  import("@agentterm/application").WorkflowPluginConfiguratorResult<
    import("@agentterm/application").WorkflowPluginConfiguration
  >
> {
  const configurator = createWorkflowPluginConfigurator({
    fileSystem,
    trustRoots: [trustRoot],
  });
  return configurator.load({ path });
}

describe("built-in plugins", () => {
  it("void plugin declares exactly one planning phase", () => {
    const plugin = createBuiltInVoidPlugin();
    expect(plugin.id).toBe("void");
    expect(plugin.phases).toHaveLength(1);
    expect(plugin.phases[0]?.id).toBe("planning");
  });

  it("agtx plugin declares four phases with stable identifiers", () => {
    const plugin = createBuiltInAgtxPlugin();
    expect(plugin.id).toBe("agtx");
    expect(plugin.phases.map((phase) => phase.id)).toEqual([
      "research",
      "planning",
      "running",
      "review",
    ]);
  });
});
