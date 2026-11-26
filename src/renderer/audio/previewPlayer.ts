// The real PlayPort. WebAudio, not `<audio>`: one persistent AudioContext -> shared master GainNode (volume)
// -> destination; per play, a throwaway per-voice GainNode + AudioBufferSourceNode. Retrigger and
// `stop()` both silence via a ~10ms linear ramp on the OLD voice's own gain node — never the
// master, which stays untouched so the NEW voice's onset is never muted by its own stop ramp.
//
// Every WebAudio object is reached ONLY through the injected `ctx` (constructor-injected
// dependency, same pattern LibraryStore/PlayerStore use for `api`/`playPort`) — this module never
// references a bare global `AudioContext` except as the lazy production default.
import type { PlayPort } from '../stores/PlayerStore';

export interface PreviewPlayerDeps {
  fetchBytes(url: string): Promise<ArrayBuffer>;
  // The single sanctioned PCM-over-IPC exception (AIFF fallback — Chromium can't decode AIFF, and
  // 16 library files are .aif). `null` means main refused it (PREVIEW_MAX_BYTES/SECONDS caps) —
  // that's "can't play", not an error: logged and dropped, never thrown.
  decodeFallback(
    sampleId: number,
  ): Promise<{ sampleRate: number; channels: Float32Array[] } | null>;
  // `play(sampleId)` only
  // ever has a sampleId, not a URL, so the `sample://s/<id>` template has to live SOMEWHERE. It
  // already lives once, in preload's `sampleUrl` (api.ts) — duplicating that template string in
  // here would be a second, independently-maintained copy of "what's this sample's URL" (the
  // one-question-one-gate rule). `sampleUrl` is added to deps instead; renderer.tsx wires
  // it straight to `api.sampleUrl`.
  sampleUrl(sampleId: number): string;
  // Optional so tests can inject a stub (no real WebAudio in the vitest `environment: 'node'` test
  // env); production never supplies it — `ensureCtx` lazily constructs a real `AudioContext` on
  // first play() instead.
  ctx?: BaseAudioContext;
}

// Typed `ctx?: BaseAudioContext` — but `BaseAudioContext` itself has no
// `resume`/`close` (those are `AudioContext`-only; verified against the installed
// typescript/lib.dom.d.ts). Rather than widening the deps type, `canResume`/`canClose` duck-type
// at the actual call sites: a real
// `AudioContext` always has both, so production is unaffected; a minimal test stub can supply
// either, neither, or both, and either way nothing throws.
function canResume(
  ctx: BaseAudioContext,
): ctx is BaseAudioContext & { resume: () => Promise<void> } {
  return typeof (ctx as { resume?: unknown }).resume === 'function';
}

function canClose(ctx: BaseAudioContext): ctx is BaseAudioContext & { close: () => Promise<void> } {
  return typeof (ctx as { close?: unknown }).close === 'function';
}

// ~10ms — long enough to kill the click a hard stop/retrigger would leave, short enough to read
// as instant. Exported so the test file pins its assertions against the same named constant
// instead of a repeated magic number (ipc.ts's PREVIEW_MAX_BYTES/SECONDS is the same idiom).
export const RETRIGGER_RAMP_SECONDS = 0.01;

// Keeps the last N=16 decoded AudioBuffers — simple Map + oldest-first eviction, not a
// real LRU (a cache hit never re-inserts/reorders). Exported for the same reason as the ramp
// constant above.
export const MAX_CACHED_BUFFERS = 16;

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

class PreviewPlayer implements PlayPort {
  private ctx: BaseAudioContext | null = null;
  private master: GainNode | null = null;
  private currentVoice: Voice | null = null;
  private volume = 1;

  // Bumped on every play() AND every stop() — the "latest request wins" gate. Each async decode
  // captures the generation value active when it was REQUESTED; when it resolves, a mismatch
  // against the CURRENT value means a later play() (or an explicit stop()) has since superseded
  // it, and it must not start a voice no matter how late it lands. This is what makes rapid
  // arrow-key walking correct: of any number of in-flight decodes, only the most recently
  // requested one is still allowed to actually sound.
  private generation = 0;

