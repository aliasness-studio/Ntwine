import { importAndWait, readCount, rowByFilename, search } from './harness/actions';
import { expect, test } from './harness/fixtures';

test('N edits the selected row nickname in place, the real filename stays the title tooltip, a mixed-vocabulary search finds it via nickname+FTS, and clearing restores the filename', async ({
  ntwine,
}) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);
  const list = page.getByRole('listbox', { name: 'Sample list' });
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // sanity: 12 before any interaction

  const row = rowByFilename(page, 'AD_Kick_01.wav');
  const filenameCell = row.locator('[title="AD_Kick_01.wav"]');

  // The filename cell, not the row's midpoint — see `clickRow` (actions.ts): a row's pack/key/bpm/
  // tag cells navigate on click now, and which one the midpoint lands on depends on window width.
  await filenameCell.click();
  await list.focus();
  await page.keyboard.press('n');

  const input = page.getByLabel('Nickname');
  await input.fill('THE snare');
  await page.keyboard.press('Enter');

  await expect(input).toHaveCount(0); // editor closes on commit, back to the display cell
  await expect(filenameCell).toHaveAttribute('title', 'AD_Kick_01.wav'); // real filename stays the tooltip
  await expect(filenameCell).toContainText('THE snare');

  // §3.4 mixed-vocabulary search: 'snare kick' AND-composes two tokens, sources unioned PER
  // token (queries.ts's wordPrefixMatch/readUserTextWithIds). AD_Snare_02.wav matches natively —
  // its Splice tags carry both 'snare' and 'kick' (fixture.counts.kickAndSnare's one row).
  // AD_Kick_01.wav now ALSO matches, but from two DIFFERENT sources: 'kick' from its own
  // filename/tags, 'snare' only from the nickname just typed — the mixed-vocabulary case this
  // spec exists to pin. No other row carries both tokens from any source, so the count is
  // exactly one more than the native match.
  await search(page, 'snare kick');
  await expect.poll(() => readCount(page)).toBe(fixture.counts.kickAndSnare + 1); // 2
  await expect(rowByFilename(page, 'AD_Kick_01.wav')).toBeVisible();

  await search(page, '');
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples);

  // --- clear nickname (N, empty, Enter) -> filename text restored ---
  await filenameCell.click();
  await list.focus();
  await page.keyboard.press('n');

  const input2 = page.getByLabel('Nickname');
  await expect(input2).toHaveValue('THE snare'); // sanity: editor reopens pre-filled with the current nickname
  await input2.fill('');
  await page.keyboard.press('Enter');

  await expect(input2).toHaveCount(0);
  await expect(filenameCell).toHaveText('AD_Kick_01.wav');
  await expect(filenameCell).toHaveAttribute('title', 'AD_Kick_01.wav');
});
