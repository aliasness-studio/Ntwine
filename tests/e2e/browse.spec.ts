import type { Locator } from '@playwright/test';
import { clickPack, importAndWait, readCount } from './harness/actions';
import { expect, test } from './harness/fixtures';

// PackRail.tsx's `Item` renders exactly two <span> children for every option — `Name` then
// `Count` (the "All Samples" row's icon and a pack's cover are both non-span elements: a <div> or
// an <img>) — so the first/last `span` picks out Name/Count unambiguously without a testid.
// Task 6's operational note offers a choice here (strip a known prefix off raw textContent, or
// locate the count directly); this is the latter, since it sidesteps the "no guaranteed
// whitespace between Name and Count" gotcha `clickPack`'s own doc comment (actions.ts) already
// flags for the accessible-name reading.
function nameSpan(option: Locator): Locator {
  return option.locator('span').first();
}
function countSpan(option: Locator): Locator {
  return option.locator('span').last();
}

test('the pack rail lists every pack with covers, and pack selection scopes the sample list', async ({
  ntwine,
}) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);

  const packListbox = page.getByRole('listbox', { name: 'Packs' });
  const options = packListbox.getByRole('option');
  const expectedNames = ['All Samples', ...fixture.packs]; // rail order = name asc (listPacks)
  await expect(options).toHaveCount(expectedNames.length); // 4

  for (const [i, name] of expectedNames.entries()) {
    await expect(nameSpan(options.nth(i)), `option ${i} name`).toHaveText(name);
  }

  // Covers: both covered packs show a real decoded <img> addressed through the cover:// scheme;
  // the uncovered pack falls back to the generic tile (PackRail.tsx's PackCover, driven by the
  // <img>'s onError once the cover:// protocol 404s).
  for (const packName of fixture.coveredPacks) {
    const option = options.nth(expectedNames.indexOf(packName));
    const img = option.locator('img');
    await expect(img).toHaveAttribute('src', /^cover:\/\/p\//);
    await expect
      .poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth))
      .toBeGreaterThan(0);
  }
  const uncoveredOption = options.nth(expectedNames.indexOf(fixture.uncoveredPack));
  await expect(uncoveredOption.getByTestId('cover-fallback')).toBeVisible();

  // Selecting a pack scopes the top-bar count — querySamples counts every row for that pack,
  // present or missing, so this is perPack (all rows), not perPackPresent. "All Samples" clears
  // the scope back to the full library.
  await clickPack(page, fixture.packs[0]);
  await expect.poll(() => readCount(page)).toBe(fixture.perPack[fixture.packs[0]]); // 6
  await clickPack(page, 'All Samples');
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // 12

  // The rail counts are the OTHER answer, and deliberately so: listPacks' inner join requires
  // `s.missing = 0`, so "All Samples"' own count (the sum of every rail sampleCount) and each
  // pack's rail count both read PRESENT-only. Top bar 12 vs. rail 11 disagreeing is today's
  // behaviour, pinned on purpose — a future "make them agree" change has to touch this spec.
  await expect(countSpan(options.nth(0))).toHaveText(String(fixture.presentSamples)); // 11, not 12
  const uncoveredPresentCount = fixture.perPackPresent[fixture.uncoveredPack];
  await expect(countSpan(uncoveredOption)).toHaveText(String(uncoveredPresentCount)); // 2, not 3
});
