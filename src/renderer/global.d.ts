// Ambient typing for the preload bridge: `preload.ts` calls
// `contextBridge.exposeInMainWorld('ntwine', api)`, which puts `api` on `window.ntwine` at
// runtime with no compile-time link back to its own source file — this augmentation is that
// link, so every renderer file gets `window.ntwine` fully typed for free, without
// an explicit import. Picked up automatically by `tsc --noEmit` (tsconfig.json has no
// include/exclude narrowing it away).
import type { E2ESnapshot } from '../shared/e2eTypes';
import type { NtwineApi } from '../shared/ipcTypes';

declare global {
  interface Window {
    ntwine: NtwineApi;
    // E2E mode: both attached by preload.ts / renderer.tsx only when
    // armed (`--ntwine-e2e` on process.argv) — `ntwineE2E` is preload's boolean flag,
    // `__ntwineE2E` is renderer.tsx's live snapshot reader a later Playwright suite calls through
    // `page.evaluate`. Absent (not merely undefined) in every unarmed run — v1 behaviour.
    ntwineE2E?: true;
    __ntwineE2E?: () => E2ESnapshot;
  }
}
