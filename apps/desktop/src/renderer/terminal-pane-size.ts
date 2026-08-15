export const DEFAULT_TERMINAL_HEIGHT = 264;
export const MIN_TERMINAL_HEIGHT = 176;
export const MAX_TERMINAL_VIEWPORT_OFFSET = 240;
export const NARROW_TERMINAL_MAX_HEIGHT = 224;
export const NARROW_TERMINAL_MAX_WIDTH = 760;
export const MINIMUM_TERMINAL_MAX_WIDTH = 560;

export function maximumTerminalHeight(viewportHeight: number, viewportWidth: number): number {
  const viewportMaximum = Math.max(
    MIN_TERMINAL_HEIGHT,
    viewportHeight - MAX_TERMINAL_VIEWPORT_OFFSET,
  );
  const responsiveMaximum =
    viewportWidth <= MINIMUM_TERMINAL_MAX_WIDTH
      ? MIN_TERMINAL_HEIGHT
      : viewportWidth <= NARROW_TERMINAL_MAX_WIDTH
        ? NARROW_TERMINAL_MAX_HEIGHT
        : Number.POSITIVE_INFINITY;
  return Math.max(MIN_TERMINAL_HEIGHT, Math.min(viewportMaximum, responsiveMaximum));
}

export function resizeTerminalHeight(
  startHeight: number,
  startPointerY: number,
  currentPointerY: number,
  viewportHeight: number,
  viewportWidth = Number.POSITIVE_INFINITY,
): number {
  const maximum = maximumTerminalHeight(viewportHeight, viewportWidth);
  return Math.min(
    maximum,
    Math.max(MIN_TERMINAL_HEIGHT, startHeight + startPointerY - currentPointerY),
  );
}
