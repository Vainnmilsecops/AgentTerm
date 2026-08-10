import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name: string;
  peerDependencies?: Record<string, string>;
};

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const packages = {
  'apps/desktop': ['@agentterm/application', '@agentterm/shared'],
  'apps/website': [],
  'packages/application': ['@agentterm/domain'],
  'packages/config': [],
  'packages/domain': [],
  'packages/infrastructure': ['@agentterm/application', '@agentterm/domain', '@agentterm/shared'],
  'packages/shared': [],
} as const;

function readManifest(relativePath: string): Manifest {
  const path = resolve(workspaceRoot, relativePath, 'package.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

function internalDependencies(manifest: Manifest): string[] {
  const dependencyGroups = [
    manifest.dependencies ?? {},
    manifest.devDependencies ?? {},
    manifest.peerDependencies ?? {},
  ];

  return dependencyGroups
    .flatMap((dependencies) => Object.keys(dependencies))
    .filter((dependency) => dependency.startsWith('@agentterm/'))
    .sort();
}

describe('workspace dependency direction', () => {
  it.each(Object.entries(packages))(
    '%s only declares allowed AgentTerm dependencies',
    (path, allowed) => {
      const manifest = readManifest(path);

      expect(internalDependencies(manifest)).toEqual([...allowed].sort());
    },
  );
});
