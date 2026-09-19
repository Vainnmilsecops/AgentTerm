import { describe, expect, it } from 'vitest';
import { GeminiAdapter } from './agent/gemini-adapter';
describe('Gemini context prompt policy', () => {
  it('uses explicit generated relative file references, never a directory or auto-submit', () => {
    const path = 'agentterm-context/550e8400-e29b-41d4-a716-446655440000.txt';
    const prompt = new GeminiAdapter().buildContextPrompt([
      { relativePath: path, mime: 'text/plain' },
    ]);
    expect(prompt).toContain('@' + path);
    expect([...prompt].some((character) => [10, 13, 27].includes(character.charCodeAt(0)))).toBe(false);
  });
  it.each([
    '../secret',
    'C:/secret',
    'agentterm-context/a.txt\n!evil',
    'agentterm-context/',
    'agentterm-context/a.txt;evil',
  ])('rejects path %s', (relativePath) => {
    expect(() =>
      new GeminiAdapter().buildContextPrompt([{ relativePath, mime: 'text/plain' }]),
    ).toThrow();
  });
});
