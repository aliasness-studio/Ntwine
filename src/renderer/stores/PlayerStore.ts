// PlayerStore (Task 12): selection + preview-playback INTENT, decoupled from how audio actually
// plays. Real playback is Task 14's `previewPlayer.ts`, injected here as a `PlayPort` — this
// store never touches WebAudio, `window`, or `api` directly (design constraint: store classes
// take only their dependency's typed shape as a constructor argument — see stores/api.ts's own
// doc comment for why `window` never appears in a store file).
import { makeAutoObservable } from 'mobx';
import './configure';

/**
 * The playback seam Task 14 implements (`createPreviewPlayer(...)` returns a `PlayPort &
 * { dispose(): void }`). Kept minimal on purpose: PlayerStore only needs to start a sample, stop
 * whatever's sounding, and set the master volume — everything else (per-voice gain-ramp
 * retrigger, the AIFF PCM decode fallback, buffer caching) is Task 14's concern and invisible
 * here.
 */
export interface PlayPort {
  play(sampleId: number): void;
  stop(): void;
  setVolume(v: number): void;
}

export interface SelectOptions {
  autoplay: boolean;
}

/**
 * `selectedId`/`volume` are the only state. Every action that lands on a new "current" sample
 * (`select` with autoplay on, `moveSelection`, `replay`) calls straight through to
 * `playPort.play` — there is no queued/pending playback state to reconcile, matching spec §3.1
 * item 4 ("click a row -> it plays immediately... Arrow keys move selection and auto-play on
 * landing"). `playPort.stop()` is part of the injected contract but this store never calls it
 * itself: every action that changes "current" immediately plays the new landing, and Task 14's
 * per-voice gain-ramp retrigger is what silences whatever was sounding before — there's no
 * "select nothing, silence everything" interaction in the v1 design for PlayerStore to drive.
 */
export class PlayerStore {
  selectedId: number | null = null;
  volume = 1;

  // Plain (not `private`) field, assigned in the constructor body — see LibraryStore.ts's `api`
  // field for why: a `makeAutoObservable` overrides-typing limitation (empirically confirmed)
  // means neither a parameter-property NOR a `private`-marked manual field is visible to `keyof
  // this` there, so `{ playPort: false }` below needs a plain `readonly` field to typecheck.
  readonly playPort: PlayPort;

  constructor(playPort: PlayPort) {
    this.playPort = playPort;
    // `playPort` is an injected dependency, not reactive app state — excluded from MobX's
    // observable graph (the documented pattern for constructor-injected collaborators) rather
    // than left to the default auto-inference, which would otherwise wrap it as a deep
    // observable for no benefit.
    makeAutoObservable(this, { playPort: false });
  }

  /**
   * Defaults to `{ autoplay: true }` — spec §3.1 item 4's "click a row -> it plays immediately"
   * is the common case (Task 13's row `onClick` calls `select(id)` with no second argument);
   * `{ autoplay: false }` exists for selection that shouldn't sound anything (e.g. restoring a
   * prior selection on mount).
   */
  select(id: number, opts: SelectOptions = { autoplay: true }): void {
    this.selectedId = id;
    if (opts.autoplay) {
      this.playPort.play(id);
    }
  }

  /**
   * Clamps at the edges of `visibleIds` — no wrap (repeatedly pressing the arrow key at either
   * end keeps landing on, and replaying, the boundary item rather than jumping to the other
   * end). `visibleIds` is taken fresh on every call (Task 13 passes the virtualizer's current
   * visible-row id list) rather than cached on the store, so filtering/scrolling between calls
   * is always respected. If the current selection isn't in `visibleIds` at all (filtered out,
   * or nothing selected yet), it's treated as position -1, so the first step in EITHER direction
   * lands on the first visible id. Every call that has somewhere to land calls `play` — even
   * when the clamp keeps the index unchanged — matching "arrow keys auto-play on landing": each
   * call is one landing.
   */
  moveSelection(delta: 1 | -1, visibleIds: number[]): void {
    if (visibleIds.length === 0) return;
    const currentIndex = this.selectedId === null ? -1 : visibleIds.indexOf(this.selectedId);
    const nextIndex = Math.min(Math.max(currentIndex + delta, 0), visibleIds.length - 1);
    const nextId = visibleIds[nextIndex];
    this.selectedId = nextId;
    this.playPort.play(nextId);
  }

  /** No-op when nothing is selected — Space is safe to bind unconditionally in the UI. */
  replay(): void {
    if (this.selectedId === null) return;
    this.playPort.play(this.selectedId);
  }

  setVolume(v: number): void {
    this.volume = v;
    this.playPort.setVolume(v);
  }
}
