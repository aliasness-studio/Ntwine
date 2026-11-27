// UpdateStore: mirrors main's self-update state machine
// (src/main/updater.ts) into the renderer as observables. Every non-idle state is a notice with
// two surfaces at the top of the window: the banner (`banner`) while it is not dismissed, and the
// compact top-bar button (`reminder`) once it is. Two actions hang off them: restart-to-install
// when `ready`, and open the releases page when a signature mismatch left the update `failed`.
// Main owns every decision; this store only reflects it and remembers whether the user dismissed
// the current notice.
import { makeAutoObservable, runInAction } from 'mobx';
import './configure';
import type { NtwineApi, UpdateState } from '../../shared/ipcTypes';

/** The states there is something to say about: everything but `idle`. */
export type NoticeState = Exclude<UpdateState, { kind: 'idle' }>;

export class UpdateStore {
  state: UpdateState = { kind: 'idle' };
  dismissed = false;
  version: string | null = null;

  // Plain (not `private`) field, assigned in the constructor body — see LibraryStore.ts's `api`
  // field for why: a `makeAutoObservable` overrides-typing limitation (empirically confirmed)
  // means neither a parameter-property NOR a `private`-marked manual field is visible to `keyof
  // this` there, so `{ api: false }` below needs a plain `readonly` field to typecheck.
  readonly api: NtwineApi;

  constructor(api: NtwineApi) {
    this.api = api;
    // `api` is an injected dependency, not reactive app state (same reasoning as LibraryStore).
    makeAutoObservable(this, { api: false });
  }

  /** The banner's state: any non-idle state, unless the user dismissed it. */
  get banner(): NoticeState | null {
    return this.dismissed ? null : noticeOf(this.state);
  }

  /** The top-bar button's state: the same notice once the banner is dismissed, so it never shows
   * alongside the banner and never while idle. */
  get reminder(): NoticeState | null {
    return this.dismissed ? noticeOf(this.state) : null;
  }

  /**
   * Subscribes to `onUpdateState` BEFORE fetching the current state, so a transition broadcast
   * while `getUpdateState` is in flight can't be lost. Latest wins: once any broadcast has landed,
   * the fetched snapshot (taken no later than that broadcast's transition) is discarded rather
   * than allowed to overwrite it. The subscription lives as long as the store — one per app
   * window, never torn down, so no unsubscribe is kept.
   *
   * Fire-and-forget at its call site (renderer.tsx); IPC failures reject through, same posture
   * as `userLayer.init()`.
   */
  async init(): Promise<void> {
    let broadcastSeen = false;
    this.api.onUpdateState((s) => {
      broadcastSeen = true;
      this.applyState(s);
    });
    const [version, state] = await Promise.all([
      this.api.getAppVersion(),
      this.api.getUpdateState(),
    ]);
    runInAction(() => {
      this.version = version;
      if (!broadcastSeen) this.applyState(state);
    });
  }

  dismiss(): void {
    this.dismissed = true;
  }

  /** Undoes `dismiss()`: the banner comes back and the top-bar button goes. */
  reopen(): void {
    this.dismissed = false;
  }

  /** Restart-to-install; a no-op unless an update is `ready`. */
  async install(): Promise<void> {
    if (this.state.kind !== 'ready') return;
    await this.api.installUpdate();
  }

  /** Opens the releases page (main-fixed URL); a no-op unless the update `failed`. */
  async openReleases(): Promise<void> {
    if (this.state.kind !== 'failed') return;
    await this.api.openReleasesPage();
  }

  // A transition to a DIFFERENT non-idle state (download finished, a newer `ready` version, or
  // `failed`) re-shows a dismissed banner — it's news the user hasn't seen. A value-equal repeat
  // does not (main already de-dups per transition; this just makes the store not depend on that),
  // and `idle` never does (there's nothing to show). Note `idle` -> the previously dismissed state
  // again counts as different from `idle`, so it re-shows.
  private applyState(next: UpdateState): void {
    if (next.kind !== 'idle' && !sameState(this.state, next)) this.dismissed = false;
    this.state = next;
  }
}

function noticeOf(state: UpdateState): NoticeState | null {
  return state.kind === 'idle' ? null : state;
}

function sameState(a: UpdateState, b: UpdateState): boolean {
  switch (a.kind) {
    case 'idle':
      return b.kind === 'idle';
    case 'downloading':
      return b.kind === 'downloading';
    case 'ready':
      return b.kind === 'ready' && a.version === b.version;
    case 'failed':
      return b.kind === 'failed' && a.downloadUrl === b.downloadUrl;
  }
}
