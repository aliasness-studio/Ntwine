// PlayerStore: selection + preview-playback INTENT, decoupled from how audio actually
// plays. Real playback is `previewPlayer.ts`, injected here as a `PlayPort` — this
// store never touches WebAudio, `window`, or `api` directly (design constraint: store classes
// take only their dependency's typed shape as a constructor argument — see stores/api.ts's own
// doc comment for why `window` never appears in a store file).
import { makeAutoObservable } from 'mobx';
import './configure';

/**
 * The playback seam `previewPlayer.ts` implements (`createPreviewPlayer(...)` returns a `PlayPort &
 * { dispose(): void }`). Kept minimal on purpose: PlayerStore only needs to start a sample, stop
 * whatever's sounding, and set the master volume — everything else (per-voice gain-ramp
 * retrigger, the AIFF PCM decode fallback, buffer caching) is previewPlayer's concern and invisible
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
 * `selectedId`/`volume`/`autoplay` are the only state. Every action that LANDS on a new "current"
 * sample (`select`, `moveSelection`) plays it — no queued/pending playback state to reconcile —
 * matching the browse model ("click a row -> it plays immediately... Arrow keys move selection and
 * auto-play on landing"), unless the `autoplay` preference is off.
 *
 * Both additions here (2026-08-23, transport dock) close gaps v1 left open on purpose, which live
 * use turned out to care about:
 *
 * - `playPort.stop()` was part of the injected contract with NO caller. Every action that changed
 *   "current" immediately played the new landing, and previewPlayer's per-voice gain-ramp retrigger is
 *   what silenced the previous voice — so a 30-second sample triggered by accident could only be
 *   RESTARTED, never stopped. `stop()` drives it directly now.
 * - `autoplay` makes the landing sound optional. Browsing a filtered list with the arrow keys
 *   previously sounded every row it touched; with the preference off you can walk the list in
 *   silence and still audition on demand, because `replay()` ignores it.
 */
export class PlayerStore {
  selectedId: number | null = null;
  volume = 1;
  /** Standing preference, not per-call: see `select`'s two-gate comment. Session-only by design —
   * see `toggleAutoplay`. */
  autoplay = true;

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
   * Defaults to `{ autoplay: true }` — "click a row -> it plays immediately"
   * is the common case (the row `onClick` calls `select(id)` with no second argument);
   * `{ autoplay: false }` exists for selection that shouldn't sound anything (e.g. restoring a
   * prior selection on mount).
   */
  select(id: number, opts: SelectOptions = { autoplay: true }): void {
    this.selectedId = id;
    // Two independent gates, and either one saying no is enough. `opts.autoplay` describes the
    // CALL ("is this the kind of landing that would normally sound?" — false when restoring a
    // prior selection on mount); `this.autoplay` is the user's standing preference. Neither
    // overrides the other, so the pre-existing per-call opt-out keeps working untouched.
    if (opts.autoplay && this.autoplay) {
      this.playPort.play(id);
    }
  }

  /**
   * Clamps at the edges of `visibleIds` — no wrap (repeatedly pressing the arrow key at either
   * end keeps landing on, and replaying, the boundary item rather than jumping to the other
   * end). `visibleIds` is taken fresh on every call (SampleList passes the virtualizer's current
   * visible-row id list) rather than cached on the store, so filtering/scrolling between calls
   * is always respected. If the current selection isn't in `visibleIds` at all (filtered out,
   * or nothing selected yet), it's treated as position -1, so the first step in EITHER direction
   * lands on the first visible id. Every call that has somewhere to land counts as one landing —
   * even when the clamp keeps the index unchanged — and so plays, matching "arrow keys auto-play
   * on landing", for as long as the `autoplay` preference is on. With it off the walk still moves
   * the selection; it just makes no sound.
   */
  moveSelection(delta: 1 | -1, visibleIds: number[]): void {
    if (visibleIds.length === 0) return;
    const currentIndex = this.selectedId === null ? -1 : visibleIds.indexOf(this.selectedId);
    const nextIndex = Math.min(Math.max(currentIndex + delta, 0), visibleIds.length - 1);
    const nextId = visibleIds[nextIndex];
    this.selectedId = nextId;
    if (this.autoplay) {
      this.playPort.play(nextId);
    }
  }

  /**
   * Selection-follow's terminal case: the write that just ran emptied the
   * current scope entirely, so there's no "next row" for `landingIdAfterRemoval` (keymap.ts) to
   * land on. Still deliberately doesn't call `playPort.stop()`, even now that `stop()` exists:
   * losing the selection because a filter emptied out is not a request to silence anything, and
   * a sample mid-audition should not cut out because its row stopped matching. Stopping is a
   * gesture the user makes; this is a bookkeeping consequence of one they already made.
   */
  clearSelection(): void {
    this.selectedId = null;
  }

  /** No-op when nothing is selected — Space is safe to bind unconditionally in the UI. */
  replay(): void {
    if (this.selectedId === null) return;
    this.playPort.play(this.selectedId);
  }

  /**
   * Unconditional, and safe with nothing playing — previewPlayer's own `stop()` no-ops when there
   * is no current voice. That is what lets the UI keep the button permanently enabled, which is
   * the point: it's a panic button for a long sample triggered by accident, and knowing whether
   * audio is ACTUALLY sounding would need an ended-signal the player doesn't raise today. A Stop
   * that greys itself out at the wrong moment is worse than one that occasionally does nothing.
   *
   * Leaves `selectedId` alone, so ArrowLeft/Space still replay whatever was just stopped.
   */
  stop(): void {
    this.playPort.stop();
  }

  /**
   * Session-only, and deliberately not persisted through `meta`: this is a control you flip
   * mid-audition, so putting an IPC round trip behind it would be the wrong trade. It resets to
   * on at launch, which keeps v1's behaviour the default for anyone who never touches it.
   */
  toggleAutoplay(): void {
    this.autoplay = !this.autoplay;
  }

  setVolume(v: number): void {
    this.volume = v;
    this.playPort.setVolume(v);
  }
}
