import {
  importAndWait,
  pickKey,
  readCount,
  setBpm,
  snapshot,
  toggleTag,
  toggleType,
} from './harness/actions';
import { expect, test } from './harness/fixtures';

test('every FilterPanel control narrows/restores the result count, tags AND, and filters clear to {}', async ({
  ntwine,
}) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // sanity: 12 before any filter

  await toggleType(page, 'One-shot');
  await expect.poll(() => readCount(page)).toBe(fixture.counts.oneshot); // 8
  await toggleType(page, 'One-shot'); // off
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // 12

  await toggleType(page, 'Loop');
  await expect.poll(() => readCount(page)).toBe(fixture.counts.loop); // 4
  await toggleType(page, 'Loop'); // off
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // 12

  await pickKey(page, 'c#');
  await expect.poll(() => readCount(page)).toBe(fixture.counts.keyCSharp); // 3
  await pickKey(page, ''); // Any key
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // 12

  await pickKey(page, 'a');
  await expect.poll(() => readCount(page)).toBe(fixture.counts.keyA); // 5
  await pickKey(page, ''); // Any key
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // 12

  await setBpm(page, 100, 140);
  await expect.poll(() => readCount(page)).toBe(fixture.counts.bpm100to140); // 4
  await setBpm(page, '', ''); // clears both bounds
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // 12

  await toggleTag(page, 'kick');
  await expect.poll(() => readCount(page)).toBe(fixture.counts.tagKick); // 4
  // AND, not OR: querySamples' tag filter requires ALL listed tags (HAVING COUNT(DISTINCT...) =
  // wanted.length) — AD_Snare_02 is the one row carrying both kick and snare. The custom message
  // makes an AND->OR regression unambiguous, and pinning the exact count (not just "> 0" or
  // "< kickOrSnare") means an always-empty filter bug can't pass either.
  await toggleTag(page, 'snare');
  await expect
    .poll(() => readCount(page), {
      message: `AND semantics: OR would read ${fixture.counts.kickOrSnare}`,
    })
    .toBe(fixture.counts.kickAndSnare); // 1
  await toggleTag(page, 'kick'); // off
  await toggleTag(page, 'snare'); // off
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // 12

  await toggleTag(page, 'drums');
  await expect.poll(() => readCount(page)).toBe(fixture.counts.tagDrums); // 6
  await toggleTag(page, 'drums'); // off
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // 12

  await toggleTag(page, 'snare');
  await expect.poll(() => readCount(page)).toBe(fixture.counts.tagSnare); // 2
  await toggleTag(page, 'snare'); // off
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // 12

  // The tag-list text filter is local component state (FilterPanel's own `tagQuery`) — it narrows
  // which chips are OFFERED, never touches `library.filters`, so no readCount poll applies here.
  await page.getByLabel('Filter tag list').fill('sna');
  await expect(page.getByRole('button', { name: /^snare\s*\d+$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^kick\s*\d+$/ })).toHaveCount(0);

  // LibraryStore.patchFilters deletes cleared keys rather than leaving them `undefined` — every
  // dimension above was toggled back off, so the live filters object is exactly empty.
  await expect.poll(async () => (await snapshot(page)).filters).toEqual({});
});
