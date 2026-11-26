import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importAndWait, openSettings } from './harness/actions';
import { buildFixtureLibrary } from './fixture/library';
import { expect, test } from './harness/fixtures';
import { launchNtwine } from './harness/launch';

// An e2e run never starts the real updater, so the downloading state is pinned through
// NTWINE_E2E_UPDATE_STATE (src/main/e2e.ts): `ntwine:getUpdateState` then answers
// `{ kind: 'downloading' }` and UpdateStore renders the banner from that alone.
test('while an update downloads, the banner shows above the search row and the badge stays hidden', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-update-'));
  const fixture = buildFixtureLibrary(root);
  const l = await launchNtwine({
    userData: fixture.userData,
    appData: fixture.appData,
    libraryRoot: fixture.libraryRoot,
    extraEnv: { NTWINE_E2E_UPDATE_STATE: 'downloading' },
  });
  try {
    const { page } = l;
    await importAndWait(page);

    const banner = page.getByTestId('update-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveRole('status');
    await expect(banner).toHaveAttribute('aria-live', 'polite');
    await expect(banner).toContainText('Downloading update…');
    await expect(banner).toContainText('You can keep working.');
    await expect(page.getByTestId('update-badge')).toHaveCount(0);

    // A strip above the search row, not an overlay on it.
    const bannerBox = await banner.boundingBox();
    const searchBox = await page.getByLabel('Search samples').boundingBox();
    expect(bannerBox).not.toBeNull();
    expect(searchBox).not.toBeNull();
    expect(bannerBox!.y + bannerBox!.height).toBeLessThanOrEqual(searchBox!.y);
  } finally {
    await l.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('with no update in flight, there is no banner', async ({ ntwine }) => {
  const { page } = ntwine;
  await importAndWait(page);

  // UpdateStore.init() applies the version and the update state together, so once Settings shows
  // a version the (idle) update state has landed too and the absence below is not a race.
  await openSettings(page);
  await expect(page.getByTestId('settings-version')).toHaveText(/^\d+\.\d+\.\d+/);
  await page.getByRole('button', { name: 'Close settings' }).click();

  await expect(page.getByTestId('update-banner')).toHaveCount(0);
});
