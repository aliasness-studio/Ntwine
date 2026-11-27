import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { importAndWait, openSettings } from './harness/actions';
import { buildFixtureLibrary } from './fixture/library';
import { expect, test } from './harness/fixtures';
import { launchNtwine } from './harness/launch';

// An e2e run never starts the real updater, so the update state is pinned through
// NTWINE_E2E_UPDATE_STATE (src/main/e2e.ts): `ntwine:getUpdateState` then answers the pinned
// state and UpdateStore renders the banner from that alone. The pinned updater's install is a
// no-op, so clicking "Restart to update" here never quits the app.
async function withPinnedUpdate(updateState: string, body: (page: Page) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-update-'));
  const fixture = buildFixtureLibrary(root);
  const l = await launchNtwine({
    userData: fixture.userData,
    appData: fixture.appData,
    libraryRoot: fixture.libraryRoot,
    extraEnv: { NTWINE_E2E_UPDATE_STATE: updateState },
  });
  try {
    await importAndWait(l.page);
    await body(l.page);
  } finally {
    await l.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('while an update downloads, the banner shows above the search row; dismissed, a top-bar button brings it back', async () => {
  await withPinnedUpdate('downloading', async (page) => {
    const banner = page.getByTestId('update-banner');
    const message = page.getByTestId('update-banner-message');
    const reminder = page.getByTestId('update-reminder');
    await expect(banner).toBeVisible();
    await expect(message).toHaveRole('status');
    await expect(message).toHaveAttribute('aria-live', 'polite');
    await expect(message).toContainText('Downloading update…');
    await expect(message).toContainText('You can keep working.');
    await expect(reminder).toHaveCount(0);

    // A strip above the search row, not an overlay on it.
    const bannerBox = await banner.boundingBox();
    const searchBox = await page.getByLabel('Search samples').boundingBox();
    expect(bannerBox).not.toBeNull();
    expect(searchBox).not.toBeNull();
    expect(bannerBox!.y + bannerBox!.height).toBeLessThanOrEqual(searchBox!.y);

    await banner.getByRole('button', { name: 'Dismiss update notice' }).click();
    await expect(banner).toHaveCount(0);
    await expect(reminder).toBeVisible();
    await expect(reminder).toHaveAttribute('title', 'Downloading update');

    await reminder.click();
    await expect(banner).toBeVisible();
    await expect(message).toContainText('Downloading update…');
    await expect(reminder).toHaveCount(0);
  });
});

test('a ready update names the release and offers a restart; dismissed, the top-bar button takes over', async () => {
  await withPinnedUpdate('ready:Ntwine v9.9.9 (beta)', async (page) => {
    const banner = page.getByTestId('update-banner');
    const reminder = page.getByTestId('update-reminder');
    await expect(banner).toBeVisible();
    await expect(page.getByTestId('update-banner-message')).toHaveText('Ntwine v9.9.9 (beta) is ready.');
    const restart = banner.getByRole('button', { name: 'Restart to update' });
    await expect(restart).toBeVisible();
    await expect(reminder).toHaveCount(0);

    // Harmless under the pinned updater: the click reaches main and nothing happens.
    await restart.click();
    await expect(banner).toBeVisible();

    await banner.getByRole('button', { name: 'Dismiss update notice' }).click();
    await expect(banner).toHaveCount(0);
    await expect(reminder).toBeVisible();
    await expect(reminder).toHaveAccessibleName('Restart to update');
    await expect(reminder).toHaveAttribute('title', 'Ntwine v9.9.9 (beta) is ready — restart to update');
  });
});

test('with no update in flight, there is no banner and no top-bar button', async ({ ntwine }) => {
  const { page } = ntwine;
  await importAndWait(page);

  // UpdateStore.init() applies the version and the update state together, so once Settings shows
  // a version the (idle) update state has landed too and the absence below is not a race.
  await openSettings(page);
  await expect(page.getByTestId('settings-version')).toHaveText(/^\d+\.\d+\.\d+/);
  await page.getByRole('button', { name: 'Close settings' }).click();

  await expect(page.getByTestId('update-banner')).toHaveCount(0);
  await expect(page.getByTestId('update-reminder')).toHaveCount(0);
});
