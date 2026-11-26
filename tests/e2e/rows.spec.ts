import { importAndWait, rowByFilename } from './harness/actions';
import { expect, test } from './harness/fixtures';

// Cells are addressed by testid (`row-key`/`row-bpm`/`row-duration`, SampleRow.tsx). This used to
// be child position — `:scope > span` plus an index — which broke once a cell became either a span
// or a button depending on whether it has a value to link to: the same index then means different
// cells on different rows. Naming them also lets the assertions target the row's cell texts
// rather than a bare '—' anywhere: a bpm-0 row shows '—' in TWO cells (key AND bpm) for two
// independently-NULL reasons, and a bare `toContainText('—')` can't tell those apart from a third,
// actually-broken cell.

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
  await expect(nullDurationRow.getByTestId('row-duration')).toHaveText('—'); // formatDuration(null)

  // AD_Kick_01.wav: bpm 0 (normalizeSample maps 0 -> NULL) and a real NULL audio_key — one row,
  // two independently-NULL cells, no fixture field of its own (not one of the named rows above).
  const bpmZeroRow = rowByFilename(page, 'AD_Kick_01.wav');
  await expect(bpmZeroRow.getByTestId('row-key')).toHaveText('—');
  await expect(bpmZeroRow.getByTestId('row-bpm')).toHaveText('—');

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
