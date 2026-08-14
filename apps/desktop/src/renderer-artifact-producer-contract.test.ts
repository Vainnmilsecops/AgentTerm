import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./renderer/artifact-producer.tsx', import.meta.url), 'utf8');
const stateSource = readFileSync(
  new URL('./renderer/artifact-producer-state.ts', import.meta.url),
  'utf8',
);

describe('artifact producer contract', () => {
  it('is exported as a React component', () => {
    expect(source).toContain('export function ArtifactProducer');
  });

  it('wires kind radios, content textarea, session binding, and a submit button', () => {
    expect(source).toContain('data-artifact-kind');
    expect(source).toContain('data-artifact-content');
    expect(source).toContain('data-artifact-session');
    expect(source).toContain('data-artifact-submit');
  });

  it('returns null for phases that cannot produce artifacts (BACKLOG/DONE)', () => {
    expect(source).toContain('isProducerAvailable');
    expect(source).toMatch(/phase === ['"]PLANNING['"]/);
    expect(source).toMatch(/phase === ['"]RUNNING['"]/);
    expect(source).toMatch(/phase === ['"]REVIEW['"]/);
  });

  it('uses defaultArtifactDraft and validateArtifactDraft from artifact-producer-state', () => {
    expect(source).toContain('defaultArtifactDraft(task, initialKind');
    expect(source).toContain('validateArtifactDraft(draft)');
    expect(stateSource).toContain('selectArtifactKindForPhase');
    expect(stateSource).toContain('validateArtifactDraft');
  });

  it('calls onProduce with a structured payload containing id/content/createdAt/kind/sessionId/taskId', () => {
    expect(source).toContain('content: draft.content');
    expect(source).toContain('createdAt: Date.now()');
    expect(source).toContain('kind: draft.kind');
    expect(source).toContain('sessionId: draft.sessionId');
    expect(source).toContain('taskId: draft.taskId');
    expect(source).toContain('id: draft.id');
  });
});