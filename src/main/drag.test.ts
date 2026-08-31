import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain, nativeImage } from 'electron';
import { DRAG_ICON_MAX_BYTES, makeDragIcon, registerDragHandler, resolveDragIcon } from './drag';

// Same reasoning as ipc.test.ts's own mock: under `ELECTRON_RUN_AS_NODE=1`, `require('electron')`
// resolves to the Electron binary's PATH (a string), so `nativeImage.createFromBuffer` on the real
// module is `undefined`. The fakes below mirror the two real behaviours this module actually
// branches on — a decoder that can THROW on malformed bytes, and a NativeImage that can report
// itself EMPTY — so the decisions under test are real decisions, not mock choreography.
const decoded = vi.fn();
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  nativeImage: {
    createFromBitmap: vi.fn(() => ({
      tag: 'generated-square',
      isEmpty: () => false,
      getSize: () => ({ width: 24, height: 24 }),
    })),
    createFromBuffer: vi.fn((...args: unknown[]) => decoded(...args)),
  },
}));

/** A NativeImage-alike that reports itself non-empty, i.e. a successful decode. */
function goodImage() {
  return { tag: 'decoded', isEmpty: () => false, getSize: () => ({ width: 336, height: 90 }) };
}

const PNG_DATA_URL = 'data:image/png;base64,aGVsbG8=';

beforeEach(() => {
  vi.clearAllMocks();
  decoded.mockImplementation(() => goodImage());
});

describe('resolveDragIcon', () => {
  it('falls back to the generated square when the renderer sent no card at all', () => {
    const fallback = makeDragIcon();

    expect(resolveDragIcon(null, fallback)).toBe(fallback);
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled();
  });

  it('decodes the card straight from its bytes', () => {
    const icon = resolveDragIcon(PNG_DATA_URL, makeDragIcon());

    expect(icon).toMatchObject({ tag: 'decoded' });
    const [buffer] = vi.mocked(nativeImage.createFromBuffer).mock.calls[0];
    expect(buffer.toString('utf8')).toBe('hello');
  });

  // The bug this pins was visible only in a real OS drag (Windows, 2026-08-31): a card drawn at
  // devicePixelRatio 1.5 and tagged `scaleFactor: 1.5` is 336x90 real pixels that REPORTS itself
  // as 224x60. Windows sizes the drag window from the reported size and blits the raw pixels into
  // it, so a third of the card — its padding, its rounded corners and the whole meta line — landed
  // outside the window. Tagging no scale factor at all keeps pixel size and logical size equal,
  // which is the only relationship an OS drag image can't get wrong.
  it('tags the image with no scale factor, so its pixel size IS its logical size', () => {
    resolveDragIcon(PNG_DATA_URL, makeDragIcon());

    expect(nativeImage.createFromBuffer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(nativeImage.createFromBuffer).mock.calls[0]).toHaveLength(1);
  });

  it('falls back rather than decoding anything that is not a base64 png data url', () => {
    const fallback = makeDragIcon();

    expect(resolveDragIcon('data:text/html;base64,aGk=', fallback)).toBe(fallback);
    expect(resolveDragIcon('https://example.com/x.png', fallback)).toBe(fallback);
    expect(resolveDragIcon('', fallback)).toBe(fallback);
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled();
  });

  it('falls back when the payload is larger than the drag icon size cap', () => {
    const fallback = makeDragIcon();
    const huge = `data:image/png;base64,${'A'.repeat(DRAG_ICON_MAX_BYTES + 1)}`;

    expect(resolveDragIcon(huge, fallback)).toBe(fallback);
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled();
  });

  it('falls back when the bytes decode to an empty image', () => {
    const fallback = makeDragIcon();
    decoded.mockReturnValue({ tag: 'decoded', isEmpty: () => true });

    expect(resolveDragIcon(PNG_DATA_URL, fallback)).toBe(fallback);
  });

  it('falls back when the decoder throws instead of letting the drag fail', () => {
    const fallback = makeDragIcon();
    decoded.mockImplementation(() => {
      throw new Error('corrupt png');
    });

    expect(resolveDragIcon(PNG_DATA_URL, fallback)).toBe(fallback);
  });
});

/** Invokes whatever `registerDragHandler` registered for `ntwine:drag-start`. */
function invokeHandler(args: unknown[], startDrag = vi.fn()) {
  const [, handler] = vi.mocked(ipcMain.handle).mock.calls[0] as [
    string,
    (event: unknown, ...rest: unknown[]) => Promise<void>,
  ];
  return { startDrag, done: handler({ sender: { startDrag } }, ...args) };
}

describe('registerDragHandler', () => {
  it('hands the OS drag the card the renderer drew, not the generated square', async () => {
    registerDragHandler(() => __filename);

    const { startDrag, done } = invokeHandler([1, PNG_DATA_URL]);
    await done;

    expect(startDrag).toHaveBeenCalledWith({
      file: __filename,
      icon: expect.objectContaining({ tag: 'decoded' }),
    });
  });

  it('still starts the drag with the generated square when the renderer sends no card', async () => {
    registerDragHandler(() => __filename);

    const { startDrag, done } = invokeHandler([1]);
    await done;

    expect(startDrag).toHaveBeenCalledWith({
      file: __filename,
      icon: expect.objectContaining({ tag: 'generated-square' }),
    });
  });

  it('reports which icon a drag would have used to the e2e seam, since no native drag runs there', async () => {
    const emit = vi.fn();
    registerDragHandler(() => __filename, emit);

    await invokeHandler([1, PNG_DATA_URL]).done;
    await invokeHandler([1]).done;

    expect(emit.mock.calls.map((c) => (c[1] as { icon: string }).icon)).toEqual(['card', 'fallback']);
  });

  // `icon` alone says the card survived the trip; it says nothing about the size it will be drawn
  // at, which is the dimension the Windows clipping bug lived in. Reporting the resolved image's
  // LOGICAL size lets drag.spec.ts compare it against the pixel size the renderer actually drew —
  // the one comparison that fails loudly if a scale factor ever creeps back in.
  it('reports the resolved icon logical size, the dimension the OS lays the drag image out at', async () => {
    const emit = vi.fn();
    registerDragHandler(() => __filename, emit);

    await invokeHandler([1, PNG_DATA_URL]).done;

    expect(emit.mock.calls[0][1]).toMatchObject({ iconSize: { width: 336, height: 90 } });
  });

  it('refuses a sample it cannot resolve without ever decoding the card', async () => {
    registerDragHandler(() => null);

    const { startDrag, done } = invokeHandler([1, PNG_DATA_URL]);
    await done;

    expect(startDrag).not.toHaveBeenCalled();
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled();
  });
});
