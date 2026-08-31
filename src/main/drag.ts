import { ipcMain, nativeImage, type NativeImage } from 'electron';
import { existsSync } from 'node:fs';
import type { DragIcon } from '../shared/ipcTypes';
import type { E2EEmit } from './e2e';

/**
 * The floor under every drag: a flat 24x24 square. It exists because macOS refuses an EMPTY drag
 * icon, not because it communicates anything — which is exactly why the renderer now draws a real
 * card (src/renderer/dragImage.ts) and this is only the fallback for when it can't.
 */
export function makeDragIcon(): NativeImage {
  const size = 24;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) buf.set([48, 44, 40, 255], i * 4); // BGRA, must be non-empty on macOS
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

/**
 * Ceiling on the base64 payload of a renderer-supplied drag card. The real card is a 192x96 PNG,
 * a handful of KB, so this is orders of magnitude of headroom — present only so a bug (or a
 * compromised renderer) can't hand the main process an unbounded string to base64-decode inside a
 * synchronous IPC handler.
 */
export const DRAG_ICON_MAX_BYTES = 4 * 1024 * 1024;

/** Chromium tops out around 3x; anything outside this range is a bug, not a display we support. */
const MAX_SCALE_FACTOR = 4;

// Deliberately strict: `nativeImage.createFromBuffer` is fed the decoded bytes, so the only shape
// worth accepting is the one `renderDragCard` produces (`canvas.toDataURL('image/png')`). Anything
// else — an http url, an svg data url, a bare string — is not a near-miss to be repaired, it is a
// sign the argument didn't come from the card renderer at all.
const PNG_DATA_URL_RE = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Turns the renderer's drag card into the `NativeImage` `webContents.startDrag` wants, or returns
 * `fallback` if it can't. NEVER throws and never refuses the drag itself: a drag that goes out
 * under the plain square is a cosmetic regression, whereas a drag that fails to start is the app's
 * make-or-break feature breaking, so every failure mode here degrades instead of propagating.
 *
 * `icon.scaleFactor` is forwarded to `createFromBuffer` verbatim. It is the RENDERER's
 * `devicePixelRatio`, sent to cancel the display's own scaling so the card is drawn at exactly its
 * bitmap size — the property the card's width is sized against, since Windows clips a drag image
 * near 210 device pixels wide (dragImage.ts's `DRAG_CARD` records the measurement). Validated, not
 * trusted: a nonsense factor would silently resize the drag image rather than fail.
 */
export function resolveDragIcon(icon: DragIcon | null | undefined, fallback: NativeImage): NativeImage {
  if (!icon) return fallback;
  const { dataUrl, scaleFactor } = icon;
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0 || scaleFactor > MAX_SCALE_FACTOR) return fallback;
  if (typeof dataUrl !== 'string' || dataUrl.length > DRAG_ICON_MAX_BYTES) return fallback;

  const match = PNG_DATA_URL_RE.exec(dataUrl);
  if (match === null) return fallback;

  try {
    const image = nativeImage.createFromBuffer(Buffer.from(match[1], 'base64'), { scaleFactor });
    // A NativeImage that failed to decode is empty rather than null — the same "empty icon is
    // rejected on macOS" hazard makeDragIcon exists for, so it must never reach startDrag.
    return image.isEmpty() ? fallback : image;
  } catch {
    return fallback;
  }
}

/**
 * Wires `ntwine:drag-start` (renderer `startDrag(sampleId, icon)`, preload.ts) to
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
 * `icon` (2026-08-31) is the renderer's drag card. It is resolved only AFTER the path resolves,
 * so a refused drag never spends time base64-decoding a card nothing will use.
 *
 * `e2eEmit` (Task 1, e2e spec §3.1): when armed, observes the exact startDrag decision instead of
 * calling `webContents.startDrag` and returns immediately — an OS drag session blocks the main
 * process until mouse-up, which no headless run can deliver, so under e2e the invoke's
 * resolution carries no drag-end meaning (spec §7's E2E note). The payload's `icon` field is the
 * only way a headless spec can observe WHICH icon a drag would have carried: no native drag runs,
 * so the image itself never reaches an OS the test could inspect.
 */
export function registerDragHandler(
  resolvePath: (sampleId: number) => string | null,
  e2eEmit: E2EEmit | null = null,
): void {
  const fallbackIcon = makeDragIcon();
  ipcMain.handle('ntwine:drag-start', async (event, sampleId: number, icon?: DragIcon | null) => {
    const resolved = resolvePath(Number(sampleId));
    // resolvePath only checks the DB row (missing flag) and path containment — not the
    // filesystem itself, so a file deleted since the last statPass (importer.ts) can still
    // resolve here. decodePreviewPcm re-stats before touching the file (ipc.ts); startDrag has no
    // re-stat of its own, so this existsSync is it. A vanished file is a silent no-op, same as
    // any other resolvePath null (spec §8: "Drag of missing file -> Drag refused").
    const file = resolved && existsSync(resolved) ? resolved : null;
    if (e2eEmit) {
      const dragIcon = file ? resolveDragIcon(icon, fallbackIcon) : fallbackIcon;
      e2eEmit('ntwine:e2e:drag', {
        sampleId: Number(sampleId),
        file,
        icon: file && dragIcon !== fallbackIcon ? 'card' : 'fallback',
        // The size the OS will lay the drag image out at. Emitted separately from `icon` because
        // "the card arrived" and "the card will be drawn at the size it was painted" are different
        // claims, and only the second one catches a scale-factor mismatch clipping the edges.
        iconSize: dragIcon.getSize(),
      });
      return;
    }
    // Blocks until the OS drag session ends; the handler's resolution IS drag-end.
    if (file) event.sender.startDrag({ file, icon: resolveDragIcon(icon, fallbackIcon) });
  });
}
