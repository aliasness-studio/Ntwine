import { importAndWait, readCount, search } from './harness/actions';
import { expect, test } from './harness/fixtures';

test('search matches filename/tag/pack-name tokens by FTS5 prefix, and clears back to the full library', async ({
  ntwine,
}) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // sanity: 12 before any search

  // fixture.counts.searchKick IS the tokenizer model (library.ts's own doc comment): a row
  // matches if some token in its filename, its parsed tags, or its pack name starts with "kick" —
  // the same shape as the real `kick*` FTS5 prefix query search.ts builds over sample_search's
  // filename/pack_name/tag_text columns. If the app disagrees with this number, the derivation —
  // not a guess — names which side is wrong.
  await search(page, 'kick');
  await expect.poll(() => readCount(page)).toBe(fixture.counts.searchKick); // 4

  await search(page, 'kic'); // prefix match — same token, same row set
  await expect.poll(() => readCount(page)).toBe(fixture.counts.searchKick);

  // pack_name is an indexed FTS column too: 'Alpha' only tokenizes out of the Alpha Drums pack
  // name (no filename/tag in this fixture starts with it), so this counts every row in that pack
  // — present or missing — same definition as perPack.
  await search(page, 'Alpha');
  await expect.poll(() => readCount(page)).toBe(fixture.perPack['Alpha Drums']); // 6

  await search(page, 'zzzqqq');
  await expect.poll(() => readCount(page)).toBe(0);
  await expect(page.getByTestId('result-count')).toHaveText('0 samples');

  await search(page, '');
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // 12

  // NFD pins: fixture.nfdFilename's accented 'e' is stored as a decomposed 'e' + combining acute
  // (U+0301), never NFC-normalized on the way in (library.ts) or on the way to FTS5. Both queries
  // below are plain-ASCII prefixes of that name — what SQLite's unicode61 tokenizer actually does
  // with the combining mark isn't derivable from the fixture model the way searchKick is, so
  // these are measured once and pinned as-found rather than predicted.
  await search(page, 'Caf');
  // pinned as-is (time capsule): FTS5 unicode61 folding on the NFD filename
  await expect.poll(() => readCount(page)).toBe(1);

  await search(page, fixture.nfdFilename.slice(0, 7)); // 'GF_Cafe'
  // pinned as-is (time capsule): FTS5 unicode61 folding on the NFD filename
  await expect.poll(() => readCount(page)).toBe(1);
});
