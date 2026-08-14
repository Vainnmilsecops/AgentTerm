import { describe, expect, it } from 'vitest';

import { QualityGateKindValue } from '@agentterm/application';

import type { QualityGateKind } from '@agentterm/application';

import {
  defaultQualityGateDraft,
  describeQualityGate,
  parseQualityGateArguments,
  qualityGateKindOptions,
  qualityGateMaxTimeout,
  qualityGateMinTimeout,
  validateQualityGateDraft,
  type QualityGateDraft,
} from './quality-gate-config-state';

function draft(overrides: Partial<QualityGateDraft> = {}): QualityGateDraft {
  return Object.freeze({
    arguments: '',
    executablePath: 'C:/tools/eslint/bin/eslint.js',
    id: 'frontend-lint',
    kind: QualityGateKindValue.LINT,
    timeoutMs: 60_000,
    ...overrides,
  });
}

describe('defaultQualityGateDraft', () => {
  it('returns a sensible starting draft', () => {
    const result = defaultQualityGateDraft();
    expect(result.kind).toBe(QualityGateKindValue.LINT);
    expect(result.executablePath).toBe('');
    expect(result.arguments).toBe('');
    expect(result.timeoutMs).toBeGreaterThanOrEqual(qualityGateMinTimeout());
  });
});

describe('parseQualityGateArguments', () => {
  it('splits multiline input and trims empty lines', () => {
    expect(parseQualityGateArguments('--max-warnings 0\n  src\n\n')).toEqual([
      '--max-warnings 0',
      'src',
    ]);
  });

  it('returns empty list for empty input', () => {
    expect(parseQualityGateArguments('')).toEqual([]);
  });
});

describe('validateQualityGateDraft', () => {
  it('accepts a sensible draft', () => {
    expect(validateQualityGateDraft(draft())).toEqual({ ok: true });
  });

  it('rejects invalid id', () => {
    expect(validateQualityGateDraft(draft({ id: 'Bad ID' }))).toMatchObject({ ok: false });
  });

  it('rejects unknown kind', () => {
    expect(
      validateQualityGateDraft(draft({ kind: 'no-such-kind' as QualityGateKind })),
    ).toMatchObject({ ok: false });
  });

  it('rejects timeout below minimum', () => {
    expect(validateQualityGateDraft(draft({ timeoutMs: 100 }))).toMatchObject({ ok: false });
  });

  it('rejects timeout above maximum', () => {
    expect(
      validateQualityGateDraft(draft({ timeoutMs: qualityGateMaxTimeout() + 1 })),
    ).toMatchObject({
      ok: false,
    });
  });

  it('rejects non-absolute executable path', () => {
    expect(validateQualityGateDraft(draft({ executablePath: 'eslint' }))).toMatchObject({
      ok: false,
    });
  });

  it('rejects arguments containing secret-like names', () => {
    expect(validateQualityGateDraft(draft({ arguments: '--token abc123' }))).toMatchObject({
      ok: false,
    });
  });

  it('rejects arguments containing bearer tokens', () => {
    expect(
      validateQualityGateDraft(draft({ arguments: '--header "authorization: Bearer xyz"' })),
    ).toMatchObject({ ok: false });
  });
});

describe('qualityGateKindOptions', () => {
  it('includes every supported kind', () => {
    const values = qualityGateKindOptions.map((option) => option.value);
    for (const kind of Object.values(QualityGateKindValue)) {
      expect(values).toContain(kind);
    }
  });
});

describe('describeQualityGate', () => {
  it('includes the kind, timeout, and executable', () => {
    const description = describeQualityGate({
      command: { arguments: [], executablePath: 'C:/tools/eslint' },
      id: 'frontend-lint',
      kind: QualityGateKindValue.LINT,
      timeoutMs: 60_000,
    });
    expect(description).toContain('lint');
    expect(description).toContain('C:/tools/eslint');
    expect(description).toContain('60s');
  });

  it('quotes arguments that contain spaces', () => {
    const description = describeQualityGate({
      command: { arguments: ['--max-warnings 0'], executablePath: 'C:/tools/eslint' },
      id: 'frontend-lint',
      kind: QualityGateKindValue.LINT,
      timeoutMs: 60_000,
    });
    expect(description).toContain('--max-warnings 0');
  });
});

describe('quality-gate-config state smoke', () => {
  it('exposes minimum and maximum timeout helpers', () => {
    expect(qualityGateMinTimeout()).toBe(1_000);
    expect(qualityGateMaxTimeout()).toBeGreaterThan(qualityGateMinTimeout());
  });
});
