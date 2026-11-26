// previewPlayer's decidable logic, pinned against a stub WebAudio context — no DOM in
// this test env (vitest.config.ts's `environment: 'node'`), so every WebAudio object the
// implementation touches is reached ONLY through the injected `ctx`. The
// stub below implements createBufferSource/createGain/createBuffer/decodeAudioData PLUS
// destination/currentTime/state/resume/close — the last three are what the
// suspended-context-resume and dispose()-closes-the-context behaviors need to be testable at all; a real
// AudioContext has all of them too, so this is a superset, not a divergence, of what production
// actually gets.
//
// The stub is cast `as unknown as BaseAudioContext` at the one call site that needs it — it is
// nowhere near the ~25-member real DOM `BaseAudioContext` interface (createAnalyser,
// createBiquadFilter, audioWorklet, listener, addEventListener, ...), and implementing all of
// that with no-ops would bury every test's intent under boilerplate nobody reads. Same idiom
// queue.test.ts's `FakeWorker` comment already establishes for this repo (WorkerLike stubs).
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  createPreviewPlayer,
  MAX_CACHED_BUFFERS,
  RETRIGGER_RAMP_SECONDS,
  type PreviewPlayerDeps,
} from './previewPlayer';

// Deliberately nonzero and off any "looks like a default" value (0, 1) — a stub fixed at 0 would
// let a implementation that forgets to add `ctx.currentTime` at all pass by coincidence (see
// MEMORY's "unity-magnitude test cannot fail" lesson: pin relationally, not against a value the
// code could produce by doing nothing).
const STUB_CURRENT_TIME = 2;

interface FakeAudioParam {
  value: number;
  setValueAtTime: Mock<(value: number, time: number) => void>;
  linearRampToValueAtTime: Mock<(value: number, time: number) => void>;
}

// Fresh nodes default to gain 0 — NOT Web Audio's real default of 1 — specifically so
// "the new voice starts at full gain" assertions are falsifiable: they only pass because
// previewPlayer.ts actively sets `.value = 1`, not because the stub already reads that way.
function makeFakeParam(initial = 0): FakeAudioParam {
  return { value: initial, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
}

interface FakeGainNode {
  gain: FakeAudioParam;
  connect: Mock<(dest: unknown) => void>;
}

interface FakeAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  channelsWritten: (Float32Array | undefined)[];
  copyToChannel: Mock<(data: Float32Array, channel: number) => void>;
}

function makeFakeAudioBuffer(
  numberOfChannels: number,
  length: number,
  sampleRate: number,
): FakeAudioBuffer {
  const channelsWritten: (Float32Array | undefined)[] = [];
  return {
    numberOfChannels,
    length,
    sampleRate,
    channelsWritten,
    copyToChannel: vi.fn((data: Float32Array, channel: number) => {
      channelsWritten[channel] = data;
    }),
  };
}

interface FakeSourceNode {
  buffer: FakeAudioBuffer | null;
  connect: Mock<(dest: unknown) => void>;
  start: Mock<(when?: number) => void>;
  stop: Mock<(when?: number) => void>;
}

function makeStubCtx(initialState: 'running' | 'suspended' = 'running') {
  const sources: FakeSourceNode[] = [];
  const gains: FakeGainNode[] = [];

  const createGain = vi.fn((): FakeGainNode => {
    const node: FakeGainNode = { gain: makeFakeParam(), connect: vi.fn() };
    gains.push(node);
    return node;
  });

  const createBufferSource = vi.fn((): FakeSourceNode => {
    const node: FakeSourceNode = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
    sources.push(node);
    return node;
  });

  const createBuffer = vi.fn(
    (numberOfChannels: number, length: number, sampleRate: number): FakeAudioBuffer =>
      makeFakeAudioBuffer(numberOfChannels, length, sampleRate),
  );

  const decodeAudioData = vi.fn<(data: ArrayBuffer) => Promise<FakeAudioBuffer>>();
  const resume = vi.fn(async () => {});
  const close = vi.fn(async () => {});

  const stub = {
    currentTime: STUB_CURRENT_TIME,
    destination: {},
    state: initialState as 'running' | 'suspended',
    createGain,
    createBufferSource,
    createBuffer,
    decodeAudioData,
    resume,
    close,
  };

  return {
    stub,
    sources,
    gains,
    createGain,
    createBufferSource,
    createBuffer,
    decodeAudioData,
    resume,
    close,
  };
}

