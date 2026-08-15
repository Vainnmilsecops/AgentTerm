/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  assessLayoutMeasurement,
  assessTerminalResizeRange,
} = require('./visual-layout-audit-lib.cjs');

function visibleRegion(rect) {
  return {
    exists: true,
    rect,
    selector: '.fixture-region',
    visible: true,
  };
}

describe('visual layout audit invariants', () => {
  it('accepts a bounded workspace with no hidden keyboard targets', () => {
    const violations = assessLayoutMeasurement({
      documentScrollWidth: 1120,
      focusAudit: { hiddenReachable: [], visited: 12 },
      regions: {
        console: visibleRegion({
          bottom: 700,
          height: 220,
          left: 256,
          right: 1120,
          top: 480,
          width: 864,
        }),
        main: visibleRegion({
          bottom: 700,
          height: 644,
          left: 256,
          right: 1120,
          top: 56,
          width: 864,
        }),
        topbar: visibleRegion({
          bottom: 56,
          height: 56,
          left: 0,
          right: 1120,
          top: 0,
          width: 1120,
        }),
      },
      viewport: { height: 720, width: 1120 },
    });

    assert.deepEqual(violations, []);
  });

  it('reports document overflow, out-of-bounds regions, and hidden reachable controls', () => {
    const violations = assessLayoutMeasurement({
      documentScrollWidth: 781,
      focusAudit: {
        hiddenReachable: [
          {
            descriptor: 'button.task-option',
            label: 'Invisible task',
          },
        ],
        visited: 7,
      },
      regions: {
        console: {
          exists: true,
          rect: { bottom: 780, height: 180, left: 0, right: 760, top: 600, width: 760 },
          selector: '.workspace-console-dock',
          visible: true,
        },
        main: visibleRegion({
          bottom: 720,
          height: 664,
          left: 60,
          right: 820,
          top: 56,
          width: 760,
        }),
        topbar: {
          exists: false,
          rect: undefined,
          selector: undefined,
          visible: false,
        },
      },
      viewport: { height: 720, width: 760 },
    });

    assert.deepEqual(
      violations.map(({ code }) => code),
      [
        'DOCUMENT_HORIZONTAL_OVERFLOW',
        'TOPBAR_MISSING',
        'MAIN_OUTSIDE_VIEWPORT',
        'CONSOLE_OUTSIDE_VIEWPORT',
        'HIDDEN_FOCUSABLE_REACHABLE',
      ],
    );
  });

  it('distinguishes a present but visually hidden required region from a missing one', () => {
    const violations = assessLayoutMeasurement({
      documentScrollWidth: 520,
      focusAudit: { hiddenReachable: [], visited: 0 },
      regions: {
        console: {
          exists: true,
          rect: { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 },
          selector: '[data-agent-console]',
          visible: false,
        },
        main: visibleRegion({ bottom: 480, height: 432, left: 0, right: 520, top: 48, width: 520 }),
        topbar: visibleRegion({ bottom: 48, height: 48, left: 0, right: 520, top: 0, width: 520 }),
      },
      viewport: { height: 480, width: 520 },
    });

    assert.deepEqual(
      violations.map(({ code }) => code),
      ['CONSOLE_HIDDEN'],
    );
  });

  it('rejects a terminal empty state that escapes its viewport or overlaps the header', () => {
    const violations = assessLayoutMeasurement({
      documentScrollWidth: 520,
      focusAudit: { hiddenReachable: [], visited: 4 },
      regions: {
        console: visibleRegion({
          bottom: 448,
          height: 177,
          left: 0,
          right: 520,
          top: 271,
          width: 520,
        }),
        main: visibleRegion({ bottom: 480, height: 424, left: 0, right: 520, top: 56, width: 520 }),
        topbar: visibleRegion({ bottom: 56, height: 56, left: 0, right: 520, top: 0, width: 520 }),
      },
      terminalEmptyState: {
        card: { bottom: 455, height: 100, left: 80, right: 440, top: 355, width: 360 },
        exists: true,
        header: { bottom: 375, height: 36, left: 4, right: 516, top: 339, width: 512 },
        viewport: { bottom: 444, height: 69, left: 4, right: 516, top: 375, width: 512 },
      },
      viewport: { height: 480, width: 520 },
    });

    assert.deepEqual(
      violations.map(({ code }) => code),
      ['TERMINAL_EMPTY_STATE_OUTSIDE_VIEWPORT'],
    );
  });
});

describe('terminal resize accessibility range', () => {
  it('accepts a present separator whose value stays within its declared range', () => {
    assert.deepEqual(
      assessTerminalResizeRange({ exists: true, maximum: 300, minimum: 176, value: 264 }),
      [],
    );
  });

  it('rejects a missing separator and a value above the declared maximum', () => {
    assert.deepEqual(
      assessTerminalResizeRange({ exists: false }).map(({ code }) => code),
      ['TERMINAL_RESIZE_SEPARATOR_MISSING'],
    );
    assert.deepEqual(
      assessTerminalResizeRange({ exists: true, maximum: 300, minimum: 176, value: 360 }).map(
        ({ code }) => code,
      ),
      ['TERMINAL_RESIZE_RANGE_INVALID'],
    );
  });
});
