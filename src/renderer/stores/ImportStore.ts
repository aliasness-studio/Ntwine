// ImportStore (Task 12): drives the one-shot import pipeline (`api.runImport`) and mirrors its
// progress as observables — the phase/done/total the UI (Task 13's FirstRun screen) reads live,
// not a promise it has to poll.
import { makeAutoObservable } from 'mobx';
import './configure';
import type { ImportProgress, NtwineApi } from '../../shared/ipcTypes';

export class ImportStore {
  phase: ImportProgress['phase'] | null = null;
  done = 0;
  total = 0;
  message: string | undefined = undefined;

  // Not `private` — same `makeAutoObservable`-overrides limitation as `api` below applies to
  // every excluded field, not just injected dependencies.
  unsubscribe: (() => void) | null = null;

  // Plain (not `private`) field, assigned in the constructor body — see LibraryStore.ts's `api`
  // field for why: a `makeAutoObservable` overrides-typing limitation (empirically confirmed)
  // means neither a parameter-property NOR a `private`-marked manual field is visible to `keyof
  // this` there, so `{ api: false }` below needs a plain `readonly` field to typecheck.
  readonly api: NtwineApi;

  constructor(api: NtwineApi) {
    this.api = api;
    // `api` is an injected dependency, not reactive app state (same reasoning as LibraryStore);
    // `unsubscribe` is internal subscription bookkeeping no UI ever reads — both excluded from
    // the observable graph.
    makeAutoObservable(this, { api: false, unsubscribe: false });
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
   */
  async run(): Promise<void> {
    this.unsubscribe = this.api.onImportProgress((p) => this.onProgress(p));
    try {
      await this.api.runImport();
    } catch {
      // Defensive, not just belt-and-suspenders for the documented contract above: even if a
      // future/alternate runImport rejected WITHOUT a prior terminal progress event, the
      // subscription still must not leak.
      this.endSubscription();
    }
  }

  private onProgress(p: ImportProgress): void {
    this.phase = p.phase;
    this.done = p.done;
    this.total = p.total;
    this.message = p.message;
    if (p.phase === 'done' || p.phase === 'error') {
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
