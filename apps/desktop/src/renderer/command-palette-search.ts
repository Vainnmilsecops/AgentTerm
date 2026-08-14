export type CommandWithScore = Readonly<{
  category: string;
  id: string;
  keywords: readonly string[];
  label: string;
  readonly run?: () => Promise<void> | void;
  score: number;
  shortcut?: string;
}>;

export type CommandWithRun = Readonly<{
  category: string;
  id: string;
  keywords: readonly string[];
  label: string;
  readonly run: () => Promise<void> | void;
  score: number;
  shortcut?: string;
}>;

interface RankableCommand {
  readonly category: string;
  readonly id: string;
  readonly keywords: readonly string[];
  readonly label: string;
  readonly run?: () => Promise<void> | void;
  readonly shortcut?: string;
}

export function fuzzyScore(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  const normalizedHaystack = normalizeForSearch(haystack);
  const normalizedNeedle = normalizeForSearch(needle);
  if (normalizedHaystack.length === 0 || normalizedNeedle.length === 0) {
    return 0;
  }
  let score = 0;
  let haystackIndex = 0;
  let needleIndex = 0;
  let consecutiveBonus = 0;
  let lastMatchedIndex = -2;
  let gaps = 0;
  while (haystackIndex < normalizedHaystack.length && needleIndex < normalizedNeedle.length) {
    if (normalizedHaystack[haystackIndex] === normalizedNeedle[needleIndex]) {
      score += 1;
      if (haystackIndex === lastMatchedIndex + 1) {
        consecutiveBonus += 2;
        score += consecutiveBonus;
      } else {
        consecutiveBonus = 0;
        gaps += 1;
        score -= Math.max(0, gaps - 1);
      }
      if (haystackIndex === 0 || /\s/u.test(normalizedHaystack[haystackIndex - 1] ?? '')) {
        score += 5;
      }
      lastMatchedIndex = haystackIndex;
      needleIndex += 1;
    }
    haystackIndex += 1;
  }
  if (needleIndex < normalizedNeedle.length) {
    return 0;
  }
  if (haystackIndex - 1 === normalizedHaystack.length - 1) {
    score += 2;
  }
  return Math.max(0, score);
}

export function rankByFuzzyScore(
  commands: readonly RankableCommand[],
  query: string,
): readonly CommandWithRun[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return commands.map((command, index) => ({
      ...command,
      run: command.run ?? (() => undefined),
      score: commands.length - index,
    }));
  }
  const scored: CommandWithRun[] = [];
  for (const command of commands) {
    const haystack = `${command.label} ${command.category} ${command.id} ${command.keywords.join(' ')}`;
    const score = fuzzyScore(haystack, trimmed);
    if (score > 0) {
      scored.push({
        ...command,
        run: command.run ?? (() => undefined),
        score,
      });
    }
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.label.localeCompare(b.label);
  });
  return scored;
}

export interface CommandGroup {
  readonly category: string;
  readonly commands: readonly CommandWithRun[];
}

export function groupCommandsByCategory(
  ranked: readonly CommandWithRun[],
): readonly CommandGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, CommandWithRun[]>();
  for (const command of ranked) {
    const bucket = buckets.get(command.category);
    if (bucket === undefined) {
      order.push(command.category);
      buckets.set(command.category, [command]);
    } else {
      bucket.push(command);
    }
  }
  return order.map((category) => ({ category, commands: buckets.get(category) ?? [] }));
}

function normalizeForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Mark}/gu, '')
    .replace(/đ/gu, 'd')
    .replace(/Đ/gu, 'D')
    .toLocaleLowerCase('vi')
    .trim();
}
