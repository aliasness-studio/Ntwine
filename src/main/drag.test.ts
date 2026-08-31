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
    createFromBitmap: vi.fn(() => ({ tag: 'generated-square', isEmpty: () => false })),
    createFromBuffer: vi.fn((...args: unknown[]) => decoded(...args)),
  },
}));

/** A NativeImage-alike that reports itself non-empty, i.e. a successful decode. */
function goodImage(scaleFactor?: number) {
  return { tag: 'decoded', scaleFactor, isEmpty: () => false };
}

const PNG_DATA_URL = 'data:image/png;base64,aGVsbG8=';

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

  it('decodes the card at the scale factor the renderer drew it with', () => {
    const icon = resolveDragIcon({ dataUrl: PNG_DATA_URL, scaleFactor: 2 }, makeDragIcon());

    expect(icon).toMatchObject({ tag: 'decoded', scaleFactor: 2 });
    const [buffer] = vi.mocked(nativeImage.createFromBuffer).mock.calls[0];
    expect(buffer.toString('utf8')).toBe('hello');
  });

  it('falls back rather than decoding anything that is not a base64 png data url', () => {
    const fallback = makeDragIcon();

    expect(resolveDragIcon({ dataUrl: 'data:text/html;base64,aGk=', scaleFactor: 2 }, fallback)).toBe(fallback);
    expect(resolveDragIcon({ dataUrl: 'https://example.com/x.png', scaleFactor: 2 }, fallback)).toBe(fallback);
    expect(resolveDragIcon({ dataUrl: '', scaleFactor: 2 }, fallback)).toBe(fallback);
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled();
  });

  it('falls back when the payload is larger than the drag icon size cap', () => {
    const fallback = makeDragIcon();
    const huge = `data:image/png;base64,${'A'.repeat(DRAG_ICON_MAX_BYTES + 1)}`;

    expect(resolveDragIcon({ dataUrl: huge, scaleFactor: 2 }, fallback)).toBe(fallback);
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled();
  });

  it('falls back when the bytes decode to an empty image', () => {
    const fallback = makeDragIcon();
    decoded.mockReturnValue({ tag: 'decoded', isEmpty: () => true });

    expect(resolveDragIcon({ dataUrl: PNG_DATA_URL, scaleFactor: 2 }, fallback)).toBe(fallback);
  });

  it('falls back when the decoder throws instead of letting the drag fail', () => {
    const fallback = makeDragIcon();
    decoded.mockImplementation(() => {
      throw new Error('corrupt png');
    });

    expect(resolveDragIcon({ dataUrl: PNG_DATA_URL, scaleFactor: 2 }, fallback)).toBe(fallback);
  });

  it('rejects a non-positive or absurd scale factor rather than passing it through', () => {
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

    const { startDrag, done } = invokeHandler([1, { dataUrl: PNG_DATA_URL, scaleFactor: 2 }]);
    await done;

    expect(startDrag).toHaveBeenCalledWith({
      file: __filename,
      icon: expect.objectContaining({ tag: 'decoded', scaleFactor: 2 }),
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

    await invokeHandler([1, { dataUrl: PNG_DATA_URL, scaleFactor: 2 }]).done;
    await invokeHandler([1]).done;

    expect(emit.mock.calls.map((c) => (c[1] as { icon: string }).icon)).toEqual(['card', 'fallback']);
  });

  it('refuses a sample it cannot resolve without ever decoding the card', async () => {
    registerDragHandler(() => null);

    const { startDrag, done } = invokeHandler([1, { dataUrl: PNG_DATA_URL, scaleFactor: 2 }]);
    await done;

    expect(startDrag).not.toHaveBeenCalled();
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled();
  });
});
