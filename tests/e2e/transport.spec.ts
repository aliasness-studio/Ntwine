// Transport dock (2026-08-23): the rail-footer Stop button and the autoplay toggle, driven through
// the real renderer. Both need e2e rather than store tests alone, because both failure modes are
// invisible to a unit test of PlayerStore: a Stop button wired to nothing still leaves the DOM
// exactly as it found it (the store deliberately keeps the selection), and an autoplay toggle that
// flips a field nobody reads still renders a pressed-looking button. `stopCount` (e2eTypes.ts)
// exists precisely so silence is observable at all.
import { clickRow, importAndWait, rowByFilename, snapshot } from './harness/actions';
import { expect, test } from './harness/fixtures';

test('Stop silences playback without giving up the selection', async ({ ntwine }) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);

  const stopButton = page.getByTestId('transport-stop');
  await expect(stopButton).toBeEnabled();

  await clickRow(page, fixture.keyBpmRow.filename);
  await expect.poll(async () => (await snapshot(page)).playCount).toBe(1);
  expect((await snapshot(page)).stopCount).toBe(0);

  const selectedBefore = (await snapshot(page)).selectedId;
  expect(selectedBefore).not.toBeNull();

  await stopButton.click();
  await expect.poll(async () => (await snapshot(page)).stopCount).toBe(1);

  // The row stays selected — that's the contract that keeps ← / Space useful after a Stop, and it
  // is also why stopCount has to exist: without it this whole interaction leaves no trace.
  expect((await snapshot(page)).selectedId).toBe(selectedBefore);
  await expect(rowByFilename(page, fixture.keyBpmRow.filename)).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // Stopped, not unloaded: the same selection replays on demand.
  await page.getByRole('listbox', { name: 'Sample list' }).focus();
  await page.keyboard.press('Space');
  await expect.poll(async () => (await snapshot(page)).playCount).toBe(2);
  expect((await snapshot(page)).lastPlayedId).toBe(selectedBefore);
});

// Stop cures the accidental 30-second trigger; this prevents it. Note every "playCount is still N"
// assertion below is paired with a positive one proving the gesture actually landed (the selection
// moved) — and that pairing is what makes it deterministic rather than a race: wrapPlayPort
// increments BEFORE delegating and PlayerStore.select is synchronous, so by the time selectedId
// has changed, the decision whether to play has already been taken.
test('autoplay off browses in silence; Space and ← still play on demand', async ({ ntwine }) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);

  const toggle = page.getByTestId('transport-autoplay');
  const list = page.getByRole('listbox', { name: 'Sample list' });

  // Defaults on — v1's behaviour is what you get until you say otherwise.
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect((await snapshot(page)).autoplay).toBe(true);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await snapshot(page)).autoplay).toBe(false);

  // --- a click now SELECTS without sounding ---
  await clickRow(page, fixture.keyBpmRow.filename);
  await expect(rowByFilename(page, fixture.keyBpmRow.filename)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const clickedId = (await snapshot(page)).selectedId;
  expect(clickedId).not.toBeNull();
  expect((await snapshot(page)).playCount).toBe(0);

  // --- and so does the arrow-key walk, which is the gesture that made this worth building ---
  await list.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await snapshot(page)).selectedId).not.toBe(clickedId);
  const walkedId = (await snapshot(page)).selectedId;
  expect((await snapshot(page)).playCount).toBe(0);

  // --- Space is an explicit ask, so it plays regardless of the preference ---
  await page.keyboard.press('Space');
  await expect.poll(async () => (await snapshot(page)).playCount).toBe(1);
  expect((await snapshot(page)).lastPlayedId).toBe(walkedId);

  // --- ← is the same action (SampleList binds both to replay), and behaves the same way ---
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await snapshot(page)).playCount).toBe(2);
  expect((await snapshot(page)).lastPlayedId).toBe(walkedId);

  // --- back on: landings sound again ---
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await clickRow(page, fixture.durationRow.filename);
  await expect.poll(async () => (await snapshot(page)).playCount).toBe(3);
});
