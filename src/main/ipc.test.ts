import { describe, expect, it, vi } from 'vitest';
import {
  decodePreviewPcm,
  PREVIEW_MAX_BYTES,
  PREVIEW_MAX_SECONDS,
  type DecodePreviewPcmDeps,
} from './ipc';
import type { WorkerLike } from './waveforms/queue';

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
