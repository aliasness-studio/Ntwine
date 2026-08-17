import { existsSync } from 'node:fs';
import { importAndWait, rowByFilename } from './harness/actions';
import { expect, test } from './harness/fixtures';

// Mirrors drag.ts's one emit call site (the `ntwine:drag-start` `ipcMain.on` handler) — no shared
// exported type to import, so the shape is pinned locally, same convention as preview.spec.ts's
// ProtocolEvent/PreviewPcmEvent.
interface DragPayload {
  sampleId: number;
  file: string | null;
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
  expect(await seam.drain<DragPayload>('ntwine:e2e:drag')).toEqual([{ sampleId: missingId, file: null }]);
});
