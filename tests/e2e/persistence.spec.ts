import { importAndWait, openSettings, readCount } from './harness/actions';
import { expect, test } from './harness/fixtures';
import { launchNtwine } from './harness/launch';

// `Launched.close()` is idempotent, so the fixture's own teardown closing `ntwine` a
// second time after this test's explicit `await ntwine.close()` is a no-op — never two live
// Electron instances against one `userData` at once. The relaunch is asserted inside its own
// try/finally so a leaked second process (exactly what would hold SQLite WAL handles open on
// Windows) can never survive a failed assertion.
test('a second launch skips first-run and shows the imported library from disk', async ({ ntwine }) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples);
  await ntwine.close();
  const second = await launchNtwine({ userData: fixture.userData, appData: fixture.appData, libraryRoot: fixture.libraryRoot });
  try {
    await expect(second.page.getByRole('listbox', { name: 'Sample list' })).toBeVisible();
    await expect(second.page.getByRole('button', { name: 'Import library' })).toHaveCount(0);
    await expect.poll(() => readCount(second.page)).toBe(fixture.totalSamples);
    await openSettings(second.page);
    await expect(second.page.getByTestId('settings-library-root')).toHaveText(fixture.libraryRoot);
  } finally {
    await second.close();
  }
});
