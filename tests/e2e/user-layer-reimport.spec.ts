import { importAndWait, openSettings, openTagsPopover, readCount, rowByFilename, rowHeart } from './harness/actions';
import { expect, test } from './harness/fixtures';

test('a favorite, a nickname, and a user tag on the same row all survive Settings → Re-run import intact, proving the §2.1 file_hash identity guarantee end-to-end', async ({
  ntwine,
}) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);
  const list = page.getByRole('listbox', { name: 'Sample list' });
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // sanity: 12 before any interaction

  const row = rowByFilename(page, 'AD_Kick_01.wav');
  const filenameCell = row.locator('[title="AD_Kick_01.wav"]');

  // --- favorite + nickname + tag the same row, the same mechanics favorites.spec/nickname.spec/
  // user-tags.spec already pin individually ---
  await rowHeart(page, 'AD_Kick_01.wav').click();
  await expect(rowHeart(page, 'AD_Kick_01.wav')).toHaveAttribute('aria-pressed', 'true');

  // The filename cell, not the row's midpoint — see `clickRow` (actions.ts).
  await filenameCell.click();
  await list.focus();
  await page.keyboard.press('n');
  await page.getByLabel('Nickname').fill('Prime Kick');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Nickname')).toHaveCount(0);
  await expect(filenameCell).toContainText('Prime Kick');

  await openTagsPopover(page, 'AD_Kick_01.wav');
  await page.getByLabel('Add tag').fill('keeper');
  await page.keyboard.press('Enter');
  await expect(row.getByTestId('user-tag-chip')).toHaveText('keeper');
  await page.keyboard.press('Escape'); // TagsPopover's own Esc close (document-level capture listener)
  await expect(page.getByLabel('Add tag')).toHaveCount(0);

  // --- Settings -> Re-run import: the same idempotent-reimport mechanics settings.spec already
  // pins ("the same 12 rows survive a second pass"), just with user-layer state riding along ---
  await openSettings(page);
  const reimportButton = page.getByRole('button', { name: 'Re-run import' });
  await reimportButton.click();
  await expect(reimportButton).toBeEnabled(); // 'Importing…' -> 'Re-run import' again: import settled
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // back to 12

  // --- the §2.1 guarantee: sample_state/sample_tags key off file_hash, which the re-import
  // upserts onto the SAME row (ON CONFLICT(file_hash)) rather than replacing it — favorite,
  // nickname, and tag all ride through untouched ---
  await expect(rowHeart(page, 'AD_Kick_01.wav')).toHaveAttribute('aria-pressed', 'true');
  await expect(filenameCell).toContainText('Prime Kick');
  await expect(filenameCell).toHaveAttribute('title', 'AD_Kick_01.wav'); // real filename still the tooltip
  await expect(row.getByTestId('user-tag-chip')).toHaveText('keeper');
});
