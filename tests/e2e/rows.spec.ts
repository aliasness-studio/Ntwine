import type { Locator } from '@playwright/test';
import { importAndWait, rowByFilename } from './harness/actions';
import { expect, test } from './harness/fixtures';

// SampleRow.tsx's cells carry no testid/aria-label to target individually — but its direct
// children are, in JSX order (for a non-missing row): Filename, PackName, KeyCell, BpmCell,
// DurationCell (all <span>s), then Tags (a <div>, never picked up by a `span` selector). Position
// is the only handle available, so it's documented once here rather than scattered magic `.nth()`
// calls — and it's what the brief's "assert on the row's cell texts, not a bare '—' anywhere"
// requires: a bpm-0 row shows '—' in TWO cells (key AND bpm) for two independently-NULL reasons,
// and a bare `toContainText('—')` couldn't tell those apart from a third, actually-broken cell.
const KEY_CELL = 2;
const BPM_CELL = 3;
const DURATION_CELL = 4;
function cell(row: Locator, index: number): Locator {
  return row.locator(':scope > span').nth(index);
}

test('sample rows render key/bpm/duration/tags formatting and the missing/NFD/AIFF edge cases', async ({
  ntwine,
}) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);

  const keyBpmRow = rowByFilename(page, fixture.keyBpmRow.filename);
  await expect(keyBpmRow).toContainText(fixture.keyBpmRow.pack);
  await expect(keyBpmRow).toContainText(fixture.keyBpmRow.keyText); // 'C♯ min'
  await expect(keyBpmRow).toContainText(fixture.keyBpmRow.bpmText); // '128'

  const durationRow = rowByFilename(page, fixture.durationRow.filename);
  await expect(durationRow).toContainText(fixture.durationRow.durationText); // '1.4s'
  for (const tag of fixture.durationRow.tags) {
    await expect(durationRow).toContainText(tag); // drums, kick, punchy — parseTags order, first 3
  }

  const nullDurationRow = rowByFilename(page, fixture.nullDurationFilename);
  await expect(cell(nullDurationRow, DURATION_CELL)).toHaveText('—'); // formatDuration(null)

  // AD_Kick_01.wav: bpm 0 (normalizeSample maps 0 -> NULL) and a real NULL audio_key — one row,
  // two independently-NULL cells, no fixture field of its own (not one of the named rows above).
  const bpmZeroRow = rowByFilename(page, 'AD_Kick_01.wav');
  await expect(cell(bpmZeroRow, KEY_CELL)).toHaveText('—');
  await expect(cell(bpmZeroRow, BPM_CELL)).toHaveText('—');

  const missingRow = rowByFilename(page, fixture.missingFilename);
  await expect(missingRow.getByTestId('missing-badge')).toBeVisible();
  await expect(missingRow).toHaveCSS('opacity', '0.4');

  // The encoding assertion: fixture.nfdFilename's exact decomposed (NFD) bytes round-tripped
  // through statPass on THIS filesystem — the first thing to read on the Windows run, where
  // NTFS's normalization behaviour is the open question.
  const nfdRow = rowByFilename(page, fixture.nfdFilename);
  await expect(nfdRow).toBeVisible();
  await expect(nfdRow.getByTestId('missing-badge')).toHaveCount(0);

  for (const filename of fixture.aiffFilenames) {
    const aiffRow = rowByFilename(page, filename);
    await expect(aiffRow).toBeVisible();
    await expect(aiffRow.getByTestId('missing-badge')).toHaveCount(0);
    await expect(aiffRow.locator('[title="couldn\'t decode"]')).toHaveCount(0);
  }
});
