import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { importAndWait, openSettings, readCount } from './harness/actions';
import { expect, test } from './harness/fixtures';
import { launchNtwine } from './harness/launch';

test('settings: re-run import stays idempotent, and re-pick persists a relocated root across a relaunch', async ({
  ntwine,
}) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);

  await openSettings(page);
  await expect(page.getByTestId('settings-library-root')).toHaveText(fixture.libraryRoot);
  // Version row: app.getVersion() resolved through the update bridge —
  // a semver, not the '…' placeholder shown while UpdateStore.init() is still in flight.
  await expect(page.getByTestId('settings-version')).toHaveText(/^\d+\.\d+\.\d+/);

  // --- re-run import is idempotent: the same 12 rows survive a second pass, no duplicates ---
  const reimportButton = page.getByRole('button', { name: 'Re-run import' });
  await reimportButton.click();
  await expect(reimportButton).toBeEnabled(); // 'Importing…' -> 'Re-run import' again
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // 12

  // --- re-pick must be able to FAIL, so this moves the root to a brand-new, empty directory and
  // proves the move actually persisted rather than merely being accepted: the settings text must
  // CHANGE to the relocated dir (a no-change would mean the dialog stub never took effect — the
  // falsifier for this test stubs a return of fixture.libraryRoot instead, which must fail here),
  // and statPass against the now-empty root flips every row's missing flag. ---
  const relocated = join(ntwine.root, 'relocated');
  mkdirSync(relocated);
  // Primary stub strategy: ipc.ts's pickLibraryRoot handler calls
  // `dialog.showOpenDialog(...)` as a property access on the imported `dialog` module object, not
  // a value captured into a local binding — app.evaluate runs INSIDE the main process, so `dialog`
  // there is the very same Electron module singleton ipc.ts imported, and patching the property
  // lands on the next call. Proven, not assumed: the assertions below fail loudly if it didn't.
  await ntwine.app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
  }, relocated);

  await openSettings(page);
  await page.getByRole('button', { name: 'Re-pick folder' }).click();
  await expect(page.getByTestId('settings-library-root')).toHaveText(relocated); // CHANGED, not fixture.libraryRoot
  await expect(page.getByTestId('missing-badge')).toHaveCount(fixture.totalSamples); // every row missing now

  // --- close (idempotent — Launched.close() tolerates the fixture teardown's own close) and
  // relaunch on the SAME dirs: meta.library_root persisted in the catalog wins over the
  // NTWINE_LIBRARY_ROOT env default (ipc.ts's currentLibraryRoot), same relaunch shape as
  // persistence.spec's second-launch check. ---
  await ntwine.close();
  const second = await launchNtwine({ userData: fixture.userData, appData: fixture.appData, libraryRoot: fixture.libraryRoot });
  try {
    await expect(second.page.getByRole('listbox', { name: 'Sample list' })).toBeVisible();
    await openSettings(second.page);
    await expect(second.page.getByTestId('settings-library-root')).toHaveText(relocated);
  } finally {
    await second.close();
  }
});
