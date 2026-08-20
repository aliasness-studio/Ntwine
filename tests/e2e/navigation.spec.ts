// Cross-navigation (QoL round 2, 2026-08-20): a row's pack / key / bpm / tag cells are links, and
// every hop they make is reversible. This drives the whole loop through the real renderer — follow
// a link, watch the result set actually change, then unwind it three different ways (the back
// button, Alt+Left, a crumb's ✕) — because the failure mode this guards against is a link that
// LOOKS live but leaves `filters` untouched, which no unit test of the store can catch.
import { clickRow, importAndWait, readCount, rowByFilename } from './harness/actions';
import { expect, test } from './harness/fixtures';

// Local copy, same as collections.spec.ts keeps: a fixture-supplied pack name is dropped into a
// RegExp as a literal, never as a pattern.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('row cells link to their pack, key, bpm and tags — and every hop unwinds', async ({ ntwine }) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // 12, unfiltered

  const list = page.getByRole('listbox', { name: 'Sample list' });
  const navBar = page.getByTestId('nav-bar');
  const crumbs = page.getByTestId('nav-crumb-label'); // the label alone — a crumb's own text includes its ✕
  const linkRow = rowByFilename(page, fixture.keyBpmRow.filename); // AD_Loop_128_kick.wav
  const pack = fixture.keyBpmRow.pack;

  // Nothing is narrowing the view and there's nowhere to go back to, so the bar isn't there at all
  // — its absence is what keeps the default view at full height.
  await expect(navBar).toHaveCount(0);

  // --- pack link: the row navigates to its own pack, and the RAIL agrees it's the current scope
  // (one browse state, two surfaces — a row link that scoped the list without moving the rail
  // would be the "two sources of truth" bug) ---
  await linkRow.getByRole('button', { name: `Show pack ${pack}` }).click();
  await expect.poll(() => readCount(page)).toBe(fixture.perPack[pack]);
  await expect(crumbs).toHaveText([pack]);
  await expect(
    page
      .getByRole('listbox', { name: 'Packs' })
      .getByRole('option', { name: new RegExp(`^${escapeRegExp(pack)}\\s*\\d+$`) }),
  ).toHaveAttribute('aria-selected', 'true');

  // --- back button: all the way out, and the bar disappears again with the last step ---
  await page.getByTestId('nav-back').click();
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples);
  await expect(navBar).toHaveCount(0);

  // --- key link: 'C♯ min' filters on the pitch class alone (c#), matching what the FilterPanel's
  // own key select does — the crumb shows the same 'C♯' label the cell did ---
  await linkRow.getByRole('button', { name: 'Filter by key C♯' }).click();
  await expect.poll(() => readCount(page)).toBe(fixture.counts.keyCSharp);
  await expect(crumbs).toHaveText(['C♯']);

  // --- Clear all: one press drops every crumb (and stays reversible, so the bar remains) ---
  await page.getByTestId('nav-clear').click();
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples);
  await expect(crumbs).toHaveCount(0);

  // --- bpm link: an exact-tempo filter. Asserted as an invariant over the RESULT rows rather than
  // against a hardcoded count — every row that survives must show the tempo that was clicked ---
  await linkRow.getByRole('button', { name: `Filter by ${fixture.keyBpmRow.bpmText} BPM` }).click();
  await expect(crumbs).toHaveText([`${fixture.keyBpmRow.bpmText} BPM`]);
  await expect.poll(async () => {
    const labels = await list
      .getByRole('option')
      .locator('button[aria-label$=" BPM"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
    return [...new Set(labels)];
  }).toEqual([`Filter by ${fixture.keyBpmRow.bpmText} BPM`]);

  // --- Alt+Left unwinds the same way the button does (the browser convention, on App.tsx's
  // window-level capture listener) ---
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples);

  // --- tag chip: filters by that tag, and the crumb's own ✕ removes exactly it ---
  const tagRow = rowByFilename(page, fixture.durationRow.filename); // tags: drums, kick, punchy
  await tagRow.getByRole('button', { name: 'Filter by tag kick' }).click();
  await expect.poll(() => readCount(page)).toBe(fixture.counts.tagKick);
  await expect(crumbs).toHaveText(['kick']);

  await page.getByRole('button', { name: 'Remove filter kick' }).click();
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples);
  await expect(crumbs).toHaveCount(0);
});

// Following a link must never disturb what's selected or what's playing — the same contract the
// favorite heart already holds (design spec §5.2). A link that stole the selection would make
// every navigation also change the preview, which is exactly the kind of "why did it do that"
// behaviour this round of work exists to remove.
test('following a link leaves selection and playback alone', async ({ ntwine }) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);

  const row = rowByFilename(page, fixture.keyBpmRow.filename);
  await clickRow(page, fixture.keyBpmRow.filename);
  await expect(row).toHaveAttribute('aria-selected', 'true');

  await row.getByRole('button', { name: 'Filter by key C♯' }).click();
  await expect.poll(() => readCount(page)).toBe(fixture.counts.keyCSharp);

  // The row survives the filter it just applied (it carries that key), and it's still the selected
  // one — the click reached the link, never the row underneath it.
  await expect(rowByFilename(page, fixture.keyBpmRow.filename)).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
