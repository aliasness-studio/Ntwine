// THE only module in src/renderer/stores that touches `window` (a design constraint). Every
// store class takes `NtwineApi` as a constructor argument instead of importing
// this file directly — real app code (renderer.tsx) wires `api` in here; tests
// construct stores with hand-rolled fakes and never import this module at all. That split is
// what lets the store test suite run under plain Node (no `window`/`document` — the Vitest
// config's `environment: 'node'`, matching how the whole app's tests run under
// `ELECTRON_RUN_AS_NODE=1`): merely importing this file evaluates `window.ntwine` at module load
// time, which throws outside a real renderer.
//
// `window.ntwine`'s type comes from src/renderer/global.d.ts's ambient `declare global`
// augmentation (picked up automatically by tsc — see that file's own comment) — no import needed
// for the type to apply here.
import type { NtwineApi } from '../../shared/ipcTypes';

export const api: NtwineApi = window.ntwine;
