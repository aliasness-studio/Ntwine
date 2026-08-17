import { ipcMain, nativeImage, type NativeImage } from 'electron';

export function makeDragIcon(): NativeImage {
  const size = 24;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) buf.set([48, 44, 40, 255], i * 4); // BGRA, must be non-empty on macOS
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export function registerDragHandler(resolvePath: (sampleId: number) => string | null): void {
  const icon = makeDragIcon();
  ipcMain.on('ntwine:drag-start', (event, sampleId: number) => {
    const file = resolvePath(Number(sampleId));
    if (file) event.sender.startDrag({ file, icon });
  });
}
