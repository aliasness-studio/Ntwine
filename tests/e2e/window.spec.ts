import { computeDefaultBounds } from '../../src/main/defaultBounds';
import { expect, test } from './harness/fixtures';

// QoL round 1: the window opens at 75% of the primary display's work area (floored at the old
// 800x600, capped at the work area itself). Asserted against the SAME pure function main.ts
// uses, evaluated over the live display the app actually saw — so this passes on any screen a
// dev or CI box happens to have, while still failing if main.ts stops consulting the display at
// all (the old hardcoded 800x600 only matches computeDefaultBounds on a screen small enough to
// clamp, which no dev/CI display is).
test('the window opens at 75% of the work area, not the old fixed 800x600', async ({ ntwine }) => {
  const { app } = ntwine;
  const { bounds, workArea } = await app.evaluate(({ BrowserWindow, screen }) => ({
    bounds: BrowserWindow.getAllWindows()[0].getBounds(),
    workArea: screen.getPrimaryDisplay().workAreaSize,
  }));
  expect({ width: bounds.width, height: bounds.height }).toEqual(computeDefaultBounds(workArea));
});
