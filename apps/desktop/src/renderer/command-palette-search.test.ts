import { describe, expect, it } from 'vitest';

import {
  fuzzyScore,
  groupCommandsByCategory,
  rankByFuzzyScore,
  type CommandWithRun,
} from './command-palette-search';

const COMMANDS = [
  {
    category: 'Navigate',
    id: 'focus:sidebar',
    keywords: ['projects'],
    label: 'Focus Sidebar',
    run: () => undefined,
  },
  {
    category: 'Task',
    id: 'task:42',
    keywords: [],
    label: 'Open Task: Refactor auth',
    run: () => undefined,
  },
  {
    category: 'Quality gates',
    id: 'gate:test',
    keywords: [],
    label: 'Run TEST: unit',
    run: () => undefined,
  },
  {
    category: 'Navigate',
    id: 'open:artifacts',
    keywords: ['evidence'],
    label: 'Open Artifacts',
    run: () => undefined,
  },
] as const;

describe('fuzzyScore', () => {
  it('returns 0 when no characters match', () => {
    expect(fuzzyScore('Open Artifacts', 'xyz')).toBe(0);
  });

  it('rewards consecutive matches and word boundaries', () => {
    const consecutive = fuzzyScore('Open Artifact', 'open');
    const scattered = fuzzyScore('Ond Pe n Artifact', 'open');
    expect(consecutive).toBeGreaterThan(0);
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it('is case-insensitive and ignores diacritics', () => {
    expect(fuzzyScore('Kiểm tra chất lượng', 'kiem tra')).toBeGreaterThan(0);
    expect(fuzzyScore('KIỂM TRA', 'kiem')).toBeGreaterThan(0);
  });

  it('rewards matches at the start of the label', () => {
    const start = fuzzyScore('Open Terminal', 'op');
    const middle = fuzzyScore('OOpp', 'op');
    expect(start).toBeGreaterThan(middle);
  });
});

describe('rankByFuzzyScore', () => {
  it('returns commands sorted by score desc and stable on ties', () => {
    const result = rankByFuzzyScore(COMMANDS, 'art');
    expect(result[0]?.id).toBe('open:artifacts');
  });

  it('returns full list when query is empty', () => {
    const result = rankByFuzzyScore(COMMANDS, '');
    expect(result.length).toBe(COMMANDS.length);
    expect(result[0]?.id).toBe('focus:sidebar');
  });

  it('filters out commands with zero score', () => {
    const result = rankByFuzzyScore(COMMANDS, 'nonexistent');
    expect(result.length).toBe(0);
  });
});

describe('groupCommandsByCategory', () => {
  it('preserves category order as encountered', () => {
    const ranked: CommandWithRun[] = COMMANDS.map((command) => ({ ...command, score: 1 }));
    const groups = groupCommandsByCategory(ranked);
    expect(groups.map((group) => group.category)).toEqual(['Navigate', 'Task', 'Quality gates']);
  });

  it('preserves inner order within each group', () => {
    const ranked: CommandWithRun[] = [
      { ...COMMANDS[0], score: 3 },
      { ...COMMANDS[3], score: 2 },
      { ...COMMANDS[1], score: 1 },
    ];
    const groups = groupCommandsByCategory(ranked);
    const navigate = groups.find((group) => group.category === 'Navigate');
    expect(navigate?.commands.map((command) => command.id)).toEqual([
      'focus:sidebar',
      'open:artifacts',
    ]);
  });
});
