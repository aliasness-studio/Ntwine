import { computeDefaultBounds } from '../../src/main/defaultBounds';
import { expect, test } from './harness/fixtures';

// QoL round 1: the window opens at 90% of the primary display's work area (floored at the old
// 800x600, capped at the work area itself). Asserted against the SAME pure function main.ts
// uses, evaluated over the live display the app actually saw — so this passes on any screen a
// dev or CI box happens to have, while still failing if main.ts stops consulting the display at
// all (the old hardcoded 800x600 only matches computeDefaultBounds on a screen small enough to
// clamp, which no dev/CI display is).
test('the window opens at 90% of the work area, not the old fixed 800x600', async ({ ntwine }) => {
  const { app } = ntwine;
  const { bounds, workArea, scaleFactor } = await app.evaluate(({ BrowserWindow, screen }) => ({
    bounds: BrowserWindow.getAllWindows()[0].getBounds(),
    workArea: screen.getPrimaryDisplay().workAreaSize,
    scaleFactor: screen.getPrimaryDisplay().scaleFactor,
  }));
  const expected = computeDefaultBounds(workArea);
  // Windows snaps window bounds to the PHYSICAL pixel grid, so on a fractional display scale
  // (e.g. 150%) getBounds() reads back a couple DIPs off the requested size — observed +2px
  // height at scaleFactor 1.5, while the width (whose physical size happened to be an integer)
  // matched exactly. Allow that snap on win32 only; the regression this test guards against
  // (falling back to the fixed 800x600) is hundreds of pixels away, so the tolerance costs
  // nothing. Exact equality everywhere else.
  const tolerance = process.platform === 'win32' ? Math.ceil(scaleFactor) : 0;
  expect(Math.abs(bounds.width - expected.width)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(bounds.height - expected.height)).toBeLessThanOrEqual(tolerance);
});
