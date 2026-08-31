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
function goodImage(scaleFactor?: number) {
  return { tag: 'decoded', scaleFactor, isEmpty: () => false, getSize: () => ({ width: 192, height: 96 }) };
}

const PNG_DATA_URL = 'data:image/png;base64,aGVsbG8=';

/** The wire shape, at an arbitrary valid scale factor, for the cases that don't care about it. */
const icon2x = (dataUrl: string) => ({ dataUrl, scaleFactor: 2 });

beforeEach(() => {
  vi.clearAllMocks();
  decoded.mockImplementation((_buf: Buffer, opts: { scaleFactor?: number }) => goodImage(opts?.scaleFactor));
});

describe('resolveDragIcon', () => {
  it('falls back to the generated square when the renderer sent no card at all', () => {
    const fallback = makeDragIcon();

    expect(resolveDragIcon(null, fallback)).toBe(fallback);
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled();
  });

  it('decodes the card straight from its bytes', () => {
    const icon = resolveDragIcon(icon2x(PNG_DATA_URL), makeDragIcon());

    expect(icon).toMatchObject({ tag: 'decoded' });
    const [buffer] = vi.mocked(nativeImage.createFromBuffer).mock.calls[0];
    expect(buffer.toString('utf8')).toBe('hello');
  });

  // What the OS draws is `bitmap_pixels x display_scale / tagged_scale`. The renderer sends its own
  // devicePixelRatio precisely so those cancel and the card lands at its bitmap size — which is the
  // premise the card's 192px width is chosen under, given Windows clips a drag image near 210px
  // (dragImage.ts's DRAG_CARD). Dropping the factor on the floor here would silently draw the card
  // at 1.5x on this machine and put it straight back over the clip.
  it('forwards the renderer scale factor to the decoder rather than dropping it', () => {
    resolveDragIcon({ dataUrl: PNG_DATA_URL, scaleFactor: 1.5 }, makeDragIcon());

    expect(nativeImage.createFromBuffer).toHaveBeenCalledWith(expect.any(Buffer), { scaleFactor: 1.5 });
  });

  it('falls back rather than decoding anything that is not a base64 png data url', () => {
    const fallback = makeDragIcon();

    expect(resolveDragIcon(icon2x('data:text/html;base64,aGk='), fallback)).toBe(fallback);
    expect(resolveDragIcon(icon2x('https://example.com/x.png'), fallback)).toBe(fallback);
    expect(resolveDragIcon(icon2x(''), fallback)).toBe(fallback);
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled();
  });

  it('falls back when the payload is larger than the drag icon size cap', () => {
    const fallback = makeDragIcon();
    const huge = `data:image/png;base64,${'A'.repeat(DRAG_ICON_MAX_BYTES + 1)}`;

    expect(resolveDragIcon(icon2x(huge), fallback)).toBe(fallback);
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled();
  });

  it('falls back when the bytes decode to an empty image', () => {
    const fallback = makeDragIcon();
    decoded.mockReturnValue({ tag: 'decoded', isEmpty: () => true });

    expect(resolveDragIcon(icon2x(PNG_DATA_URL), fallback)).toBe(fallback);
  });

  it('falls back when the decoder throws instead of letting the drag fail', () => {
    const fallback = makeDragIcon();
    decoded.mockImplementation(() => {
      throw new Error('corrupt png');
    });

    expect(resolveDragIcon(icon2x(PNG_DATA_URL), fallback)).toBe(fallback);
  });

  it('rejects a non-positive or absurd scale factor rather than resizing the drag image by it', () => {
    const fallback = makeDragIcon();

    expect(resolveDragIcon({ dataUrl: PNG_DATA_URL, scaleFactor: 0 }, fallback)).toBe(fallback);
    expect(resolveDragIcon({ dataUrl: PNG_DATA_URL, scaleFactor: -2 }, fallback)).toBe(fallback);
    expect(resolveDragIcon({ dataUrl: PNG_DATA_URL, scaleFactor: 99 }, fallback)).toBe(fallback);
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

    const { startDrag, done } = invokeHandler([1, icon2x(PNG_DATA_URL)]);
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

    await invokeHandler([1, icon2x(PNG_DATA_URL)]).done;
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

    await invokeHandler([1, icon2x(PNG_DATA_URL)]).done;

    expect(emit.mock.calls[0][1]).toMatchObject({ iconSize: { width: 192, height: 96 } });
  });

  it('refuses a sample it cannot resolve without ever decoding the card', async () => {
    registerDragHandler(() => null);

    const { startDrag, done } = invokeHandler([1, icon2x(PNG_DATA_URL)]);
    await done;

    expect(startDrag).not.toHaveBeenCalled();
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled();
  });
});
