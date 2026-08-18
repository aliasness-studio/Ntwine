import type { Locator, Page } from '@playwright/test';
import { emptyStateText } from '../../src/renderer/emptyState';
import { importAndWait, readCount, rowByFilename, rowHeart } from './harness/actions';
import { expect, test } from './harness/fixtures';
import { launchNtwine } from './harness/launch';

// LibraryRail.tsx's `Item` renders exactly two <span> children per option — Name then Count,
// the same shape browse.spec.ts's own `countSpan` already documents for PackRail/LibraryRail
// alike. user.db starts empty every test (design spec §8) and this spec never creates a
// collection, so the Library listbox is always exactly [All Samples, Favorites] — matched by
// NAME (not index) so intent reads at each call site, tolerant of whitespace between the two
// spans for the same reason `clickPack`/`toggleTag` (actions.ts) already are.
function libraryOption(page: Page, name: 'All Samples' | 'Favorites'): Locator {
  return page
    .getByRole('listbox', { name: 'Library' })
    .getByRole('option', { name: new RegExp(`^${name}\\s*\\d+$`) });
}
function countSpan(option: Locator): Locator {
  return option.locator('span').last();
}

test('the heart toggles aria-pressed and the rail count, Favorites-scope selection-follow lands on the next row (not the removed one), the empty scope shows its empty-string, and a favorite survives relaunch', async ({
  ntwine,
}) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);
  const list = page.getByRole('listbox', { name: 'Sample list' });
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // sanity: 12 before any interaction

  // --- click heart on AD_Kick_01.wav -> aria-pressed, rail count 1 ---
  const kick01Heart = rowHeart(page, 'AD_Kick_01.wav');
  await expect(kick01Heart).toHaveAttribute('aria-pressed', 'false');
  await kick01Heart.click();
  await expect(kick01Heart).toHaveAttribute('aria-pressed', 'true');
  await expect(countSpan(libraryOption(page, 'Favorites'))).toHaveText('1');

  // --- 3-row selection-follow under Favorites scope (design spec §3.1) ---
  // All three rows share the Alpha Drums pack, so querySamples' `ORDER BY p.name, s.filename,
  // s.id` (queries.ts) puts them in this exact filename order — deterministic without a DB read,
  // the same reasoning preview.spec.ts's own keyboard-walk assertion already documents.
  await rowHeart(page, 'AD_Kick_02.wav').click();
  await expect(countSpan(libraryOption(page, 'Favorites'))).toHaveText('2');
  await rowHeart(page, 'AD_Snare_01.wav').click();
  await expect(countSpan(libraryOption(page, 'Favorites'))).toHaveText('3');

  await libraryOption(page, 'Favorites').click();
  const favRows = list.getByRole('option');
  await expect(favRows).toHaveCount(3);

  const middleRow = rowByFilename(page, 'AD_Kick_02.wav');
  await middleRow.click();
  await expect(middleRow).toHaveAttribute('aria-selected', 'true');
  await list.focus();
  await page.keyboard.press('f');

  // The unfavorited middle row drops out of the Favorites-scoped list, and selection lands on
  // AD_Snare_01.wav — the row that was next after it, never AD_Kick_01.wav.
  await expect(favRows).toHaveCount(2);
  await expect(rowByFilename(page, 'AD_Kick_02.wav')).toHaveCount(0);
  await expect(rowByFilename(page, 'AD_Snare_01.wav')).toHaveAttribute('aria-selected', 'true');

  // --- unfavorite the rest -> EmptyState shows the favorites empty-string ---
  await rowHeart(page, 'AD_Kick_01.wav').click();
  await rowHeart(page, 'AD_Snare_01.wav').click();
  await expect(favRows).toHaveCount(0);
  await expect(countSpan(libraryOption(page, 'Favorites'))).toHaveText('0');
  await expect(page.getByText(emptyStateText({ kind: 'favorites' }), { exact: true })).toBeVisible();

  // --- relaunch: a re-made favorite persists, rail count restored ---
  await libraryOption(page, 'All Samples').click();
  await rowHeart(page, 'AD_Kick_01.wav').click();
  await expect(rowHeart(page, 'AD_Kick_01.wav')).toHaveAttribute('aria-pressed', 'true');
  await expect(countSpan(libraryOption(page, 'Favorites'))).toHaveText('1');

  await ntwine.close();
  const second = await launchNtwine({
    userData: fixture.userData,
    appData: fixture.appData,
    libraryRoot: fixture.libraryRoot,
  });
  try {
    await expect(second.page.getByRole('listbox', { name: 'Sample list' })).toBeVisible();
    await expect.poll(() => readCount(second.page)).toBe(fixture.totalSamples);
    await expect(rowHeart(second.page, 'AD_Kick_01.wav')).toHaveAttribute('aria-pressed', 'true');
    await expect(countSpan(libraryOption(second.page, 'Favorites'))).toHaveText('1');
  } finally {
    await second.close();
  }
});
