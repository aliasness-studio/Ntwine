import { ipcMain, nativeImage, type NativeImage } from 'electron';

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
 */
export function registerDragHandler(resolvePath: (sampleId: number) => string | null): void {
  const icon = makeDragIcon();
  ipcMain.on('ntwine:drag-start', (event, sampleId: number) => {
    const file = resolvePath(Number(sampleId));
    if (file) event.sender.startDrag({ file, icon });
  });
}
