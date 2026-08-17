// Ambient typing for the preload bridge (Task 11): `preload.ts` calls
// `contextBridge.exposeInMainWorld('ntwine', api)`, which puts `api` on `window.ntwine` at
// runtime with no compile-time link back to its own source file — this augmentation is that
// link, so every renderer file (Tasks 12-15) gets `window.ntwine` fully typed for free, without
// an explicit import. Picked up automatically by `tsc --noEmit` (tsconfig.json has no
// include/exclude narrowing it away).
import type { NtwineApi } from '../shared/ipcTypes';

declare global {
  interface Window {
    ntwine: NtwineApi;
  }
}
