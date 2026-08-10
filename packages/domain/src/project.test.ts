import { describe, expect, it } from 'vitest';

import { createProject } from './index';

describe('createProject', () => {
  it('creates a project from valid identity data', () => {
    expect(createProject({ id: 'project-1', name: 'AgentTerm' })).toEqual({
      id: 'project-1',
      name: 'AgentTerm',
    });
  });

  it.each([
    { id: '', name: 'AgentTerm' },
    { id: '   ', name: 'AgentTerm' },
    { id: 'project-1', name: '' },
    { id: 'project-1', name: '   ' },
  ])('rejects blank identity data: $id / $name', (input) => {
    expect(() => createProject(input)).toThrow(TypeError);
  });
});
