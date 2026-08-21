/**
 * Pure decision for terminal link provider targets. Centralizes the policy
 * that decides whether a Ctrl+click in the terminal surface opens an external
 * URL, opens a file inside the persisted primary Task Worktree, or is
 * silently dropped.
 *
 * Pure and side-effect-free so renderer tests can assert behavior without
 * instantiating xterm or Git Worktrees. Path validation consumes the supplied
 * `TaskWorktreeRepository` so the renderer never reaches into Domain or
 * Infrastructure.
 */

import type { TaskWorktreeRepository } from './ports';

export interface ResolveTerminalLinkInput {
  /** The text that was Ctrl+clicked, exactly as xterm returned it. */
  readonly linkText: string;
  /** Optional Task id for path resolution; required to resolve file paths. */
  readonly taskId?: string;
}

export type ResolvedTerminalLink =
  | {
      readonly absolutePath: string;
      readonly kind: 'worktree-file';
    }
  | {
      readonly kind: 'none';
      readonly reason: 'EMPTY' | 'OUTSIDE_WORKTREE' | 'TASK_NOT_FOUND' | 'UNSUPPORTED';
    }
  | {
      readonly kind: 'external-url';
      readonly url: string;
    };

export interface ResolveTerminalLinkDependencies {
  readonly taskWorktrees: Pick<TaskWorktreeRepository, 'findByTaskId'>;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`\\)]+/giu;

function normalizeCandidate(raw: string): string {
  let candidate = raw.trim();
  if (
    (candidate.startsWith('"') && candidate.endsWith('"')) ||
    (candidate.startsWith("'") && candidate.endsWith("'")) ||
    (candidate.startsWith('(') && candidate.endsWith(')'))
  ) {
    candidate = candidate.slice(1, -1).trim();
  }
  while (/[)\]}>.,;:!?]+$/u.test(candidate)) {
    candidate = candidate.slice(0, -1);
  }
  return candidate;
}

function tryParseHttpUrl(candidate: string): string | undefined {
  // The shared tsconfig intentionally limits `lib` to ES2022 (no DOM
  // `URL` global), so we validate the scheme manually here.
  const lowered = candidate.toLowerCase();
  let protocol: string;
  let remainder: string;
  if (lowered.startsWith('http://')) {
    protocol = 'http:';
    remainder = candidate.slice('http://'.length);
  } else if (lowered.startsWith('https://')) {
    protocol = 'https:';
    remainder = candidate.slice('https://'.length);
  } else {
    return undefined;
  }
  const authorityEnd = remainder.search(/[/?#]/u);
  const authority = authorityEnd === -1 ? remainder : remainder.slice(0, authorityEnd);
  if (authority.length === 0) return undefined;
  // Authority must contain at least one character and no whitespace.
  if (/\s/u.test(authority)) return undefined;
  return candidate;
}

function stripTrailingPunctuation(value: string): string {
  // Common sentence punctuation that frequently follows URLs in terminal output.
  // Angle brackets and quotes are excluded because they are usually paired
  // delimiters, not URL terminators.
  let end = value.length;
  while (end > 0) {
    const ch = value.charAt(end - 1);
    if (ch === '.' || ch === ',' || ch === ';' || ch === '!' || ch === '?') {
      end -= 1;
      continue;
    }
    break;
  }
  return value.slice(0, end);
}

function extractExternalUrl(text: string): string | undefined {
  // `URL_PATTERN` carries the global flag so `matchAll` is safe and does not
  // retain state between calls.
  for (const candidate of text.matchAll(URL_PATTERN)) {
    const stripped = stripTrailingPunctuation(candidate[0]);
    const url = tryParseHttpUrl(stripped);
    if (url !== undefined) return url;
  }
  return undefined;
}

function isAbsoluteWindowsPath(candidate: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(candidate);
}

function isAbsolutePosixPath(candidate: string): boolean {
  return candidate.startsWith('/');
}

function isAbsolutePath(candidate: string): boolean {
  return isAbsoluteWindowsPath(candidate) || isAbsolutePosixPath(candidate);
}

function normalizeAbsolutePath(candidate: string): string {
  // The resolver deals in textual paths only; canonicalization belongs to the
  // infrastructure adapter that finally opens the file.
  return candidate.replace(/[\\/]+/gu, '/');
}

function candidateFromLine(text: string): string | undefined {
  // Allow the renderer to feed the whole line; we extract the first
  // standalone token that looks like an absolute path.
  const tokens = text.split(/\s+/u);
  for (const token of tokens) {
    const candidate = normalizeCandidate(token);
    if (isAbsolutePath(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Decide which action (if any) a Ctrl+click on the given link text should
 * trigger. The function is pure: same input + same dependencies yield the
 * same output.
 *
 * Rules:
 * - Empty or whitespace-only text resolves to `none/EMPTY`.
 * - HTTP/HTTPS URLs (matched via a constrained regex) resolve to
 *   `external-url`. Anything else, including shell-injection attempts and
 *   unsupported schemes, resolves to `none/UNSUPPORTED`.
 * - Absolute filesystem paths (`C:\...` or `/...`) are only resolved when a
 *   `taskId` is supplied and the worktree repository returns a `PRESENT`
 *   record whose canonical path contains the candidate. Anything else is
 *   silently rejected to keep untrusted path output out of the renderer.
 */
export async function resolveTerminalLinkTarget(
  input: ResolveTerminalLinkInput,
  deps: ResolveTerminalLinkDependencies,
): Promise<ResolvedTerminalLink> {
  if (input.linkText.trim().length === 0) {
    return { kind: 'none', reason: 'EMPTY' };
  }

  const url = extractExternalUrl(input.linkText);
  if (url !== undefined) {
    return { kind: 'external-url', url };
  }

  if (input.taskId === undefined) {
    return { kind: 'none', reason: 'UNSUPPORTED' };
  }

  const record = await deps.taskWorktrees.findByTaskId(input.taskId);
  if (record === undefined) {
    return { kind: 'none', reason: 'TASK_NOT_FOUND' };
  }

  const candidate = candidateFromLine(input.linkText);
  if (candidate === undefined) {
    return { kind: 'none', reason: 'UNSUPPORTED' };
  }

  const worktreeRoot = normalizeAbsolutePath(record.worktreePath);
  const normalizedCandidate = normalizeAbsolutePath(candidate);

  if (
    normalizedCandidate !== worktreeRoot &&
    !normalizedCandidate.startsWith(`${worktreeRoot}/`)
  ) {
    return { kind: 'none', reason: 'OUTSIDE_WORKTREE' };
  }

  return { kind: 'worktree-file', absolutePath: candidate };
}