import type { E2ESnapshot } from '../shared/e2eTypes';
import type { PlayPort } from './stores/PlayerStore';

export interface PlayCounters { playCount: number; lastPlayedId: number | null; stopCount: number }

/**
 * E2E mode (armed by preload when main passed --ntwine-e2e): count plays BEFORE delegating, so a
 * replay served from previewPlayer's buffer cache — no fetch, no protocol seam — is still
 * observable. Explicit delegation, not a spread: createPreviewPlayer returns a class instance.
 * Unarmed returns the base port itself — the production object graph is unchanged.
 */
export function wrapPlayPort(base: PlayPort, armed: boolean): { port: PlayPort; counters: () => PlayCounters } {
  let playCount = 0;
  let lastPlayedId: number | null = null;
  let stopCount = 0;
  const counters = (): PlayCounters => ({ playCount, lastPlayedId, stopCount });
  if (!armed) return { port: base, counters };
  const port: PlayPort = {
    play: (id) => { playCount++; lastPlayedId = id; base.play(id); },
    // Counted for the same reason plays are: a stop leaves no trace in the DOM or the store, so
    // this counter is the only evidence an e2e spec can assert on.
    stop: () => { stopCount++; base.stop(); },
    setVolume: (v) => base.setVolume(v),
  };
  return { port, counters };
}

/**
 * Attaches `__ntwineE2E` synchronously when armed; touches nothing when not.
 *
 * `target`'s property is typed `unknown`, not `() => E2ESnapshot`: under `strictFunctionTypes`,
 * a property typed as a function is checked contravariantly, and the unit test above (verbatim
 * per the e2e spec) passes bare `{ __ntwineE2E?: unknown }` / `{ __ntwineE2E?: () => unknown }`
 * test doubles that a stricter target type rejects at the call site even though the assignment
 * itself is always sound (any concrete reader is assignable into an `unknown` slot). The real
 * call site (`renderer.tsx`, `installE2ESnapshot(window, ...)`) is unaffected — `Window`'s own
 * `__ntwineE2E?: () => E2ESnapshot` (global.d.ts) is still assignable to `unknown`.
 */
export function installE2ESnapshot(target: { __ntwineE2E?: unknown }, armed: boolean, read: () => E2ESnapshot): void {
  if (!armed) return;
  target.__ntwineE2E = read;
}
