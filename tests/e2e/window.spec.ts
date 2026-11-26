import { computeDefaultBounds } from '../../src/main/defaultBounds';
import { expect, test } from './harness/fixtures';
import { E2E_HEADED } from './harness/launch';

// The window opens at 90% of the primary display's work area (floored at the old
// 800x600, capped at the work area itself). Asserted against the SAME pure function main.ts
// uses, evaluated over the live display the app actually saw — so this passes on any screen a
// dev or CI box happens to have, while still failing if main.ts stops consulting the display at
// all (the old hardcoded 800x600 only matches computeDefaultBounds on a screen small enough to
// clamp, which no dev/CI display is).
test('the window opens at 90% of the work area, not the old fixed 800x600', async ({ ntwine }) => {
  const { app } = ntwine;
  const { bounds, workArea, scaleFactor, visible, focused, opacity } = await app.evaluate(
    ({ BrowserWindow, screen }) => ({
      bounds: BrowserWindow.getAllWindows()[0].getBounds(),
      workArea: screen.getPrimaryDisplay().workAreaSize,
      scaleFactor: screen.getPrimaryDisplay().scaleFactor,
      visible: BrowserWindow.getAllWindows()[0].isVisible(),
      focused: BrowserWindow.getAllWindows()[0].isFocused(),
      opacity: BrowserWindow.getAllWindows()[0].getOpacity(),
    }),
  );
  // Quiet-mode contract (main.ts, NTWINE_E2E_HIDDEN): the window IS presented (isVisible —
  // Chromium evicts an unshown window's compositor surface and rAF drops to ~1.5 Hz, 5-8x'ing
  // every click), but fully imperceptibly: transparent, never activated (the dev's keyboard
  // focus is not stolen), parked off-screen at x/y −32000 (bounds x is asserted far left of
  // any real display). A headed run (NTWINE_E2E_HEADED=1) is opaque and on-screen. Pinned so a
  // regression that starts flashing windows mid-suite — or quietly turns runs back into the
  // slow surface-evicted mode — fails loudly.
  expect(visible).toBe(true);
  if (E2E_HEADED) {
    expect(opacity).toBe(1);
  } else {
    expect(opacity).toBe(0);
    expect(focused).toBe(false);
    // The off-screen park only survives on win32 — macOS (AppKit) clamps window placement back
    // onto a display (CI read bounds.x === 0), which is why quiet mode also forwards OS mouse
    // input through the window (setIgnoreMouseEvents, main.ts): on a Mac the invisible window
    // sits on-screen and must not swallow real clicks. No getter exposes that flag, so the
    // imperceptibility pins on darwin are opacity 0 + never-focused above.
    if (process.platform === 'win32') expect(bounds.x).toBeLessThan(-10000);
  }
  const expected = computeDefaultBounds(workArea);
  // Windows snaps window bounds to the PHYSICAL pixel grid, so on a fractional display scale
  // (e.g. 150%) getBounds() reads back a couple DIPs off the requested size — observed +2px
  // height at scaleFactor 1.5, while the width (whose physical size happened to be an integer)
  // matched exactly. Allow that snap on win32 only; the regression this test guards against
  // (falling back to the fixed 800x600) is hundreds of pixels away, so the tolerance costs
  // nothing. Exact equality everywhere else.
  // Quiet mode adds a second noise source on win32: a layered (opacity 0), skip-taskbar window
  // created off-screen comes out a few PHYSICAL pixels larger than requested (measured at 150%:
  // +2 width, +5 height DIP, identical after moving it on-screen — creation-time frame metrics,
  // not readback rounding). 8 DIP covers both noise sources with margin; the regression this
  // test exists for (the old hardcoded 800x600) is ~450 DIP away. Headed runs keep the tight
  // DPI-snap-only bound.
  const QUIET_WIN32_NOISE = 8;
  const tolerance =
    process.platform === 'win32' ? (E2E_HEADED ? Math.ceil(scaleFactor) : QUIET_WIN32_NOISE) : 0;
  expect(Math.abs(bounds.width - expected.width)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(bounds.height - expected.height)).toBeLessThanOrEqual(tolerance);
});