  private readonly bufferCache = new Map<number, AudioBuffer>();
  // Keyed by sampleId: a play() for an id already mid-decode reuses the SAME promise instead of
  // re-fetching (constraint: "a second play() of the SAME id while its first decode is still in
  // flight must not double-fetch").
  private readonly inFlightDecodes = new Map<number, Promise<AudioBuffer | null>>();

  constructor(private readonly deps: PreviewPlayerDeps) {}

  play(sampleId: number): void {
    const myGeneration = ++this.generation;
    const { ctx, master } = this.ensureCtx();
    void this.startVoice(sampleId, ctx, master, myGeneration);
  }

  stop(): void {
    // Any decode already in flight must not surface audio after an explicit stop, even if it
    // resolves later — same "latest request wins" gate play() uses, just with nothing newer
    // requested, so nothing is allowed to start at all.
    this.generation++;
    if (this.ctx === null || this.currentVoice === null) return;
    this.rampOutAndStop(this.currentVoice, this.ctx);
    this.currentVoice = null;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master !== null) {
      this.master.gain.value = v;
    }
  }

  dispose(): void {
    if (this.ctx !== null && canClose(this.ctx)) {
      void this.ctx.close();
    }
    this.ctx = null;
    this.master = null;
    this.currentVoice = null;
    this.bufferCache.clear();
    this.inFlightDecodes.clear();
  }

  /** Lazily creates the AudioContext + persistent master GainNode on first play() — never at
   * construction, so building a PreviewPlayer (e.g. at app startup) touches no WebAudio object
   * until something actually needs to sound. Also resumes a suspended context on every call: a
   * fresh AudioContext (or one Chromium's autoplay policy parked) reports 'suspended' until a
   * user-gesture-driven resume — play() is always gesture-triggered (click/arrow/space), so this
   * is the standard "unlock audio on first real interaction" idiom. */
  private ensureCtx(): { ctx: BaseAudioContext; master: GainNode } {
    let ctx = this.ctx;
    let master = this.master;
    if (ctx === null || master === null) {
      ctx = this.deps.ctx ?? new AudioContext();
      master = ctx.createGain();
      master.gain.value = this.volume;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
    }
    if (ctx.state === 'suspended' && canResume(ctx)) {
      void ctx.resume();
    }
    return { ctx, master };
  }

  private async startVoice(
    sampleId: number,
    ctx: BaseAudioContext,
    master: GainNode,
    myGeneration: number,
  ): Promise<void> {
    let buffer: AudioBuffer | null;
    try {
      buffer = await this.resolveBuffer(sampleId, ctx);
    } catch (err) {
      // Genuinely unexpected (fetchBytes network failure, decodeFallback itself throwing rather
      // than resolving null, ...) — the "refused" path below has its own, more specific log;
      // this is the backstop that keeps play() from ever producing an unhandled rejection.
      console.error(`previewPlayer: sample ${sampleId} could not be prepared for playback`, err);
      return;
    }
    if (buffer === null) return; // decode + fallback both declined; already logged below.
    if (myGeneration !== this.generation) return; // superseded — a later request is now current.
    this.swapVoice(buffer, ctx, master);
  }

  /** Cache hit -> resolved immediately. Otherwise reuses an in-flight decode for the same id, or
   * starts a fresh one (recorded in `inFlightDecodes` for the duration so a concurrent play() of
   * the same id dedupes onto it). The SAME promise is both stored and returned — no separate
   * `.finally()`-derived promise floats around unobserved, which would otherwise show up as a
   * second, spurious unhandled-rejection source alongside the one the caller already awaits. */
  private resolveBuffer(sampleId: number, ctx: BaseAudioContext): Promise<AudioBuffer | null> {
    const cached = this.bufferCache.get(sampleId);
    if (cached !== undefined) return Promise.resolve(cached);

    const inFlight = this.inFlightDecodes.get(sampleId);
    if (inFlight !== undefined) return inFlight;

    const promise = this.decodeAndCache(sampleId, ctx).finally(() => {
      this.inFlightDecodes.delete(sampleId);
    });
    this.inFlightDecodes.set(sampleId, promise);
    return promise;
  }

  private async decodeAndCache(
    sampleId: number,
    ctx: BaseAudioContext,
  ): Promise<AudioBuffer | null> {
    const bytes = await this.deps.fetchBytes(this.deps.sampleUrl(sampleId));
    let buffer: AudioBuffer;
    try {
      // decodeAudioData detaches/transfers its input ArrayBuffer — hand it a byte-for-byte copy
      // (`slice(0)`) so the original (returned from fetchBytes, and never referenced again here,
      // but not ours alone to corrupt) stays intact.
      buffer = await ctx.decodeAudioData(bytes.slice(0));
    } catch {
      // The single PCM-over-IPC exception: Chromium can't decode AIFF (16 library files are .aif) — this is
      // the ONE retry, not a generic "try again" loop.
      const fallback = await this.deps.decodeFallback(sampleId);
      if (fallback === null) {
        console.error(
          `previewPlayer: sample ${sampleId} — wav decode failed and the PCM fallback declined (over PREVIEW_MAX_BYTES/SECONDS, or genuinely undecodable); giving up`,
        );
        return null;
      }
      // Not an error — the AIFF path working exactly as designed — but greppable evidence that it
      // fired at all, both for manual testing (check the devtools console that the fallback
      // fired) and for future field debugging of "why did this one sample sound off".
      console.info(`previewPlayer: sample ${sampleId} — wav decode failed, used the PCM fallback`);
      buffer = this.bufferFromPcm(ctx, fallback);
    }
    this.cacheBuffer(sampleId, buffer);
    return buffer;
  }

  private bufferFromPcm(
    ctx: BaseAudioContext,
    pcm: { sampleRate: number; channels: Float32Array[] },
  ): AudioBuffer {
    const length = pcm.channels[0]?.length ?? 0;
    const buffer = ctx.createBuffer(pcm.channels.length, length, pcm.sampleRate);
    pcm.channels.forEach((channelData, i) => {
      // `channels: Float32Array[]` (ipcTypes.ts) types bare, which TS's typed-array generics
      // (5.7+) widen to `Float32Array<ArrayBufferLike>` — DOM's `copyToChannel` wants the
      // narrower `Float32Array<ArrayBuffer>` (it rules out a SharedArrayBuffer-backed source).
      // Reconstructing via the array-like constructor overload always allocates a fresh, plain
      // ArrayBuffer-backed instance, which satisfies that and copies the data at the same time.
      buffer.copyToChannel(new Float32Array(channelData), i);
    });
    return buffer;
  }

  private cacheBuffer(sampleId: number, buffer: AudioBuffer): void {
    this.bufferCache.set(sampleId, buffer);
    if (this.bufferCache.size > MAX_CACHED_BUFFERS) {
      const oldest = this.bufferCache.keys().next().value;
      if (oldest !== undefined) {
        this.bufferCache.delete(oldest);
      }
    }
  }

  /** Starts the new voice at full gain immediately, THEN ramps the prior voice (if any) out —
   * order doesn't affect actual audio timing (everything below is scheduled via explicit
   * ctx.currentTime-relative AudioParam/start/stop times, not JS call order), but reads as "bring
   * in the new one, then put away the old one". */
  private swapVoice(buffer: AudioBuffer, ctx: BaseAudioContext, master: GainNode): void {
    const prior = this.currentVoice;

    const gain = ctx.createGain();
    gain.gain.value = 1; // new voice starts at full gain immediately — never ramped in.
    gain.connect(master);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start(0);

    this.currentVoice = { source, gain };

    if (prior !== null) {
      this.rampOutAndStop(prior, ctx);
    }
  }

  /** The shared "kill this voice without a click" primitive retrigger and stop() both use: ramp
   * ITS gain (never the master) to 0 over RETRIGGER_RAMP_SECONDS, then stop its source at the
   * same scheduled time. `setValueAtTime` anchors the ramp's start at the voice's current gain —
   * the standard click-free-stop idiom (MDN) — rather than assuming it's still 1 (stop() could
   * run mid-ramp if called twice in quick succession). */
  private rampOutAndStop(voice: Voice, ctx: BaseAudioContext): void {
    const stopAt = ctx.currentTime + RETRIGGER_RAMP_SECONDS;
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, ctx.currentTime);
    voice.gain.gain.linearRampToValueAtTime(0, stopAt);
    voice.source.stop(stopAt);
  }
}

export function createPreviewPlayer(deps: PreviewPlayerDeps): PlayPort & { dispose(): void } {
  return new PreviewPlayer(deps);
}
