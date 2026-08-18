// Default window sizing (QoL round 1): open at 75% of the primary display's work area instead of
// a hardcoded 800x600, so the app reads as "most of the screen" on any monitor — the same code
// path serves a 16" MBP and the Windows box. Pure math (no electron import) so it unit-tests
// without an app instance; main.ts feeds it `screen.getPrimaryDisplay().workAreaSize`.
export interface Size {
  width: number;
  height: number;
}

export const WORK_AREA_FRACTION = 0.75;
export const MIN_DEFAULT_WIDTH = 800;
export const MIN_DEFAULT_HEIGHT = 600;

/** 75% of each work-area dimension, floored at 800x600 (the old fixed size), but never larger
 * than the work area itself — the outer `min` wins over the floor on purpose, so a tiny screen
 * gets a window that fits it rather than one that overflows it. */
export function computeDefaultBounds(workArea: Size): Size {
  return {
    width: Math.min(
      workArea.width,
      Math.max(MIN_DEFAULT_WIDTH, Math.round(workArea.width * WORK_AREA_FRACTION)),
    ),
    height: Math.min(
      workArea.height,
      Math.max(MIN_DEFAULT_HEIGHT, Math.round(workArea.height * WORK_AREA_FRACTION)),
    ),
  };
}
