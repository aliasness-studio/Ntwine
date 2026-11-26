// ImportStore: drives the one-shot import pipeline (`api.runImport`) and mirrors its
// progress as observables — the phase/done/total the UI (the FirstRun screen) reads live,
// not a promise it has to poll.
import { makeAutoObservable } from 'mobx';
import './configure';
import type { ImportProgress, NtwineApi } from '../../shared/ipcTypes';

export class ImportStore {
  phase: ImportProgress['phase'] | null = null;
  done = 0;
  total = 0;
  message: string | undefined = undefined;

  // The single source of truth for "is an import in progress". Previously FirstRun/SettingsSheet each hand-derived this from `phase`
  // (`phase !== null && phase !== 'done' && phase !== 'error'`), duplicated verbatim in both
  // files AND racy: `phase` only updates once the first `onImportProgress` event round-trips
  // from main, so a fast double-click landing before that first event ever arrives saw `phase`
  // still `null` in BOTH call sites, and neither guard engaged. `running` closes that gap by
  // being a dedicated flag `run()` itself flips synchronously, before any await — see `run()`'s
  // own doc comment for the full contract.
  running = false;

  // Not `private` — same `makeAutoObservable`-overrides limitation as `api` below applies to
  // every excluded field, not just injected dependencies.
  unsubscribe: (() => void) | null = null;

  // The currently in-flight `run()` call's promise, or null when nothing is in flight — internal
  // re-entrancy bookkeeping, not reactive UI state (nothing reads a Promise reactively), so it's
  // excluded from the observable graph exactly like `unsubscribe`. Cleared once `api.runImport()`
  // itself settles (covers done), which is BEFORE `running` flips back to false (that happens
  // later, on the 'done'/'error' terminal progress event) — so a re-entrant `run()` call arriving
  // during that in-between window (the background waveform phase) finds `running` true but
  // `inFlightRun` already null, and falls back to resolving immediately: there is no real promise
  // left to return at that point, and nothing more for THAT call to legitimately wait for.
  //
  // Not `private` — same `makeAutoObservable`-overrides limitation as `api` below (see the
  // note on that field, empirically confirmed again here): a `private`-marked manual field isn't
  // visible to `keyof this` in the overrides map's generic position.
  inFlightRun: Promise<void> | null = null;

  // Plain (not `private`) field, assigned in the constructor body — see LibraryStore.ts's `api`
  // field for why: a `makeAutoObservable` overrides-typing limitation (empirically confirmed)
  // means neither a parameter-property NOR a `private`-marked manual field is visible to `keyof
  // this` there, so `{ api: false }` below needs a plain `readonly` field to typecheck.
  readonly api: NtwineApi;

  constructor(api: NtwineApi) {
    this.api = api;
    // `api` is an injected dependency, not reactive app state (same reasoning as LibraryStore);
    // `unsubscribe`/`inFlightRun` are internal bookkeeping no UI ever reads — all three excluded
    // from the observable graph. `running` is deliberately NOT excluded — it's the one piece of
    // this bookkeeping the UI DOES read (FirstRun/SettingsSheet's button `disabled` state).
    makeAutoObservable(this, { api: false, unsubscribe: false, inFlightRun: false });
  }

  /** True once the background waveform pass has announced its terminal event. */
  get waveformsDone(): boolean {
    return this.phase === 'done';
  }

  /**
   * Subscribes to `onImportProgress` BEFORE calling `runImport` — main can start emitting
   * progress (the 'snapshot' phase) synchronously as part of the call, and a subscribe-after
   * ordering would silently drop that first event. `api.runImport()`'s own contract is to
   * resolve once catalog+stat+covers are done; this method's returned promise resolves at that
   * SAME point — it does not wait for the background waveform pass. Later 'waveforms'/'done'
   * events keep arriving through the `phase`/`done`/`total` observables after `run()` has
   * already returned.
   *
   * A rejected `runImport()` is caught, never rethrown: `runImport`'s own contract
   * (src/main/importer/importer.ts) is to emit one terminal `{ phase: 'error' }` progress event
   * before rejecting, so the failure is already visible on `phase`/`message` by the time the
   * catch runs — re-throwing here would just turn every `void importStore.run()` call site into
   * a second, redundant failure path (and a real unhandled-rejection risk for any caller that
   * doesn't await it, the same failure class ipc.ts's `runWaveformsInBackground` goes out of its
   * way to avoid on the main-process side of this same pipeline).
   *
   * Re-entrant: `running` flips true synchronously here, before any
   * `await` — deliberately not derived from `phase`, which only updates asynchronously once main
   * round-trips the first progress event, the exact gap a fast double-click fell through. A
   * second call while `running` is already true returns the SAME promise the first call is still
   * waiting on (`inFlightRun`) rather than starting a second `runImport()`/subscription — "the
   * same promise", not just "no-op and resolve immediately", because a caller chaining `.then()`
   * off the return value (FirstRun's `handleImport` does exactly this) must not have that
   * continuation fire early, before the real import has done anything.
   */
  run(): Promise<void> {
    if (this.running) return this.inFlightRun ?? Promise.resolve();
    this.running = true;
    this.inFlightRun = this.runOnce();
    return this.inFlightRun;
  }

  private async runOnce(): Promise<void> {
    this.unsubscribe = this.api.onImportProgress((p) => this.onProgress(p));
    try {
      await this.api.runImport();
    } catch {
      // Defensive, not just belt-and-suspenders for the documented contract above: even if a
      // future/alternate runImport rejected WITHOUT a prior terminal progress event, the
      // subscription still must not leak.
      //
      // `running = false` HERE too (a regression the re-entrancy fix once introduced):
      // `onProgress`'s terminal-phase branch is the ONLY other place `running` resets, and it
      // never runs when runImport rejects without ever emitting a progress event — so `running`
      // stayed `true` forever, and `run()`'s own guard then silently no-op'd every future call,
      // bricking the import flow until an app restart. Deliberately in `catch`, not `finally`: a
      // SUCCESSFUL settle must leave `running` true through the background waveform phase —
      // `finally` runs on that path too, and resetting there would reopen the double-click race
      // the re-entrancy guard fixed, just relocated to right after `runImport()` resolves.
      this.running = false;
      this.endSubscription();
    } finally {
      this.inFlightRun = null;
    }
  }

  private onProgress(p: ImportProgress): void {
    this.phase = p.phase;
    this.done = p.done;
    this.total = p.total;
    this.message = p.message;
    if (p.phase === 'done' || p.phase === 'error') {
      this.running = false;
      this.endSubscription();
    }
  }

  // Idempotent — safe to call from both `onProgress`'s terminal-phase branch and `run()`'s catch
  // block for the same failure (the second call is a no-op once `unsubscribe` is null).
  private endSubscription(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
