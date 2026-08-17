import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from './catalog/db';
import {
  currentLibraryRoot,
  decodePreviewPcm,
  PREVIEW_MAX_BYTES,
  PREVIEW_MAX_SECONDS,
  runWaveformsInBackground,
  type DecodePreviewPcmDeps,
  type RunWaveformsInBackgroundDeps,
} from './ipc';
import type { WorkerLike } from './waveforms/queue';

const tmp = () => mkdtempSync(join(tmpdir(), 'ntwine-ipc-'));

// A one-shot WorkerLike fake: `on('message', cb)` registers the callback, then `postMessage`
// replies asynchronously (a microtask, not synchronously — matching queue.test.ts's own fake
// worker precedent) with whatever canned `reply` this fake was built with.
function makeFakeWorker(reply: unknown): {
  worker: WorkerLike;
  kill: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
} {
  let onMessage: ((m: unknown) => void) | null = null;
  const kill = vi.fn();
  const postMessage = vi.fn(() => {
    queueMicrotask(() => onMessage?.(reply));
  });
  const worker: WorkerLike = {
    postMessage,
    on: (_ev: 'message', cb: (m: unknown) => void) => {
      onMessage = cb;
    },
    kill,
  };
  return { worker, kill, postMessage };
}

describe('decodePreviewPcm', () => {
  it('refuses a file over PREVIEW_MAX_BYTES via statSync BEFORE forking a decode worker', async () => {
    const forkWorker = vi.fn<() => WorkerLike>();
    const deps: DecodePreviewPcmDeps = {
      resolvePath: () => '/fake/huge-file.wav',
      forkWorker,
      statFn: () => ({ size: PREVIEW_MAX_BYTES + 1 }),
    };

    const result = await decodePreviewPcm(deps, 42);

    expect(result).toBeNull();
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('returns null without forking when the resolver finds no safe file for the sample id', async () => {
    // Mirrors resolveSampleAbsPath's own null cases (no row / missing=1 / outside root) without
    // needing a real catalog here — decodePreviewPcm treats "resolver said no" as one outcome
    // regardless of which of those three reasons produced it.
    const forkWorker = vi.fn<() => WorkerLike>();
    const deps: DecodePreviewPcmDeps = {
      resolvePath: () => null,
      forkWorker,
      statFn: () => ({ size: 0 }),
    };

    const result = await decodePreviewPcm(deps, 42);

    expect(result).toBeNull();
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('decodes through the one-shot worker, reassembles Float32Array channels, and kills the worker after the reply', async () => {
    const channelA = new Float32Array([0.1, 0.2, 0.3]);
    const channelB = new Float32Array([-0.1, -0.2, -0.3]);
    const { worker, kill, postMessage } = makeFakeWorker({
      sampleId: 42,
      ok: true,
      sampleRate: 44100,
      channels: [channelA.buffer, channelB.buffer],
    });
    const forkWorker = vi.fn(() => worker);
    const deps: DecodePreviewPcmDeps = {
      resolvePath: () => '/fake/small-file.wav',
      forkWorker,
      statFn: () => ({ size: 1024 }),
    };

    const result = await decodePreviewPcm(deps, 42);

    expect(forkWorker).toHaveBeenCalledTimes(1);
    // The `kind: 'pcm'` discriminant is what tells peaksWorker.ts to take the PCM branch
    // instead of its default peaks-computation path.
    expect(postMessage).toHaveBeenCalledWith({
      sampleId: 42,
      absPath: '/fake/small-file.wav',
      kind: 'pcm',
    });
    expect(result).not.toBeNull();
    expect(result?.sampleRate).toBe(44100);
    expect(result?.channels).toHaveLength(2);
    // Compared against values round-tripped through Float32Array too (not the raw float64
    // literals) — 0.1 etc. aren't exactly representable in either width, and the two widths
    // round differently, so this is what an exact (not fuzzy) equality check requires.
    expect(result?.channels[0]).toEqual(channelA);
    expect(result?.channels[1]).toEqual(channelB);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('refuses decoded audio over PREVIEW_MAX_SECONDS (checked AFTER decode, using the real sampleRate)', async () => {
    // sampleRate=1 makes "seconds" and "sample count" the same number — PREVIEW_MAX_SECONDS + 1
    // samples crosses the threshold without allocating a real-audio-sized buffer in a test.
    const tooLong = new Float32Array(PREVIEW_MAX_SECONDS + 1);
    const { worker, kill } = makeFakeWorker({
      sampleId: 42,
      ok: true,
      sampleRate: 1,
      channels: [tooLong.buffer],
    });
    const forkWorker = vi.fn(() => worker);
    const deps: DecodePreviewPcmDeps = {
      resolvePath: () => '/fake/long-file.wav',
      forkWorker,
      statFn: () => ({ size: 1024 }),
    };

    const result = await decodePreviewPcm(deps, 42);

    expect(result).toBeNull();
    // The worker still ran — this cap can only be checked after decode, unlike the byte cap —
    // and is still cleaned up even though the result is refused.
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('returns null (and still kills the worker) when the worker reports a decode failure', async () => {
    const { worker, kill } = makeFakeWorker({ sampleId: 42, ok: false, error: 'boom' });
    const forkWorker = vi.fn(() => worker);
    const deps: DecodePreviewPcmDeps = {
      resolvePath: () => '/fake/corrupt-file.wav',
      forkWorker,
      statFn: () => ({ size: 1024 }),
    };

    const result = await decodePreviewPcm(deps, 42);

    expect(result).toBeNull();
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

describe('runWaveformsInBackground', () => {
  it('a synchronously-throwing forkWorker never escapes as an unhandled rejection (or a synchronous throw) — logs and leaves the pass a no-op', async () => {
    // Reproduces queue.ts's own documented rejection path (runPeaksQueue's promise "only
    // rejects if forkWorker itself throws synchronously while priming the pool") — a real,
    // acknowledged path (a broken install missing peaksWorker.js beside main.js, or resource
    // exhaustion), not a hypothetical one. Both real call sites (the runImport handler, the
    // startup-resume block in registerIpc) invoke this fire-and-forget with no try/catch of
    // their own — the startup-resume one runs unconditionally on every cold launch once
    // imported=1 — so a rejection here must degrade to "placeholders stay pending", never reach
    // process-level as an unhandled rejection.
    const catalog = openCatalog(join(tmp(), 'catalog.db'));
    const sendProgress = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const deps: RunWaveformsInBackgroundDeps = {
      catalog,
      libraryRoot: tmp(),
      sendProgress,
      forkWorker: () => {
        throw new Error('simulated: peaksWorker.js missing beside main.js');
      },
    };

    // The call itself — synchronous, fire-and-forget — must never throw.
    expect(() => runWaveformsInBackground(deps, [1])).not.toThrow();

    // forkWorker throws inside runPeaksQueue's own `new Promise(...)` executor, so the
    // constructor converts it into a rejection rather than a synchronous throw escaping
    // runPeaksQueue itself — flush pending microtasks so the .catch() handler has actually run
    // before asserting on it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleErrorSpy).toHaveBeenCalled();
    // No 'done' event: the queue rejected, it never resolved — a no-op resume, not a false
    // "finished" signal to the renderer.
    expect(sendProgress).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'done' }));

    consoleErrorSpy.mockRestore();
  });

  it('the happy path still forwards waveforms progress and announces done (the error handling wrap does not change normal behavior)', async () => {
    const catalog = openCatalog(join(tmp(), 'catalog.db'));
    const sendProgress = vi.fn();

    let onMessage: ((m: unknown) => void) | null = null;
    const kill = vi.fn();
    const worker: WorkerLike = {
      postMessage: (m: unknown) => {
        const { sampleId } = m as { sampleId: number };
        queueMicrotask(() => onMessage?.({ sampleId, ok: true, peaks: new ArrayBuffer(400) }));
      },
      on: (_ev: 'message', cb: (m: unknown) => void) => {
        onMessage = cb;
      },
      kill,
    };

    const deps: RunWaveformsInBackgroundDeps = {
      catalog,
      libraryRoot: tmp(),
      sendProgress,
      forkWorker: () => worker,
    };

    // sampleId 1 has no real `samples` row (empty catalog) — writePeaks would throw on the FK
    // constraint, which queue.ts's own settle() already catches and treats like a decode
    // failure (queue.test.ts pins this precedent directly); either way the queue still drains
    // and calls onProgress/resolves, which is all this test needs.
    runWaveformsInBackground(deps, [1]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendProgress).toHaveBeenCalledWith({ phase: 'waveforms', done: 1, total: 1 });
    expect(sendProgress).toHaveBeenCalledWith({ phase: 'done', done: 1, total: 1 });
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

describe('currentLibraryRoot', () => {
  // Precedence pin (Task 1, e2e spec §3.1): a persisted `library_root` must keep winning over an
  // E2E `defaultLibraryRoot` override — the SAME precedence production already had over the spec
  // default, now generalized to a second argument rather than a hardcoded constant. Getting this
  // backwards would mean an E2E run's NTWINE_LIBRARY_ROOT silently overrides a library the user
  // already picked via pickLibraryRoot in that same E2E userData dir.
  it('falls back to the spec default (~/Splice) when nothing is persisted and no override is given', () => {
    const catalog = openCatalog(join(tmp(), 'catalog.db'));
    expect(currentLibraryRoot(catalog)).toBe(join(homedir(), 'Splice'));
  });

  it('uses the supplied default when nothing is persisted', () => {
    const catalog = openCatalog(join(tmp(), 'catalog.db'));
    expect(currentLibraryRoot(catalog, '/x')).toBe('/x');
  });

  it('a persisted library_root wins over BOTH the spec default and a supplied default', () => {
    const catalog = openCatalog(join(tmp(), 'catalog.db'));
    catalog.setMeta('library_root', '/persisted');
    expect(currentLibraryRoot(catalog)).toBe('/persisted');
    expect(currentLibraryRoot(catalog, '/x')).toBe('/persisted');
  });
});