function asCtx(stub: ReturnType<typeof makeStubCtx>['stub']): BaseAudioContext {
  return stub as unknown as BaseAudioContext;
}

type Fallback = { sampleRate: number; channels: Float32Array[] } | null;

function setUp(initialState: 'running' | 'suspended' = 'running') {
  const ctxBundle = makeStubCtx(initialState);
  const fetchBytes = vi.fn<(url: string) => Promise<ArrayBuffer>>();
  const decodeFallback = vi.fn<(sampleId: number) => Promise<Fallback>>();
  const sampleUrl = vi.fn((id: number) => `sample://s/${id}`);
  const deps: PreviewPlayerDeps = {
    fetchBytes,
    decodeFallback,
    sampleUrl,
    ctx: asCtx(ctxBundle.stub),
  };
  const player = createPreviewPlayer(deps);
  return {
    ctxBundle,
    fetchBytes,
    decodeFallback,
    sampleUrl,
    deps,
    player,
    resume: ctxBundle.resume,
    close: ctxBundle.close,
  };
}

// A single macrotask tick reliably drains the ENTIRE microtask queue built up by a chain of
// sequential `await`s (fetchBytes -> decodeAudioData/decodeFallback -> buffer creation), no
// matter how many hops the implementation has internally — Node/V8 drain microtasks completely
// between macrotasks, including ones newly enqueued by resolving earlier ones.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createPreviewPlayer', () => {
  describe('lazy context creation', () => {
    it('creates no WebAudio objects at construction — ctx/master are created lazily on first play()', () => {
      const { ctxBundle } = setUp();
      expect(ctxBundle.createGain).not.toHaveBeenCalled();
      expect(ctxBundle.createBufferSource).not.toHaveBeenCalled();
    });
  });

  describe('deps.sampleUrl wiring', () => {
    it('fetches via deps.sampleUrl(sampleId), not a hardcoded template', async () => {
      const { ctxBundle, fetchBytes, sampleUrl, player } = setUp();
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      ctxBundle.decodeAudioData.mockResolvedValue(makeFakeAudioBuffer(1, 10, 44100));

      player.play(42);
      await flush();

      expect(sampleUrl).toHaveBeenCalledWith(42);
      expect(fetchBytes).toHaveBeenCalledWith('sample://s/42');
    });
  });

  describe('retrigger — per-voice gain, master untouched', () => {
    it("ramps the PRIOR voice's gain to 0 over RETRIGGER_RAMP_SECONDS and stops its source, while the NEW voice starts at full gain immediately — never ramps the master", async () => {
      const { ctxBundle, fetchBytes, player } = setUp();
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      const bufferA = makeFakeAudioBuffer(1, 100, 44100);
      const bufferB = makeFakeAudioBuffer(1, 100, 44100);
      ctxBundle.decodeAudioData.mockResolvedValueOnce(bufferA).mockResolvedValueOnce(bufferB);

      player.play(1);
      await flush();
      expect(ctxBundle.gains).toHaveLength(2); // [master, voiceA]
      const master = ctxBundle.gains[0];
      const voiceAGain = ctxBundle.gains[1];
      const voiceASource = ctxBundle.sources[0];

      player.play(2);
      await flush();
      expect(ctxBundle.gains).toHaveLength(3); // [master, voiceA, voiceB]
      const voiceBGain = ctxBundle.gains[2];
      const voiceBSource = ctxBundle.sources[1];

      // The ramp lands on the OLD voice's node.
      expect(voiceAGain.gain.setValueAtTime).toHaveBeenCalledWith(1, STUB_CURRENT_TIME);
      expect(voiceAGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
        0,
        STUB_CURRENT_TIME + RETRIGGER_RAMP_SECONDS,
      );
      expect(voiceASource.stop).toHaveBeenCalledWith(STUB_CURRENT_TIME + RETRIGGER_RAMP_SECONDS);

      // Never the master.
      expect(master.gain.setValueAtTime).not.toHaveBeenCalled();
      expect(master.gain.linearRampToValueAtTime).not.toHaveBeenCalled();

      // The new voice starts at full gain immediately — no ramp on it, started at time 0.
      expect(voiceBGain.gain.value).toBe(1);
      expect(voiceBGain.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
      expect(voiceBSource.start).toHaveBeenCalledWith(0);
    });

    it('the very first play() has no prior voice to ramp — nothing but the new voice is touched', async () => {
      const { ctxBundle, fetchBytes, player } = setUp();
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      ctxBundle.decodeAudioData.mockResolvedValue(makeFakeAudioBuffer(1, 10, 44100));

      player.play(1);
      await flush();

      expect(ctxBundle.sources).toHaveLength(1);
      expect(ctxBundle.sources[0].stop).not.toHaveBeenCalled();
      const voiceGain = ctxBundle.gains[1];
      expect(voiceGain.gain.value).toBe(1);
    });
  });

  describe('decodeAudioData gets a COPY', () => {
    it('is called with a copy of the fetched ArrayBuffer — not the same object, and the original is left intact', async () => {
      const { ctxBundle, fetchBytes, player } = setUp();
      const original = new ArrayBuffer(16);
      new Uint8Array(original).set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      fetchBytes.mockResolvedValue(original);
      ctxBundle.decodeAudioData.mockResolvedValue(makeFakeAudioBuffer(1, 10, 44100));

      player.play(1);
      await flush();

      expect(ctxBundle.decodeAudioData).toHaveBeenCalledTimes(1);
      const passed = ctxBundle.decodeAudioData.mock.calls[0][0];
      expect(passed).not.toBe(original);
      expect(passed.byteLength).toBe(original.byteLength);
      expect(new Uint8Array(passed)).toEqual(new Uint8Array(original));
      // Untouched — still full length, still holding its original bytes.
      expect(original.byteLength).toBe(16);
      expect(Array.from(new Uint8Array(original))).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      ]);
    });
  });

  describe('AIFF / PCM fallback (single PCM-over-IPC exception path)', () => {
    it('when decodeAudioData rejects, decodeFallback is called ONCE and its Float32 channels land in a createBuffer()-made buffer', async () => {
      const { ctxBundle, fetchBytes, decodeFallback, player } = setUp();
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      ctxBundle.decodeAudioData.mockRejectedValue(new Error('Chromium cannot decode AIFF'));
      const left = new Float32Array([0.1, 0.2, 0.3]);
      const right = new Float32Array([-0.1, -0.2, -0.3]);
      decodeFallback.mockResolvedValue({ sampleRate: 44100, channels: [left, right] });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      player.play(7);
      await flush();

      expect(decodeFallback).toHaveBeenCalledTimes(1);
      expect(decodeFallback).toHaveBeenCalledWith(7);
      // Console-visible evidence the fallback fired, for manual testing — a permanent, non-error
      // diagnostic, not a reverted QA probe.
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toMatch(/sample 7.*PCM fallback/);
      infoSpy.mockRestore();
      expect(ctxBundle.createBuffer).toHaveBeenCalledWith(2, 3, 44100);
      const created = ctxBundle.createBuffer.mock.results[0].value;
      // Value equality, not reference — previewPlayer.ts reconstructs each channel via `new
      // Float32Array(channelData)` to satisfy DOM's `copyToChannel(source: Float32Array<ArrayBuffer>, ...)`
      // (ipcTypes.ts's `channels: Float32Array[]` widens to `Float32Array<ArrayBufferLike>`), so the
      // array actually landed is a copy — the copy's CONTENT is what "its Float32 channels land in a
      // created buffer" is actually asserting.
      expect(created.channelsWritten[0]).toEqual(left);
      expect(created.channelsWritten[1]).toEqual(right);
      expect(ctxBundle.sources[0].buffer).toBe(created);
    });

    it('a null fallback (refused by size/length caps) gives up quietly — no throw, no voice, logs', async () => {
      const { ctxBundle, fetchBytes, decodeFallback, player } = setUp();
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      ctxBundle.decodeAudioData.mockRejectedValue(new Error('bad format'));
      decodeFallback.mockResolvedValue(null);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => player.play(9)).not.toThrow();
      await flush();

      expect(decodeFallback).toHaveBeenCalledTimes(1);
      expect(ctxBundle.sources).toHaveLength(0);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('a fallback-decoded buffer is cached too — replaying it does not re-fetch or re-fallback', async () => {
      const { ctxBundle, fetchBytes, decodeFallback, player } = setUp();
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      ctxBundle.decodeAudioData.mockRejectedValue(new Error('cannot decode aiff'));
      decodeFallback.mockResolvedValue({
        sampleRate: 44100,
        channels: [new Float32Array([1, 2, 3])],
      });
      vi.spyOn(console, 'info').mockImplementation(() => {});

      player.play(11);
      await flush();
      player.play(11);
      await flush();

      expect(fetchBytes).toHaveBeenCalledTimes(1);
      expect(decodeFallback).toHaveBeenCalledTimes(1);
      expect(ctxBundle.sources).toHaveLength(2); // two independent voices/retriggers
      vi.restoreAllMocks();
    });

    it('a fully-failed decode (both paths refuse) is not cached — a later replay retries from scratch', async () => {
      const { ctxBundle, fetchBytes, decodeFallback, player } = setUp();
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      ctxBundle.decodeAudioData.mockRejectedValue(new Error('bad'));
      decodeFallback
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ sampleRate: 44100, channels: [new Float32Array([1])] });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});

      player.play(1);
      await flush();
      expect(ctxBundle.sources).toHaveLength(0);

      player.play(1);
      await flush();

      expect(fetchBytes).toHaveBeenCalledTimes(2);
      expect(decodeFallback).toHaveBeenCalledTimes(2);
      expect(ctxBundle.sources).toHaveLength(1);
      vi.restoreAllMocks();
    });
  });

  describe('setVolume — master gain only', () => {
    it('sets the master gain and no other node', async () => {
      const { ctxBundle, fetchBytes, player } = setUp();
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      ctxBundle.decodeAudioData.mockResolvedValue(makeFakeAudioBuffer(1, 10, 44100));
      player.play(1);
      await flush();

      player.setVolume(0.3);

      const master = ctxBundle.gains[0];
      expect(master.gain.value).toBe(0.3);
      for (const gain of ctxBundle.gains.slice(1)) {
        expect(gain.gain.value).not.toBe(0.3);
      }
    });

    it('a call before any play() is remembered and applied once the context is lazily created', async () => {
      const { ctxBundle, fetchBytes, player } = setUp();
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      ctxBundle.decodeAudioData.mockResolvedValue(makeFakeAudioBuffer(1, 10, 44100));

      expect(() => player.setVolume(0.5)).not.toThrow();
      expect(ctxBundle.createGain).not.toHaveBeenCalled();

      player.play(1);
      await flush();

      expect(ctxBundle.gains[0].gain.value).toBe(0.5);
    });
  });

  describe('buffer cache (N = MAX_CACHED_BUFFERS, simple Map + oldest-eviction)', () => {
    it('replaying a cached sample id does not re-fetch or re-decode', async () => {
      const { ctxBundle, fetchBytes, player } = setUp();
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      ctxBundle.decodeAudioData.mockResolvedValue(makeFakeAudioBuffer(1, 10, 44100));

      player.play(5);
      await flush();
      player.play(5);
      await flush();

      expect(fetchBytes).toHaveBeenCalledTimes(1);
      expect(ctxBundle.decodeAudioData).toHaveBeenCalledTimes(1);
      expect(ctxBundle.sources).toHaveLength(2);
    });

    it(`caches at most ${MAX_CACHED_BUFFERS} buffers, evicting the oldest first`, async () => {
      const { ctxBundle, fetchBytes, player } = setUp();
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      ctxBundle.decodeAudioData.mockImplementation(async () => makeFakeAudioBuffer(1, 10, 44100));

      for (let id = 1; id <= MAX_CACHED_BUFFERS + 1; id++) {
        player.play(id);
        await flush();
      }
      expect(fetchBytes).toHaveBeenCalledTimes(MAX_CACHED_BUFFERS + 1);

      // id 1 was the oldest inserted — evicted — replaying it must re-fetch.
      player.play(1);
      await flush();
      expect(fetchBytes).toHaveBeenCalledTimes(MAX_CACHED_BUFFERS + 2);

      // The newest id is still cached — no re-fetch.
      player.play(MAX_CACHED_BUFFERS + 1);
      await flush();
      expect(fetchBytes).toHaveBeenCalledTimes(MAX_CACHED_BUFFERS + 2);
    });
  });

  describe('in-flight decode dedupe', () => {
    it('a second play() of the SAME id while its decode is still in flight does not double-fetch', async () => {
      const { ctxBundle, fetchBytes, player } = setUp();
      const gate = deferred<ArrayBuffer>();
      fetchBytes.mockReturnValue(gate.promise);
      ctxBundle.decodeAudioData.mockResolvedValue(makeFakeAudioBuffer(1, 10, 44100));

      player.play(3);
      await Promise.resolve(); // let the first call register its in-flight decode
      player.play(3);

      gate.resolve(new ArrayBuffer(8));
      await flush();

      expect(fetchBytes).toHaveBeenCalledTimes(1);
      // Only the latest request's generation may start a voice — one retrigger, not two.
      expect(ctxBundle.sources).toHaveLength(1);
    });
  });

  describe('rapid-fire correctness (generation counter — the arrow-key-walk case)', () => {
    it('a SLOW decode for an earlier request resolving AFTER a FAST decode for a later request must not start a voice — only the latest requested id ever sounds', async () => {
      const { ctxBundle, fetchBytes, player } = setUp();
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      const decodeA = deferred<FakeAudioBuffer>();
      const decodeB = deferred<FakeAudioBuffer>();
      ctxBundle.decodeAudioData
        .mockReturnValueOnce(decodeA.promise)
        .mockReturnValueOnce(decodeB.promise);

      player.play(10); // A — slow
      await Promise.resolve();
      player.play(20); // B — fast, now the latest request

      const bufferB = makeFakeAudioBuffer(1, 10, 44100);
      decodeB.resolve(bufferB);
      await flush();

      expect(ctxBundle.sources).toHaveLength(1);
      expect(ctxBundle.sources[0].buffer).toBe(bufferB);

      const bufferA = makeFakeAudioBuffer(1, 10, 44100);
      decodeA.resolve(bufferA); // resolves LATE — must be dropped
      await flush();

      expect(ctxBundle.sources).toHaveLength(1); // still just B's voice
    });
  });

  describe('stop() — genuine silence', () => {
    it('ramps the current voice to 0 and stops its source, same as a retrigger', async () => {
      const { ctxBundle, fetchBytes, player } = setUp();
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      ctxBundle.decodeAudioData.mockResolvedValue(makeFakeAudioBuffer(1, 10, 44100));
      player.play(1);
      await flush();

      player.stop();

      const voiceGain = ctxBundle.gains[1];
      expect(voiceGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
        0,
        STUB_CURRENT_TIME + RETRIGGER_RAMP_SECONDS,
      );
      expect(ctxBundle.sources[0].stop).toHaveBeenCalledWith(
        STUB_CURRENT_TIME + RETRIGGER_RAMP_SECONDS,
      );
    });

    it('before any play() (no context yet) is a harmless no-op', () => {
      const { player } = setUp();
      expect(() => player.stop()).not.toThrow();
    });

    it('invalidates a decode still in flight — it must not surface audio after an explicit stop', async () => {
      const { ctxBundle, fetchBytes, player } = setUp();
      const gate = deferred<ArrayBuffer>();
      fetchBytes.mockReturnValue(gate.promise);
      ctxBundle.decodeAudioData.mockResolvedValue(makeFakeAudioBuffer(1, 10, 44100));

      player.play(1);
      await Promise.resolve();
      player.stop();

      gate.resolve(new ArrayBuffer(8));
      await flush();

      expect(ctxBundle.sources).toHaveLength(0);
    });
  });

  describe('suspended-context resume', () => {
    it('resumes a suspended context on play()', async () => {
      const { ctxBundle, fetchBytes, resume, player } = setUp('suspended');
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      ctxBundle.decodeAudioData.mockResolvedValue(makeFakeAudioBuffer(1, 10, 44100));

      player.play(1);
      await flush();

      expect(resume).toHaveBeenCalledTimes(1);
    });

    it('does not call resume() when the context is already running', async () => {
      const { ctxBundle, fetchBytes, resume, player } = setUp('running');
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      ctxBundle.decodeAudioData.mockResolvedValue(makeFakeAudioBuffer(1, 10, 44100));

      player.play(1);
      await flush();

      expect(resume).not.toHaveBeenCalled();
    });
  });

  describe('dispose()', () => {
    it('closes the context', async () => {
      const { ctxBundle, fetchBytes, close, player } = setUp();
      fetchBytes.mockResolvedValue(new ArrayBuffer(8));
      ctxBundle.decodeAudioData.mockResolvedValue(makeFakeAudioBuffer(1, 10, 44100));
      player.play(1);
      await flush();

      player.dispose();

      expect(close).toHaveBeenCalledTimes(1);
    });

    it('before any play() (no context yet) is a harmless no-op', () => {
      const { player } = setUp();
      expect(() => player.dispose()).not.toThrow();
    });
  });
});
