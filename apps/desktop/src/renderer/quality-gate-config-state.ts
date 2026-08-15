import { QualityGateKindValue } from '@agentterm/application';

import type { QualityGateKind } from '@agentterm/application';

export interface QualityGateDraft {
  readonly arguments: string;
  readonly executablePath: string;
  readonly id: string;
  readonly kind: QualityGateKind;
  readonly timeoutMs: number;
}

export type QualityGateDraftValidation =
  { readonly ok: false; readonly reason: string } | { readonly ok: true };

const stableIdPattern = /^[a-z0-9]+(?:[._:=-][a-z0-9]+)*$/u;
const sensitiveFlag =
  /(?:^|[-_])(?:api[-_]?key|auth(?:orization)?|credential|password|private[-_]?key|secret|token)(?:$|[=_\s-])/iu;
const sensitiveValue = /(?:authorization\s*:|bearer\s+|basic\s+)[^s]/iu;
const absoluteExecutablePathPattern = /^(?:[A-Za-z]:[\\/]|\\\\|[\\/])/u;
const minimumTimeoutMs = 1_000;
const maximumTimeoutMs = 30 * 60 * 1_000;

export const qualityGateKindOptions: ReadonlyArray<{
  readonly label: string;
  readonly value: QualityGateKindValue;
}> = Object.freeze([
  { label: 'Lint', value: QualityGateKindValue.LINT },
  { label: 'Type-check', value: QualityGateKindValue.TYPECHECK },
  { label: 'Test', value: QualityGateKindValue.TEST },
  { label: 'Build', value: QualityGateKindValue.BUILD },
]);

export function defaultQualityGateDraft(): QualityGateDraft {
  return Object.freeze({
    arguments: '',
    executablePath: '',
    id: `gate-${Math.random().toString(36).slice(2, 8)}`,
    kind: QualityGateKindValue.LINT,
    timeoutMs: 15 * 60 * 1_000,
  });
}

export function parseQualityGateArguments(raw: string): readonly string[] {
  return Object.freeze(
    raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

export function validateQualityGateDraft(draft: QualityGateDraft): QualityGateDraftValidation {
  if (!stableIdPattern.test(draft.id)) {
    return Object.freeze({
      ok: false,
      reason: 'Id must be slug (lowercase, digits, separators . _ - : =).',
    });
  }
  if (!Object.values(QualityGateKindValue).includes(draft.kind)) {
    return Object.freeze({ ok: false, reason: 'Kind is not supported.' });
  }
  if (
    !Number.isSafeInteger(draft.timeoutMs) ||
    draft.timeoutMs < minimumTimeoutMs ||
    draft.timeoutMs > maximumTimeoutMs
  ) {
    return Object.freeze({
      ok: false,
      reason: `Timeout must be between ${minimumTimeoutMs / 1000}s and ${maximumTimeoutMs / 60_000}m.`,
    });
  }
  if (!absoluteExecutablePathPattern.test(draft.executablePath)) {
    return Object.freeze({
      ok: false,
      reason: 'Executable path must be absolute (Windows drive, UNC, or POSIX).',
    });
  }
  const arguments_ = parseQualityGateArguments(draft.arguments);
  if (
    arguments_.some((argument) => sensitiveFlag.test(argument) || sensitiveValue.test(argument))
  ) {
    return Object.freeze({
      ok: false,
      reason: 'Arguments must not contain credentials or secrets.',
    });
  }
  return Object.freeze({ ok: true });
}

export function describeQualityGate(input: {
  readonly command: { readonly arguments: readonly string[]; readonly executablePath: string };
  readonly id: string;
  readonly kind: QualityGateKind;
  readonly timeoutMs: number;
}): string {
  const argumentsPreview =
    input.command.arguments.length === 0
      ? ''
      : ` ${input.command.arguments.map((argument) => (argument.includes(' ') ? JSON.stringify(argument) : argument)).join(' ')}`;
  return `${input.kind} timeout=${Math.round(input.timeoutMs / 1000)}s ${input.command.executablePath}${argumentsPreview}`;
}

export function qualityGateMinTimeout(): number {
  return minimumTimeoutMs;
}

export function qualityGateMaxTimeout(): number {
  return maximumTimeoutMs;
}
