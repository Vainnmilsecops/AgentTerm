import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./renderer/quality-gate-config.tsx', import.meta.url), 'utf8');
const stateSource = readFileSync(
  new URL('./renderer/quality-gate-config-state.ts', import.meta.url),
  'utf8',
);

describe('quality gate configuration contract', () => {
  it('exposes the QualityGateConfiguration React component', () => {
    expect(source).toContain('export function QualityGateConfiguration');
  });

  it('binds list rows, kind, executable, timeout, arguments, registration, and removal', () => {
    expect(source).toContain('data-quality-gate-list');
    expect(source).toContain('data-quality-gate-row');
    expect(source).toContain('data-quality-gate-remove');
    expect(source).toContain('data-quality-gate-id');
    expect(source).toContain('data-quality-gate-kind');
    expect(source).toContain('data-quality-gate-executable');
    expect(source).toContain('data-quality-gate-timeout');
    expect(source).toContain('data-quality-gate-arguments');
    expect(source).toContain('data-quality-gate-submit');
  });

  it('delegates validation to quality-gate-config-state', () => {
    expect(source).toContain('validateQualityGateDraft');
    expect(source).toContain('defaultQualityGateDraft');
    expect(source).toContain('parseQualityGateArguments');
    expect(source).toContain('qualityGateKindOptions');
  });

  it('state module exposes the helpers consumers expect', () => {
    expect(stateSource).toContain('export function defaultQualityGateDraft');
    expect(stateSource).toContain('export function validateQualityGateDraft');
    expect(stateSource).toContain('export function describeQualityGate');
    expect(stateSource).toContain('export function parseQualityGateArguments');
    expect(stateSource).toContain('export const qualityGateKindOptions');
  });
});
