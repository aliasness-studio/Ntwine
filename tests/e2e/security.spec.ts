import { expect, test } from './harness/fixtures';

// The exact `window.ntwine` bridge surface (preload.ts's `api` object, `NtwineApi` in
// ipcTypes.ts), sorted — a method silently added/removed/renamed shows up as an array diff rather
// than a vague count mismatch.
const NTWINE_API_METHODS = [
  'coverUrl',
  'decodePreviewPcm',
  'getPeaks',
  'getState',
  'listPacks',
  'listTags',
  'onImportProgress',
  'pickLibraryRoot',
  'querySamples',
  'runImport',
  'sampleUrl',
  'startDrag',
];

test('the security fences hold: window.open and top-level navigation are denied, no Node leaks into the renderer, and the bridge is exactly its 12 methods', async ({
  ntwine,
}) => {
  const { app, page, seam } = ntwine;
  await seam.arm('ntwine:e2e:window-open-denied');
  await seam.arm('ntwine:e2e:nav-denied');

  // --- window.open: setWindowOpenHandler (main.ts) denies unconditionally, so no second
  // BrowserWindow is ever created — protocol.ts's corsEnabled sample://cover:// schemes are
  // fetchable by any origin this window ever renders, so no popup/remote content can be allowed. ---
  await page.evaluate(() => {
    window.open('https://example.com');
  });
  await expect.poll(() => seam.count('ntwine:e2e:window-open-denied')).toBe(1);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

  // --- top-level navigation to a foreign origin: will-navigate's preventDefault (main.ts) stops
  // it before it commits, so the page's own URL never moves. ---
  const before = page.url();
  await page.evaluate(() => {
    location.href = 'https://example.com';
  });
  await expect.poll(() => seam.count('ntwine:e2e:nav-denied')).toBe(1);
  expect(page.url()).toBe(before);

  // --- no Node integration leak into the renderer's global scope ---
  expect(
    await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require),
  ).toBe('undefined');

  // --- the preload bridge exposes exactly its documented surface — nothing more, nothing less ---
  expect(await page.evaluate(() => Object.keys(window.ntwine).sort())).toEqual(NTWINE_API_METHODS);

  // --- the e2e-only snapshot hook is live (already implied by launchNtwine's own boot wait —
  // pinned here explicitly too, alongside the rest of the renderer's global surface) ---
  expect(await page.evaluate(() => typeof window.__ntwineE2E)).toBe('function');
});
