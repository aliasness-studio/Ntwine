import { existsSync } from 'node:fs';
import { DRAG_CARD } from '../../src/renderer/dragImage';
import { importAndWait, rowByFilename } from './harness/actions';
import { expect, test } from './harness/fixtures';

// Mirrors drag.ts's one emit call site (the `ntwine:drag-start` `ipcMain.handle` handler) — no shared
// exported type to import, so the shape is pinned locally, same convention as preview.spec.ts's
// ProtocolEvent/PreviewPcmEvent.
interface DragPayload {
  sampleId: number;
  file: string | null;
  /** Which image `webContents.startDrag` would have carried — see drag.ts's `registerDragHandler`.
   * 'card' is the renderer-painted drag card (dragImage.ts); 'fallback' is main's own generated
   * 24x24 square. A headless run starts no OS drag session, so this label is the only way to
   * observe the icon at all. */
  icon: 'card' | 'fallback';
  /** The resolved `NativeImage`'s LOGICAL size — what the OS sizes the drag window to. */
  iconSize: { width: number; height: number };
}

test('drag runs a real row through IPC to main resolution, and the missing row refuses both at the renderer guard and via a direct IPC bypass', async ({
  ntwine,
}) => {
  const { page, seam, fixture } = ntwine;
  await importAndWait(page);
  await seam.arm('ntwine:e2e:drag');

  // --- a real row's dragstart: SampleRow's handler calls api.startDrag, main resolves the id
  // through the catalog and emits an absolute, in-library, EXISTING file. E2E mode observes the
  // decision instead of ever calling webContents.startDrag — no OS drag session in a headless run. ---
  await rowByFilename(page, 'AD_Kick_01.wav').dispatchEvent('dragstart');
  await expect.poll(() => seam.count('ntwine:e2e:drag')).toBe(1);
  const [first] = await seam.drain<DragPayload>('ntwine:e2e:drag');
  expect(typeof first.sampleId).toBe('number');
  expect(first.file).not.toBeNull();
  expect(first.file!.startsWith(fixture.libraryRoot)).toBe(true);
  expect(existsSync(first.file!)).toBe(true);
  // The drag goes out under the renderer's own card, not main's placeholder square. This is the
  // only end-to-end proof of the whole chain — SampleRow painting a real canvas, the PNG data URL
  // surviving the bridge, and `resolveDragIcon` decoding it to a non-empty NativeImage — since
  // every link in it is invisible from the DOM.
  expect(first.icon).toBe('card');

  // What the OS actually draws is `logical_size x display_scale`, and the card is sized on the
  // promise that this equals its bitmap — the premise DRAG_CARD's 192px width is chosen under,
  // given Windows clips a drag image near 210px. Asserting the product (rather than the logical
  // size directly) is what keeps this true on a display of any ratio. Two earlier attempts at this
  // feature shipped a card the OS cut the edges off, and nothing in the DOM or in `icon` above
  // could see it — only these numbers can.
  const displayScale = await page.evaluate(() => window.devicePixelRatio);
  expect(first.iconSize.width * displayScale).toBeCloseTo(DRAG_CARD.width, 0);
  expect(first.iconSize.height * displayScale).toBeCloseTo(DRAG_CARD.height, 0);

  // --- the missing row is never actually draggable (draggable={!row.missing}); a synthetically
  // dispatched dragstart still invokes the listener (the only way to mechanically drive an
  // "attempt" — see SampleRow.tsx's own comment on handleDragStart), but the handler returns
  // before api.startDrag when row.missing — it contributes NOTHING to the seam. A second REAL
  // row's dragstart right after is what proves it: the counter goes 1 -> 2, never 1 -> 3. ---
  const missingRow = rowByFilename(page, fixture.missingFilename);
  await expect(missingRow).toHaveAttribute('draggable', 'false');
  await missingRow.dispatchEvent('dragstart');
  await rowByFilename(page, 'AD_Kick_02.wav').dispatchEvent('dragstart');
  await expect.poll(() => seam.count('ntwine:e2e:drag')).toBe(2);
  await seam.drain('ntwine:e2e:drag'); // discard — holds AD_Kick_02.wav's payload, not under test here

  // --- bypassing the renderer guard entirely: the direct IPC call reaches main with the missing
  // row's id, which resolves null (the catalog's own missing flag, protocol.ts's
  // resolveSampleAbsPath) and emits the refusal itself — exactly one payload, file: null. ---
  const missingId = await page.evaluate(async () =>
    (await window.ntwine.querySamples({})).find((r) => r.missing)!.id,
  );
  await page.evaluate((id) => window.ntwine.startDrag(id), missingId);
  await expect.poll(() => seam.count('ntwine:e2e:drag')).toBe(3);
  expect(await seam.drain<DragPayload>('ntwine:e2e:drag')).toEqual([
    { sampleId: missingId, file: null, icon: 'fallback', iconSize: { width: 24, height: 24 } },
  ]);
});
