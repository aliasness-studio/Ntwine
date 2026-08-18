import type { Page } from '@playwright/test';
import { importAndWait, rowByFilename, snapshot } from './harness/actions';
import { expect, test } from './harness/fixtures';

// Mirrors the shape of the two main-process emit call sites (protocol.ts's `registerProtocols`
// handler, ipc.ts's `decodePreviewPcm` IPC handler) — neither payload has a shared exported type
// to import, so the shape is pinned locally instead.
interface ProtocolEvent {
  scheme: 'sample' | 'cover';
  id: number | null;
  hit: boolean;
}
interface PreviewPcmEvent {
  sampleId: number;
  ok: boolean;
}

/** `player.select`/`moveSelection`/`replay` all write `selectedId` synchronously — this still
 * polls (rather than a bare read) so the wait is a condition, never a timing assumption. */
async function currentSelectedId(page: Page): Promise<number> {
  await expect.poll(async () => (await snapshot(page)).selectedId).not.toBeNull();
  const s = await snapshot(page);
  return s.selectedId as number;
}

/** `getByRole('slider', ...).fill(...)` is refused by Playwright for `input[type=range]` in some
 * versions — the brief's pre-approved fallback sets the value directly and dispatches a real
 * `input` event so React's controlled `onChange` (TopBar.tsx) fires exactly as a user drag would. */
async function setVolumeSlider(page: Page, value: string): Promise<void> {
  const slider = page.getByRole('slider', { name: 'Volume' });
  try {
    await slider.fill(value);
  } catch {
    await slider.evaluate((el: HTMLInputElement, v: string) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  }
}

test('click-to-preview and the keyboard walk go through the protocol/pcm seams, and replay-from-cache fetches nothing new', async ({
  ntwine,
}) => {
  const { page, seam, fixture } = ntwine;
  await importAndWait(page);
  const list = page.getByRole('listbox', { name: 'Sample list' });
  await expect(list.getByRole('option')).toHaveCount(fixture.totalSamples); // sanity before any interaction

  await seam.arm('ntwine:e2e:protocol');
  await seam.arm('ntwine:e2e:preview-pcm');

  // --- click plays + fetches (cache miss) ---
  await rowByFilename(page, 'AD_Kick_01.wav').click();
  const id1 = await currentSelectedId(page);

  await expect.poll(() => seam.count('ntwine:e2e:protocol')).toBeGreaterThanOrEqual(1);
  let protocolEvents = await seam.drain<ProtocolEvent>('ntwine:e2e:protocol');
  expect(protocolEvents).toContainEqual({ scheme: 'sample', id: id1, hit: true });

  await expect.poll(async () => (await snapshot(page)).selectedId).toBe(id1);
  await expect.poll(async () => (await snapshot(page)).playCount).toBe(1);

  // --- keyboard walk: ArrowDown selects + plays the NEXT visible row. Structural, not a second
  // hardcoded filename: querySamples' `ORDER BY p.name, s.filename, s.id` (queries.ts) puts
  // AD_Kick_01.wav first among every row (Alpha Drums sorts first among packs, and it's the
  // alphabetically-first filename inside it) — so DOM position 1 among non-missing options IS
  // "the next visible row" moveSelection(1, visibleIds) lands on. ---
  await list.focus();
  const nonMissing = list.getByRole('option').filter({ hasNot: page.getByTestId('missing-badge') });
  const secondRow = nonMissing.nth(1);

  const protocolCountBeforeDown = await seam.count('ntwine:e2e:protocol');
  await page.keyboard.press('ArrowDown');
  await expect(secondRow).toHaveAttribute('aria-selected', 'true');
  const id2 = await currentSelectedId(page);
  expect(id2).not.toBe(id1);

  await expect.poll(async () => (await snapshot(page)).playCount).toBe(2);
  // A fresh id -> cache miss -> a real fetch, but the fetch itself is async (previewPlayer's
  // `void this.startVoice(...)`) — waiting for the CUMULATIVE count to grow past its pre-ArrowDown
  // baseline (not just ">= 1", which the first click already satisfied) is what makes this
  // deterministic rather than racing the drain against an in-flight fetch.
  await expect.poll(() => seam.count('ntwine:e2e:protocol')).toBeGreaterThan(protocolCountBeforeDown);
  protocolEvents = await seam.drain<ProtocolEvent>('ntwine:e2e:protocol');
  expect(protocolEvents).toContainEqual({ scheme: 'sample', id: id2, hit: true });

  // --- Space replays the SAME selection from previewPlayer's buffer cache: playCount increments
  // again (PlayerStore.replay() -> playPort.play() unconditionally), but resolveBuffer's cache-hit
  // branch never calls fetchBytes at all, so nothing new is fetched. A raw "protocol count didn't
  // grow" comparison would be flaky (a late/retried cover:// fetch shares this same handler and
  // seam), so: drain right before the press (discard anything already settled), then filter the
  // POST-press drain down to `scheme === 'sample'` only. ---
  await seam.drain('ntwine:e2e:protocol'); // discard — clean slate immediately before Space
  await page.keyboard.press('Space');

  await expect.poll(async () => (await snapshot(page)).playCount).toBe(3);
  await expect.poll(async () => (await snapshot(page)).lastPlayedId).toBe(id2); // unchanged — same sample replayed
  protocolEvents = await seam.drain<ProtocolEvent>('ntwine:e2e:protocol');
  expect(protocolEvents.filter((e) => e.scheme === 'sample')).toEqual([]);

  // --- ArrowLeft is the same retrigger (QoL round 1, Splice muscle memory): playCount grows,
  // selection and lastPlayedId stay put, and — like Space — the replay comes from the buffer
  // cache, so no new sample:// fetch. Same drain-then-filter discipline as the Space block. ---
  await seam.drain('ntwine:e2e:protocol');
  await page.keyboard.press('ArrowLeft');

  await expect.poll(async () => (await snapshot(page)).playCount).toBe(4);
  await expect.poll(async () => (await snapshot(page)).lastPlayedId).toBe(id2);
  await expect(secondRow).toHaveAttribute('aria-selected', 'true'); // ArrowLeft never moves selection
  protocolEvents = await seam.drain<ProtocolEvent>('ntwine:e2e:protocol');
  expect(protocolEvents.filter((e) => e.scheme === 'sample')).toEqual([]);

  // --- AIFF fallback: the wav-path WebAudio decode fails, the app falls back to the PCM worker ---
  await rowByFilename(page, 'BK_Pluck.aiff').click();
  const id3 = await currentSelectedId(page);

  await expect.poll(() => seam.count('ntwine:e2e:preview-pcm')).toBeGreaterThanOrEqual(1);
  const pcmEvents = await seam.drain<PreviewPcmEvent>('ntwine:e2e:preview-pcm');
  expect(pcmEvents).toContainEqual({ sampleId: id3, ok: true });

  // --- volume ---
  await setVolumeSlider(page, '0.3');
  await expect.poll(async () => (await snapshot(page)).volume).toBeCloseTo(0.3, 2);
});
