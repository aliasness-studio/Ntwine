import { importAndWait, openTagsPopover, readCount, rowByFilename, search, toggleTag } from './harness/actions';
import { expect, test } from './harness/fixtures';

test('T opens the tags popover; adding/removing a user tag updates the row chip and the tag-cloud facet; autocomplete reuses an existing tag by name; and closing a popover via an outside click leaves focus (and the next keystroke) wherever the user actually clicked', async ({
  ntwine,
}) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // sanity: 12 before any interaction

  // Both rows carry exactly 2 Splice tags (drums+kick / drums+snare) — MAX_INLINE_TAGS is 3
  // (SampleRow.tsx), so the one user chip this spec adds to each stays inline instead of folding
  // into the "+N" overflow indicator.
  const firstRow = rowByFilename(page, 'AD_Kick_01.wav');
  const secondRow = rowByFilename(page, 'AD_Snare_01.wav');

  // --- T popover, add 'bounce': row chip + cloud facet ---
  await openTagsPopover(page, 'AD_Kick_01.wav');
  await page.getByLabel('Add tag').fill('bounce');
  await page.keyboard.press('Enter');

  await expect(firstRow.getByTestId('user-tag-chip')).toHaveText('bounce');
  await expect(page.getByRole('button', { name: /^bounce\s*1$/ })).toBeVisible();

  // --- toggling the cloud chip filters to exactly the tagged row ---
  await toggleTag(page, 'bounce');
  await expect.poll(() => readCount(page)).toBe(1);
  await expect(firstRow).toBeVisible();
  await toggleTag(page, 'bounce'); // off
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples);

  // --- search-by-user-tag ---
  await search(page, 'bounce');
  await expect.poll(() => readCount(page)).toBe(1);
  await expect(firstRow).toBeVisible();
  await search(page, '');
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples);

  // --- autocomplete reuse: a second row, typing a prefix offers the existing tag; committing it
  // reuses the SAME `user.tags` row (userDb.ts's addUserTag: reuse by exact normalized name, not
  // by whatever prefix was typed) instead of creating a second, differently-spelled tag. The
  // cloud moving straight to 'bounce 2' — never a separate 'bo 1' chip — is the on-screen proof;
  // "user.tags stays one tag by construction" has no direct renderer-side probe, but a duplicate
  // tag row would surface here as exactly that second, differently-named chip.
  await openTagsPopover(page, 'AD_Snare_01.wav');
  await page.getByLabel('Add tag').fill('bo');
  const suggestion = page.getByRole('button', { name: 'bounce', exact: true });
  await expect(suggestion).toBeVisible();
  await suggestion.click();

  await expect(secondRow.getByTestId('user-tag-chip')).toHaveText('bounce');
  await expect(page.getByRole('button', { name: /^bounce\s*2$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^bo\s*\d+$/ })).toHaveCount(0);

  // --- remove via popover ✕: chip gone, cloud updated (facet refresh pin) ---
  await openTagsPopover(page, 'AD_Kick_01.wav');
  await page.getByRole('button', { name: 'Remove tag bounce' }).click();

  await expect(firstRow.getByTestId('user-tag-chip')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^bounce\s*1$/ })).toBeVisible(); // 2 -> 1, not gone: AD_Snare_01.wav still carries it

  // --- The focus-return guard. SampleList refocuses
  // the list on a popover close ONLY when nothing else already claimed focus (see its own
  // comment there) — without that guard, closing this still-open popover by clicking the search
  // box would yank focus back to the list, and the very next keystroke would hit the list's own
  // F/T/C/N/Delete dispatch instead of landing in the box the user just clicked.
  const searchInput = page.getByLabel('Search samples');
  await searchInput.click();
  await page.keyboard.press('f');

  await expect(page.getByLabel('Add tag')).toHaveCount(0); // the popover closed
  await expect(searchInput).toBeFocused(); // ...but focus stayed on the element the user clicked
  await expect(searchInput).toHaveValue('f'); // ...and the keystroke landed there, not on the list
});
