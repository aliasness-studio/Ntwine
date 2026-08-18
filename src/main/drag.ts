import { ipcMain, nativeImage, type NativeImage } from 'electron';
import { existsSync } from 'node:fs';
import type { E2EEmit } from './e2e';

export function makeDragIcon(): NativeImage {
  const size = 24;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) buf.set([48, 44, 40, 255], i * 4); // BGRA, must be non-empty on macOS
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

/**
 * Wires `ntwine:drag-start` (renderer `startDrag(sampleId)`, preload.ts) to
 * `webContents.startDrag`. `resolvePath` is the injection seam: Task 2's spike closed over one
 * hardcoded file; Task 11 re-points it at `resolveSampleAbsPath` (protocol.ts) closed over the
 * live catalog + current library root — the SAME resolution core (row must exist, `missing = 0`,
 * containment) the `sample://` protocol and `decodePreviewPcm` use, not a fourth independently-
 * maintained copy of that question. A null result (unknown id, missing-flagged row, or a
 * would-escape-the-root row) is a silent no-op — no drag starts, no error surfaces (spec §8:
 * "Drag of missing file -> Drag refused, row flashes its badge"; the flash itself is a renderer
 * concern, not this function's).
 *
 * `ipcMain.handle`, not `.on` (Task 6, design spec §4: "startDrag is promoted from
 * `ipcRenderer.send` to `invoke`"): `event.sender.startDrag` blocks the main process until the OS
 * drag session ends, so this handler's own resolution — the async function returning — already
 * IS the drag-end signal the drag-into-collection slot (spec §7) needs, with no separate push
 * event required.
 *
 * `e2eEmit` (Task 1, e2e spec §3.1): when armed, observes the exact startDrag decision instead of
 * calling `webContents.startDrag` and returns immediately — an OS drag session blocks the main
 * process until mouse-up, which no headless run can deliver, so under e2e the invoke's
 * resolution carries no drag-end meaning (spec §7's E2E note).
 */
export function registerDragHandler(
  resolvePath: (sampleId: number) => string | null,
  e2eEmit: E2EEmit | null = null,
): void {
  const icon = makeDragIcon();
  ipcMain.handle('ntwine:drag-start', async (event, sampleId: number) => {
    const resolved = resolvePath(Number(sampleId));
    // resolvePath only checks the DB row (missing flag) and path containment — not the
    // filesystem itself, so a file deleted since the last statPass (importer.ts) can still
    // resolve here. decodePreviewPcm re-stats before touching the file (ipc.ts); startDrag has no
    // re-stat of its own, so this existsSync is it. A vanished file is a silent no-op, same as
    // any other resolvePath null (spec §8: "Drag of missing file -> Drag refused").
    const file = resolved && existsSync(resolved) ? resolved : null;
    // E2E mode observes the exact startDrag decision and SKIPS the native drag: an OS drag session
    // blocks until mouse-up, which no headless run can deliver (e2e spec §3.1). Resolves
    // immediately — spec §7's e2e note.
    if (e2eEmit) {
      e2eEmit('ntwine:e2e:drag', { sampleId: Number(sampleId), file });
      return;
    }
    // Blocks until the OS drag session ends; the handler's resolution IS drag-end.
    if (file) event.sender.startDrag({ file, icon });
  });
}
