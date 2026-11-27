import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { registerSampleFileHandlers, type SampleFileDeps } from './sampleFile';

// Same reasoning as ipc.test.ts's own mock: under `ELECTRON_RUN_AS_NODE=1`, `require('electron')`
// is the binary's path, not the API, so `ipcMain.handle` needs a stand-in to register against.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

const PRESENT = '/lib/root/Pack/a.wav';
const GONE = '/lib/root/Pack/gone.wav';

/** Resolver fake: id 1 is a present row, id 2 a missing-flagged one, anything else unknown. */
function resolve(sampleId: number) {
  if (sampleId === 1) return { absPath: PRESENT, missing: false };
  if (sampleId === 2) return { absPath: GONE, missing: true };
  return null;
}

function setUp(overrides: Partial<SampleFileDeps> = {}) {
  const deps = {
    resolve: vi.fn(resolve),
    showItemInFolder: vi.fn(),
    writeClipboardText: vi.fn(),
    exists: vi.fn((p: string) => p === PRESENT),
    e2eEmit: null,
    ...overrides,
  };
  registerSampleFileHandlers(deps);
  return deps;
}

/** Invokes whatever `registerSampleFileHandlers` registered for `channel`. */
function invoke(channel: string, ...args: unknown[]): Promise<void> {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`no handler registered for ${channel}`);
  const handler = call[1] as (event: unknown, ...rest: unknown[]) => Promise<void>;
  return handler({}, ...args);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ntwine:revealSample', () => {
  it('reveals a present sample in the file manager', async () => {
    const deps = setUp();
    await invoke('ntwine:revealSample', 1);
    expect(deps.showItemInFolder).toHaveBeenCalledWith(PRESENT);
  });

  it('coerces the id the renderer sent before resolving it', async () => {
    const deps = setUp();
    await invoke('ntwine:revealSample', '1');
    expect(deps.resolve).toHaveBeenCalledWith(1);
    expect(deps.showItemInFolder).toHaveBeenCalledWith(PRESENT);
  });

  it('is a silent no-op for an unknown id, a missing-flagged row, or a file gone from disk', async () => {
    const deps = setUp({ exists: vi.fn(() => false) });
    await expect(invoke('ntwine:revealSample', 999)).resolves.toBeUndefined();
    await expect(invoke('ntwine:revealSample', 2)).resolves.toBeUndefined();
    await expect(invoke('ntwine:revealSample', 1)).resolves.toBeUndefined();
    expect(deps.showItemInFolder).not.toHaveBeenCalled();
  });

  it('reports the reveal decision to the e2e seam instead of opening a file-manager window', async () => {
    const emit = vi.fn();
    const deps = setUp({ e2eEmit: emit });
    await invoke('ntwine:revealSample', 1);
    await invoke('ntwine:revealSample', 2);
    await invoke('ntwine:revealSample', 999);
    expect(emit.mock.calls).toEqual([
      ['ntwine:e2e:reveal', { sampleId: 1, file: PRESENT }],
      ['ntwine:e2e:reveal', { sampleId: 2, file: null }],
      ['ntwine:e2e:reveal', { sampleId: 999, file: null }],
    ]);
    expect(deps.showItemInFolder).not.toHaveBeenCalled();
  });
});

describe('ntwine:copySamplePath', () => {
  it('copies a present sample path', async () => {
    const deps = setUp();
    await invoke('ntwine:copySamplePath', 1);
    expect(deps.writeClipboardText).toHaveBeenCalledWith(PRESENT);
  });

  it('copies a missing row path too: where the file should be', async () => {
    const deps = setUp();
    await invoke('ntwine:copySamplePath', '2');
    expect(deps.resolve).toHaveBeenCalledWith(2);
    expect(deps.writeClipboardText).toHaveBeenCalledWith(GONE);
  });

  it('is a silent no-op for an id that does not resolve', async () => {
    const deps = setUp();
    await expect(invoke('ntwine:copySamplePath', 999)).resolves.toBeUndefined();
    expect(deps.writeClipboardText).not.toHaveBeenCalled();
  });

  it('reports the copied path to the e2e seam instead of overwriting the clipboard', async () => {
    const emit = vi.fn();
    const deps = setUp({ e2eEmit: emit });
    await invoke('ntwine:copySamplePath', 2);
    await invoke('ntwine:copySamplePath', 999);
    expect(emit.mock.calls).toEqual([
      ['ntwine:e2e:copy-path', { sampleId: 2, path: GONE }],
      ['ntwine:e2e:copy-path', { sampleId: 999, path: null }],
    ]);
    expect(deps.writeClipboardText).not.toHaveBeenCalled();
  });
});
