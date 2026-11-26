import { importAndWait, rowByFilename, snapshot, waitForWaveform } from './harness/actions';
import { expect, test } from './harness/fixtures';

test('every visible non-missing row fills its waveform with real peaks; the missing row keeps its placeholder', async ({
  ntwine,
}) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);

  const list = page.getByRole('listbox', { name: 'Sample list' });
  const allOptions = list.getByRole('option');
  // 12 rows x 40px all fit the window under the virtualizer's overscan=12 (SampleList.tsx) —
  // every row is a real DOM node from the start, no scrolling needed to reach any of them.
  await expect(allOptions).toHaveCount(fixture.totalSamples);

  // rows.spec.ts pins the missing-badge testid to exactly the one missing row — filtering it out
  // here is the structural version of the same fact, giving "every visible non-missing row"
  // without hand-listing the other 11 filenames.
  const nonMissing = allOptions.filter({ hasNot: page.getByTestId('missing-badge') });
  await expect(nonMissing).toHaveCount(fixture.presentSamples);

  const nonMissingCount = await nonMissing.count();
  for (let i = 0; i < nonMissingCount; i++) {
    await waitForWaveform(nonMissing.nth(i).locator('canvas'), true);
  }

  // AIFF real-decode proof: rows.spec's "no couldn't-decode badge"
  // assertion runs immediately after import — before the background waveform pass
  // (main/waveforms: decodeAudio -> computePeaks -> the `waveforms` table) has necessarily
  // reached these two rows — so it cannot fail via a real AIFF-decode regression in that
  // pipeline (rows are never re-queried after the pass). Both aiff rows are already inside the
  // `nonMissing` sweep above; re-asserting them individually here means if the main-process AIFF
  // decode ever breaks, THIS spec goes red where rows.spec structurally cannot.
  for (const filename of fixture.aiffFilenames) {
    await waitForWaveform(rowByFilename(page, filename).locator('canvas'), true);
  }

  // The missing row never had a file to decode — WaveformThumb's `peaks === null` branch draws
  // only the flat placeholder line, so `isRealWaveform` reads false immediately and stays false.
  // Asserted once, after every real row is confirmed real, so a real row that's merely slow to
  // fill could never be misread as "the missing placeholder is correct" by accident.
  const missingRow = rowByFilename(page, fixture.missingFilename);
  await waitForWaveform(missingRow.locator('canvas'), false);

  await expect
    .poll(async () => (await snapshot(page)).peaksCached)
    .toBeGreaterThanOrEqual(fixture.presentSamples);
});
