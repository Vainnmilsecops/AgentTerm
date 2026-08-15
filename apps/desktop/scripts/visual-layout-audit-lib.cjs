/* global module */
'use strict';

const REQUIRED_REGIONS = Object.freeze([
  Object.freeze({ key: 'topbar', label: 'Top bar' }),
  Object.freeze({ key: 'main', label: 'Workspace main' }),
  Object.freeze({ key: 'console', label: 'Agent console' }),
]);

const BOUNDS_TOLERANCE_PX = 1;

function assessLayoutMeasurement(measurement) {
  const violations = [];
  const { viewport } = measurement;

  if (measurement.documentScrollWidth > viewport.width + BOUNDS_TOLERANCE_PX) {
    violations.push(
      violation(
        'DOCUMENT_HORIZONTAL_OVERFLOW',
        `Document scroll width ${measurement.documentScrollWidth}px exceeds viewport width ${viewport.width}px.`,
      ),
    );
  }

  for (const regionDefinition of REQUIRED_REGIONS) {
    const region = measurement.regions[regionDefinition.key];
    const codePrefix = regionDefinition.key.toUpperCase();
    if (region?.exists !== true) {
      violations.push(
        violation(
          `${codePrefix}_MISSING`,
          `${regionDefinition.label} was not found in the renderer.`,
        ),
      );
      continue;
    }
    if (region.visible !== true || region.rect === undefined) {
      violations.push(
        violation(
          `${codePrefix}_HIDDEN`,
          `${regionDefinition.label} exists but is not visibly rendered.`,
          region.selector,
        ),
      );
      continue;
    }
    if (!rectFitsViewport(region.rect, viewport)) {
      violations.push(
        violation(
          `${codePrefix}_OUTSIDE_VIEWPORT`,
          `${regionDefinition.label} extends outside the ${viewport.width}x${viewport.height} viewport.`,
          region.selector,
        ),
      );
    }
  }

  if (measurement.focusAudit.hiddenReachable.length > 0) {
    violations.push(
      violation(
        'HIDDEN_FOCUSABLE_REACHABLE',
        `${measurement.focusAudit.hiddenReachable.length} visually hidden control(s) were reachable by Tab.`,
        undefined,
        measurement.focusAudit.hiddenReachable,
      ),
    );
  }

  const emptyState = measurement.terminalEmptyState;
  if (
    emptyState?.exists === true &&
    emptyState.card !== undefined &&
    emptyState.viewport !== undefined &&
    (emptyState.card.top < emptyState.viewport.top - BOUNDS_TOLERANCE_PX ||
      emptyState.card.bottom > emptyState.viewport.bottom + BOUNDS_TOLERANCE_PX ||
      emptyState.card.left < emptyState.viewport.left - BOUNDS_TOLERANCE_PX ||
      emptyState.card.right > emptyState.viewport.right + BOUNDS_TOLERANCE_PX ||
      (emptyState.header !== undefined &&
        emptyState.card.top < emptyState.header.bottom - BOUNDS_TOLERANCE_PX))
  ) {
    violations.push(
      violation(
        'TERMINAL_EMPTY_STATE_OUTSIDE_VIEWPORT',
        'The terminal empty-state card overlaps its header or escapes the terminal viewport.',
        '.terminal-panel__empty-card',
      ),
    );
  }

  return violations;
}

function assessTerminalResizeRange(state) {
  if (state?.exists !== true) {
    return [
      violation(
        'TERMINAL_RESIZE_SEPARATOR_MISSING',
        'The Agent console resize separator was not found after dynamic resize.',
      ),
    ];
  }
  if (
    !Number.isFinite(state.minimum) ||
    !Number.isFinite(state.maximum) ||
    !Number.isFinite(state.value) ||
    state.minimum > state.maximum ||
    state.value < state.minimum ||
    state.value > state.maximum
  ) {
    return [
      violation(
        'TERMINAL_RESIZE_RANGE_INVALID',
        `Terminal resize value ${String(state.value)} is outside ${String(state.minimum)}-${String(state.maximum)}.`,
        state.selector,
      ),
    ];
  }
  return [];
}

function rectFitsViewport(rect, viewport) {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left >= -BOUNDS_TOLERANCE_PX &&
    rect.top >= -BOUNDS_TOLERANCE_PX &&
    rect.right <= viewport.width + BOUNDS_TOLERANCE_PX &&
    rect.bottom <= viewport.height + BOUNDS_TOLERANCE_PX
  );
}

function violation(code, message, selector, details) {
  return Object.freeze({
    code,
    message,
    ...(selector === undefined ? {} : { selector }),
    ...(details === undefined ? {} : { details }),
  });
}

module.exports = Object.freeze({ assessLayoutMeasurement, assessTerminalResizeRange });
